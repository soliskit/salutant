// Parity between MemoryStore (local test twin) and DurableObjectStore
// (production binding over the Durable Object sync SQLite API). Both
// stores implement the one interface the service uses
// (transact/get/getRef/set/delete/keysWithPrefix/snapshot/restoreFrom),
// and the service code must run unchanged against either. The shim
// below is a real SQLite database (node:sqlite) behind the two Durable
// Object storage methods the store calls (transactionSync, sql.exec),
// so the SQL paths - including LIKE escaping - are exercised for real.
//
// Scope note: this proves interface parity over a SQLite engine, not
// Durable Object behavior under traffic; that remains the cloud-phase
// proof. Rollback-on-throw is a Durable Object guarantee MemoryStore
// does not model, so it is tested as DO-specific, not as parity.

import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/storage.js';
import { DurableObjectStore } from '../src/do-store.js';
import { makeDOStorage } from './helpers.js';

function makeStores() {
  return [
    ['MemoryStore', new MemoryStore()],
    ['DurableObjectStore', new DurableObjectStore(makeDOStorage())]
  ];
}

test('parity: set/get/delete/keysWithPrefix across the interface', async () => {
  for (const [name, store] of makeStores()) {
    assert.equal(store.get('missing'), undefined, name);
    store.set('code:1', { code: '123456', attempts: 0 });
    store.set('code:2', { code: '654321', attempts: 0 });
    store.set('budget:owner', { used: 1 });
    assert.deepEqual(
      store.get('code:1'),
      { code: '123456', attempts: 0 },
      name
    );
    assert.deepEqual(
      store.keysWithPrefix('code:').sort(),
      ['code:1', 'code:2'],
      name
    );
    assert.deepEqual(store.keysWithPrefix('nope:'), [], name);
    store.delete('code:1');
    assert.equal(store.get('code:1'), undefined, name);
    store.delete('code:1'); // deleting a missing key is a no-op
    assert.deepEqual(store.keysWithPrefix('code:'), ['code:2'], name);
  }
});

test('parity: get returns a copy; getRef inside transact mutates the stored value', async () => {
  for (const [name, store] of makeStores()) {
    store.set('k', { n: 1, nested: { ok: true } });
    store.get('k').n = 999;
    assert.equal(store.get('k').n, 1, name);

    // The service pattern: read the raw reference inside a transaction
    // and mutate it; the change is visible after commit.
    store.transact((s) => {
      s.getRef('k').n = 2;
    });
    assert.equal(store.get('k').n, 2, name);

    // getRef on a missing key stays undefined inside a transaction.
    store.transact((s) => {
      assert.equal(s.getRef('absent'), undefined, name);
      s.set('made-in-tx', 1);
    });
    assert.equal(store.get('made-in-tx'), 1, name);
  }
});

test('parity: transact flushes get/set/delete changes on commit', async () => {
  for (const [name, store] of makeStores()) {
    store.set('a', 1);
    store.set('b', 2);
    const seen = store.transact((s) => {
      s.set('a', 10);
      s.delete('b');
      s.set('c', 3);
      // Reads inside the same transaction see the working copy.
      return [s.get('a'), s.get('b'), s.get('c')];
    });
    assert.deepEqual(seen, [10, undefined, 3], name);
    assert.equal(store.get('a'), 10, name);
    assert.equal(store.get('b'), undefined, name);
    assert.equal(store.get('c'), 3, name);
  }
});

test('parity: keysWithPrefix treats % and _ in keys as literal characters', async () => {
  for (const [name, store] of makeStores()) {
    store.set('rate:100%', 1);
    store.set('rate:100_x', 2);
    store.set('rate:1000', 3);
    assert.deepEqual(store.keysWithPrefix('rate:100%'), ['rate:100%'], name);
    assert.deepEqual(
      store.keysWithPrefix('rate:100').sort(),
      ['rate:100%', 'rate:1000', 'rate:100_x'],
      name
    );
  }
});

test('parity: snapshot and restore use one shared format in both directions', async () => {
  const data = { 'code:1': { code: '123456' }, 'budget:owner': { used: 3 } };
  for (const [aName, a] of makeStores()) {
    for (const [bName, b] of makeStores()) {
      for (const [k, v] of Object.entries(data)) a.set(k, v);
      b.restoreFrom(a.snapshot());
      assert.deepEqual(b.get('code:1'), data['code:1'], `${aName} -> ${bName}`);
      assert.deepEqual(
        b.get('budget:owner'),
        data['budget:owner'],
        `${aName} -> ${bName}`
      );
      assert.deepEqual(
        JSON.parse(b.snapshot()).sort(),
        JSON.parse(a.snapshot()).sort(),
        `${aName} -> ${bName}`
      );
    }
  }
});

test('DurableObjectStore: state survives a new store instance over the same storage', () => {
  const storage = makeDOStorage();
  const first = new DurableObjectStore(storage);
  first.transact(
    (s) => s.getRef('k') === undefined && s.set('k', { kept: true })
  );
  first.set('k', { kept: true });
  const second = new DurableObjectStore(storage);
  assert.deepEqual(second.get('k'), { kept: true });
  assert.deepEqual(second.keysWithPrefix('k'), ['k']);
});

test('DurableObjectStore: a throwing transaction rolls back (DO guarantee)', () => {
  const store = new DurableObjectStore(makeDOStorage());
  store.set('a', 1);
  assert.throws(
    () =>
      store.transact((s) => {
        s.set('a', 2);
        throw new Error('boom');
      }),
    /boom/
  );
  assert.equal(store.get('a'), 1);
});

test('DurableObjectStore: restoreFrom is atomic - a mid-restore failure leaves prior contents', () => {
  const storage = makeDOStorage();
  const store = new DurableObjectStore(storage);
  store.set('old', 1);
  const snap = JSON.stringify([
    ['a', 1],
    ['b', 2],
    ['c', 3]
  ]);
  let inserts = 0;
  const realExec = storage.sql.exec;
  storage.sql.exec = (query, ...params) => {
    if (/^\s*insert/i.test(query) && ++inserts === 2)
      throw new Error('crash mid-restore');
    return realExec(query, ...params);
  };
  assert.throws(() => store.restoreFrom(snap), /crash mid-restore/);
  assert.equal(store.get('old'), 1);
  assert.equal(store.get('a'), undefined);
  assert.deepEqual(store.keysWithPrefix(''), ['old']);
});

test('DurableObjectStore: restoreFrom inside a transaction commits with it', () => {
  const store = new DurableObjectStore(makeDOStorage());
  store.set('x', 9);
  store.set('y', 8);
  store.transact((s) => {
    s.restoreFrom(JSON.stringify([['only', { v: 1 }]]));
  });
  assert.deepEqual(store.keysWithPrefix(''), ['only']);
  assert.deepEqual(store.get('only'), { v: 1 });
});

test('parity: snapshot inside a transaction sees the working copy', async () => {
  for (const [name, store] of makeStores()) {
    store.set('a', 1);
    store.set('b', 2);
    const snap = store.transact((s) => {
      s.set('a', 10);
      s.delete('b');
      s.set('c', 3);
      return s.snapshot();
    });
    const entries = JSON.parse(snap).sort(([x], [y]) => (x < y ? -1 : 1));
    assert.deepEqual(
      entries,
      [
        ['a', 10],
        ['c', 3]
      ],
      name
    );
    // ...and restore accepts what snapshot produced, on both drivers.
    store.restoreFrom(snap);
    assert.equal(store.get('a'), 10, name);
    assert.equal(store.get('b'), undefined, name);
    assert.equal(store.get('c'), 3, name);
  }
});

test('parity: restore inside a transaction replaces wholesale, including transaction-created keys', async () => {
  for (const [name, store] of makeStores()) {
    store.set('db-key', 1);
    const snap = JSON.stringify([['restored', true]]);
    store.transact((s) => {
      s.set('tx-created', 2); // not in the snapshot
      s.restoreFrom(snap);
    });
    assert.deepEqual(store.keysWithPrefix('').sort(), ['restored'], name);
    assert.equal(store.get('tx-created'), undefined, name);
    assert.equal(store.get('db-key'), undefined, name);
    assert.equal(store.get('restored'), true, name);
  }
});

test('parity: keysWithPrefix inside a transaction merges the working copy', async () => {
  for (const [name, store] of makeStores()) {
    store.set('code:keep', 1);
    store.set('code:drop', 2);
    store.set('budget:owner', 3);
    const seen = store.transact((s) => {
      s.set('code:new', 4); // created in the transaction, matches the prefix
      s.delete('code:drop'); // deleted in the transaction, was stored
      s.set('budget:spent', 5); // touched in the transaction, other prefix
      return s.keysWithPrefix('code:').sort();
    });
    assert.deepEqual(seen, ['code:keep', 'code:new'], name);
    assert.deepEqual(
      store.keysWithPrefix('code:').sort(),
      ['code:keep', 'code:new'],
      name
    );
    assert.deepEqual(
      store.keysWithPrefix('budget:').sort(),
      ['budget:owner', 'budget:spent'],
      name
    );
    assert.equal(store.get('code:drop'), undefined, name);
  }
});
