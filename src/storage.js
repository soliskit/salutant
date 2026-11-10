// In-memory store modeling one SQLite-backed Durable Object for the
// local prototype (one object, synchronous changes).
//
// Atomicity model: every state change is a synchronous function run to
// completion (a "transaction"). JavaScript runs synchronous code without
// interleaving, so a check, update and consume with no await between
// them is atomic here - the same rule the Durable Object synchronous
// transaction API provides. Nothing is assumed serialized across an
// await, and the service code must never await inside a transaction.
//
// This does not prove anything about real Durable Object behavior under
// traffic; that is a cloud-phase finding.

export class MemoryStore {
  /** @param {string} [snapshot] */
  constructor(snapshot) {
    /** @type {Map<unknown, unknown>} */
    this.records = snapshot ? parseSnapshot(snapshot) : new Map();
  }

  // Synchronous single-step state change. `fn` must not await.
  /**
   * @template T
   * @param {(store: MemoryStore) => T} fn
   * @returns {T}
   */
  transact(fn) {
    return fn(this);
  }

  /** @param {unknown} key */
  get(key) {
    const v = this.records.get(key);
    return v === undefined ? undefined : structuredClone(v);
  }

  // Read the raw reference inside a transaction only. Callers outside a
  // transact() must use get() so they cannot mutate shared state.
  /** @param {unknown} key */
  getRef(key) {
    return this.records.get(key);
  }

  /**
   * @param {unknown} key
   * @param {unknown} value
   */
  set(key, value) {
    this.records.set(key, value);
  }

  /** @param {unknown} key */
  delete(key) {
    this.records.delete(key);
  }

  /** @param {string} prefix */
  keysWithPrefix(prefix) {
    const out = [];
    for (const k of this.records.keys()) {
      if (typeof k !== 'string')
        throw new TypeError('store key is not a string');
      if (k.startsWith(prefix)) out.push(k);
    }
    return out;
  }

  // Point-in-time snapshot and restore, for the restore rehearsal (R14).
  // A restore replaces the whole contents with an earlier snapshot; the
  // epoch is never in here, because the epoch lives outside restored
  // data by design.
  snapshot() {
    return JSON.stringify([...this.records]);
  }

  /** @param {string} snapshot */
  restoreFrom(snapshot) {
    this.records = parseSnapshot(snapshot);
  }
}

/**
 * Decode the JSON input accepted by the Map constructor without asserting
 * that restored keys or values have any application-specific shape.
 * @param {string} snapshot
 * @returns {Map<unknown, unknown>}
 */
function parseSnapshot(snapshot) {
  /** @type {unknown} */
  const parsed = JSON.parse(snapshot);
  /** @type {Map<unknown, unknown>} */
  const records = new Map();
  if (parsed === null || parsed === '') return records;
  if (!Array.isArray(parsed)) throw new TypeError('snapshot is not iterable');
  for (const item of parsed) {
    /** @type {unknown} */
    const entry = item;
    if (typeof entry !== 'object' || entry === null)
      throw new TypeError('snapshot entry is not an object');
    const pair = /** @type {Record<string, unknown>} */ (entry);
    records.set(pair[0], pair[1]);
  }
  return records;
}
