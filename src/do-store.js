// Durable Object storage binding. Implements the full MemoryStore
// interface (transact/get/getRef/set/delete/keysWithPrefix/snapshot/
// restoreFrom) over the Durable Object synchronous SQLite API, so the
// service code runs unchanged in production (requirements: Atomicity -
// one SQLite-backed Durable Object). MemoryStore keeps modelling the
// same interface for local tests; this class is its production twin.
//
// Atomicity model (same rule as MemoryStore): every state change runs
// inside one synchronous transaction; nothing awaits inside it. Reads
// through getRef return the transaction's working copy, and the copy is
// written back when the transaction commits - matching MemoryStore's
// shared-reference semantics for in-transaction mutation.
//
// This does not prove anything about real Durable Object behavior under
// traffic; that remains the cloud-phase proof.

const TABLE = 'records';

/** @typedef {ArrayBuffer | string | number | null} SqlValue */
/**
 * @typedef {object} DurableStorageLike
 * @property {<T>(fn: () => T) => T} transactionSync
 * @property {{ exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, SqlValue>[] } }} sql
 */

export class DurableObjectStore {
  // storage: a Durable Object storage handle (ctx.storage) exposing
  // transactionSync(fn) and sql.exec(query, ...params). Injectable so
  // tests can supply an in-memory SQLite-shaped shim.
  /** @param {DurableStorageLike} storage */
  constructor(storage) {
    this.storage = storage;
    /** @type {Map<unknown, { value: unknown, dirty: boolean }> | null} */
    this.tx = null; // active transaction cache: Map key -> { value, dirty }
    this._ensureTable();
  }

  _ensureTable() {
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
    );
  }

  // Synchronous single-step state change. `fn` must not await.
  /**
   * @template T
   * @param {(store: DurableObjectStore) => T} fn
   * @returns {T}
   */
  transact(fn) {
    return this.storage.transactionSync(() => {
      this.tx = new Map();
      try {
        const result = fn(this);
        for (const [key, entry] of this.tx) {
          if (!entry.dirty) continue;
          if (entry.value === undefined) {
            this.storage.sql.exec(`DELETE FROM ${TABLE} WHERE key = ?`, key);
          } else {
            this.storage.sql.exec(
              `INSERT OR REPLACE INTO ${TABLE} (key, value) VALUES (?, ?)`,
              key,
              JSON.stringify(entry.value)
            );
          }
        }
        return result;
      } finally {
        this.tx = null;
      }
    });
  }

  /**
   * @param {unknown} key
   * @param {boolean} [markDirty]
   */
  _load(key, markDirty = false) {
    if (this.tx && this.tx.has(key)) {
      const cached = this.tx.get(key);
      if (cached === undefined) throw new TypeError('cached entry is missing');
      if (markDirty && cached.value !== undefined) cached.dirty = true;
      return cached.value;
    }
    const rows = this.storage.sql
      .exec(`SELECT value FROM ${TABLE} WHERE key = ?`, key)
      .toArray();
    const value =
      rows.length === 0 ? undefined : parseStoredValue(rows[0].value);
    if (this.tx)
      this.tx.set(key, { value, dirty: markDirty && value !== undefined });
    return value;
  }

  /** @param {unknown} key */
  get(key) {
    const v = this._load(key);
    return v === undefined ? undefined : structuredClone(v);
  }

  // Read the raw reference inside a transaction only; mutations are
  // flushed when the transaction commits.
  /** @param {unknown} key */
  getRef(key) {
    return this._load(key, true);
  }

  /**
   * @param {unknown} key
   * @param {unknown} value
   */
  set(key, value) {
    if (this.tx) {
      this.tx.set(key, { value, dirty: true });
    } else {
      this.storage.sql.exec(
        `INSERT OR REPLACE INTO ${TABLE} (key, value) VALUES (?, ?)`,
        key,
        JSON.stringify(value)
      );
    }
  }

  /** @param {unknown} key */
  delete(key) {
    if (this.tx) {
      this.tx.set(key, { value: undefined, dirty: true });
    } else {
      this.storage.sql.exec(`DELETE FROM ${TABLE} WHERE key = ?`, key);
    }
  }

  /** @param {string} prefix */
  keysWithPrefix(prefix) {
    const pattern = prefix.replace(/[%_\\]/g, (c) => `\\${c}`) + '%';
    /** @type {Set<unknown>} */
    const out = new Set(
      this.storage.sql
        .exec(`SELECT key FROM ${TABLE} WHERE key LIKE ? ESCAPE '\\'`, pattern)
        .toArray()
        .map((r) => r.key)
    );
    if (this.tx) {
      for (const [key, entry] of this.tx) {
        if (typeof key !== 'string')
          throw new TypeError('store key is not a string');
        if (!key.startsWith(prefix)) continue;
        if (entry.value === undefined) out.delete(key);
        else out.add(key);
      }
    }
    return [...out];
  }

  // Point-in-time snapshot and restore, for the restore rehearsal (R14).
  // Same format as MemoryStore: JSON of [[key, value], ...]. The epoch is
  // never in here, because the epoch lives outside restored data.
  // Inside a transaction the snapshot sees the working copy, exactly like
  // MemoryStore over its live map: uncommitted changes are included.
  snapshot() {
    const rows = this.storage.sql
      .exec(`SELECT key, value FROM ${TABLE}`)
      .toArray();
    /** @type {Map<unknown, unknown>} */
    const merged = new Map(
      rows.map(
        /** @returns {[unknown, unknown]} */ (r) => [
          r.key,
          parseStoredValue(r.value)
        ]
      )
    );
    if (this.tx) {
      for (const [key, entry] of this.tx) {
        if (entry.value === undefined) merged.delete(key);
        else merged.set(key, entry.value);
      }
    }
    return JSON.stringify([...merged]);
  }

  /** @param {string} snapshot */
  restoreFrom(snapshot) {
    const entries = restoreEntries(snapshot);
    if (this.tx) {
      // Inside a transaction the replace goes through the working copy,
      // so it commits or rolls back with everything else. The working
      // copy is dropped first: a restore replaces the WHOLE contents,
      // so a key created earlier in this same transaction is gone too,
      // exactly like MemoryStore replacing its map.
      this.tx = new Map();
      for (const row of this.storage.sql
        .exec(`SELECT key FROM ${TABLE}`)
        .toArray()) {
        this.tx.set(row.key, { value: undefined, dirty: true });
      }
      for (const [key, value] of entries)
        this.tx.set(key, { value, dirty: true });
      return;
    }
    // Outside one, the whole replace is a single transaction: a crash
    // midway never leaves a partially restored table.
    this.storage.transactionSync(() => {
      this.storage.sql.exec(`DELETE FROM ${TABLE}`);
      for (const [key, value] of entries) {
        this.storage.sql.exec(
          `INSERT INTO ${TABLE} (key, value) VALUES (?, ?)`,
          key,
          JSON.stringify(value)
        );
      }
    });
  }
}

// Durable Object wrapper. Wired for deployment: src/entry.js extends
// this class, and wrangler.jsonc binds it as SALUTANT_STORE with the v1
// migration enabling SQLite storage (new_sqlite_classes).
/** @template Env */
export class SalutantStoreDO {
  /** @type {DurableObjectStore} */
  store;
  /** @type {Env} */
  env;

  /**
   * @param {{ storage: DurableStorageLike }} ctx
   * @param {Env} env
   */
  constructor(ctx, env) {
    this.store = new DurableObjectStore(ctx.storage);
    this.env = env;
  }
}

/**
 * Driver SQL values are scalars or ArrayBuffers, not arbitrary objects.
 * Ordinary ArrayBuffer stringification is not JSON; scalar conversion matches
 * the original JSON.parse input conversion.
 * @param {SqlValue} value
 * @returns {unknown}
 */
function parseStoredValue(value) {
  if (value instanceof ArrayBuffer)
    throw new SyntaxError('stored ArrayBuffer is not JSON');
  /** @type {unknown} */
  const parsed = JSON.parse(String(value));
  return parsed;
}

/**
 * Parse eagerly, but inspect iterable shapes only as restoration consumes
 * them, after the existing replacement setup has run.
 * @param {string} snapshot
 * @returns {Iterable<[unknown, unknown]>}
 */
function restoreEntries(snapshot) {
  /** @type {unknown} */
  const parsed = JSON.parse(snapshot);
  return entries();

  /** @returns {Generator<[unknown, unknown]>} */
  function* entries() {
    if (typeof parsed !== 'string' && !Array.isArray(parsed))
      throw new TypeError('snapshot is not iterable');
    const rows = /** @type {string | unknown[]} */ (parsed);
    for (const row of rows) {
      if (typeof row !== 'string' && !Array.isArray(row))
        throw new TypeError('snapshot entry is not iterable');
      const [key, value] = /** @type {string | unknown[]} */ (row);
      yield [key, value];
    }
  }
}
