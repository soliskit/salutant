// Code generation (R2): a random draw exactly at the rejection limit is
// redrawn, and the next valid draw produces the code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateCode } from '../src/crypto.js';

void test('a draw exactly at the rejection limit is rejected; the next valid draw yields the code', () => {
  const original = Object.getOwnPropertyDescriptor(
    globalThis.crypto,
    'getRandomValues'
  );
  // 4_294_000_000 is the exact rejection limit (largest multiple of 10^6 below
  // 2^32): the original redraws it; mutants that accept it yield '000000'.
  const draws = [4_294_000_000, 1];
  let calls = 0;
  globalThis.crypto.getRandomValues = (buf) => {
    if (calls >= draws.length) throw new Error('unexpected extra draw'); // fail closed
    if (!(buf instanceof Uint32Array)) {
      throw new TypeError('code-generation mock expects Uint32Array');
    }
    buf[0] = draws[calls];
    calls += 1;
    return buf;
  };
  try {
    assert.equal(generateCode(), '000001');
    assert.equal(calls, 2);
  } finally {
    if (original) {
      Object.defineProperty(globalThis.crypto, 'getRandomValues', original);
    } else {
      Reflect.deleteProperty(globalThis.crypto, 'getRandomValues');
    }
  }
});
