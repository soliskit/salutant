import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DurableObjectStore } from '../src/do-store.js';
import { makeDOStorage } from './helpers.js';

void test('DO SQL ArrayBuffer values fail JSON decoding before a value is returned', () => {
  const storage = makeDOStorage();
  const store = new DurableObjectStore(storage);
  const realExec = storage.sql.exec.bind(storage.sql);
  storage.sql.exec = (query, ...params) =>
    /^SELECT value FROM/.test(query)
      ? { toArray: () => [{ value: new ArrayBuffer(0) }] }
      : realExec(query, ...params);
  assert.throws(() => store.get('bad'), SyntaxError);
});

void test('DO invalid restore iterables fail only after transaction replacement setup [R14 local]', () => {
  for (const [snapshot, expected] of [
    ['null', []],
    ['{}', []],
    ['[null]', []],
    ['[1]', []],
    ['[["first",1],null]', ['first']]
  ]) {
    const store = new DurableObjectStore(makeDOStorage());
    store.set('old', 1);
    store.transact((s) => {
      s.set('new-before-restore', 2);
      assert.throws(() => {
        s.restoreFrom(snapshot);
      }, TypeError);
      assert.deepEqual(s.keysWithPrefix(''), expected);
    });
    assert.deepEqual(store.keysWithPrefix(''), expected);
  }
});

void test('DO restore retains original two-item string destructuring and empty string root', () => {
  const store = new DurableObjectStore(makeDOStorage());
  store.restoreFrom(JSON.stringify(['ab', '😀z']));
  assert.equal(store.get('a'), 'b');
  assert.equal(store.get('😀'), 'z');
  store.restoreFrom(JSON.stringify(''));
  assert.deepEqual(store.keysWithPrefix(''), []);
});

void test('DO transaction prefix lookup fails at a non-string key without rejecting its insertion', () => {
  const store = new DurableObjectStore(makeDOStorage());
  store.transact((s) => {
    s.set(7, 'kept-until-rollback');
    assert.equal(s.get(7), 'kept-until-rollback');
    assert.throws(() => s.keysWithPrefix(''), TypeError);
    s.delete(7);
  });
});

void test('DO a missing cache entry from the public cache seam still fails at member use', () => {
  const store = new DurableObjectStore(makeDOStorage());
  assert.throws(() => {
    store.transact((s) => {
      s.tx.set('k', undefined);
      s.get('k');
    });
  }, TypeError);
});
