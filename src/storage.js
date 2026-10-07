// In-memory store modeling one SQLite-backed Durable Object for the
// local prototype (contract: Storage).
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
  constructor(snapshot) {
    this.records = new Map(snapshot ? JSON.parse(snapshot) : []);
  }

  // Synchronous single-step state change. `fn` must not await.
  transact(fn) {
    return fn(this);
  }

  get(key) {
    const v = this.records.get(key);
    return v === undefined ? undefined : structuredClone(v);
  }

  // Read the raw reference inside a transaction only. Callers outside a
  // transact() must use get() so they cannot mutate shared state.
  getRef(key) {
    return this.records.get(key);
  }

  set(key, value) {
    this.records.set(key, value);
  }

  delete(key) {
    this.records.delete(key);
  }

  keysWithPrefix(prefix) {
    const out = [];
    for (const k of this.records.keys()) if (k.startsWith(prefix)) out.push(k);
    return out;
  }

  // Point-in-time snapshot and restore, for the restore rehearsal (R14).
  // A restore replaces the whole contents with an earlier snapshot; the
  // epoch is never in here, because the epoch lives outside restored
  // data by design.
  snapshot() {
    return JSON.stringify([...this.records]);
  }

  restoreFrom(snapshot) {
    this.records = new Map(JSON.parse(snapshot));
  }
}
