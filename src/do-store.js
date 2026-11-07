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

export class DurableObjectStore {
  // storage: a Durable Object storage handle (ctx.storage) exposing
  // transactionSync(fn) and sql.exec(query, ...params). Injectable so
  // tests can supply an in-memory SQLite-shaped shim.
  constructor(storage) {
    this.storage = storage;
    this.tx = null; // active transaction cache: Map key -> { value, dirty }
    this._ensureTable();
  }

  _ensureTable() {
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
    );
  }

  // Synchronous single-step state change. `fn` must not await.
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

  _load(key) {
    if (this.tx && this.tx.has(key)) return this.tx.get(key).value;
    const rows = this.storage.sql
      .exec(`SELECT value FROM ${TABLE} WHERE key = ?`, key)
      .toArray();
    const value = rows.length === 0 ? undefined : JSON.parse(rows[0].value);
    if (this.tx) this.tx.set(key, { value, dirty: false });
    return value;
  }

  get(key) {
    const v = this._load(key);
    return v === undefined ? undefined : structuredClone(v);
  }

  // Read the raw reference inside a transaction only; mutations are
  // flushed when the transaction commits.
  getRef(key) {
    const v = this._load(key);
    if (this.tx && v !== undefined) this.tx.get(key).dirty = true;
    return v;
  }

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

  delete(key) {
    if (this.tx) {
      this.tx.set(key, { value: undefined, dirty: true });
    } else {
      this.storage.sql.exec(`DELETE FROM ${TABLE} WHERE key = ?`, key);
    }
  }

  keysWithPrefix(prefix) {
    const pattern = prefix.replace(/[%_\\]/g, (c) => `\\${c}`) + '%';
    const out = new Set(
      this.storage.sql
        .exec(`SELECT key FROM ${TABLE} WHERE key LIKE ? ESCAPE '\\'`, pattern)
        .toArray()
        .map((r) => r.key)
    );
    if (this.tx) {
      for (const [key, entry] of this.tx) {
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
    const merged = new Map(rows.map((r) => [r.key, JSON.parse(r.value)]));
    if (this.tx) {
      for (const [key, entry] of this.tx) {
        if (entry.value === undefined) merged.delete(key);
        else merged.set(key, entry.value);
      }
    }
    return JSON.stringify([...merged]);
  }

  restoreFrom(snapshot) {
    const entries = JSON.parse(snapshot);
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
export class SalutantStoreDO {
  constructor(ctx, env) {
    this.store = new DurableObjectStore(ctx.storage);
    this.env = env;
  }
}
