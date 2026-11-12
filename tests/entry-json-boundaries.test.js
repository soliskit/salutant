// Local entry boundaries. The import tap returns real pre-generated keys,
// but does not prove native import accepts the deliberately malformed fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importSigningKeys, SalutantStoreDO } from '../src/entry.js';
import {
  generateSigningKeyPair,
  exportPublicJwk,
  exportSigningPrivateJwk,
  toBase64Url
} from '../src/crypto.js';
import { makeDOStorage, SERVICE_ORIGIN, OWNER } from './helpers.js';

async function importTap(run) {
  const pair = await generateSigningKeyPair();
  const ownImportKey = Object.getOwnPropertyDescriptor(
    crypto.subtle,
    'importKey'
  );
  const seen = [];
  crypto.subtle.importKey = async (
    format,
    jwk,
    algorithm,
    extractable,
    usages
  ) => {
    seen.push({ format, jwk, algorithm, extractable, usages });
    return usages[0] === 'verify' ? pair.publicKey : pair.privateKey;
  };
  try {
    await run(seen, pair);
  } finally {
    if (ownImportKey) {
      Object.defineProperty(crypto.subtle, 'importKey', ownImportKey);
    } else {
      Reflect.deleteProperty(crypto.subtle, 'importKey');
    }
  }
}

function registry(publicJwk = {}, privateJwk = {}, extra = {}) {
  return JSON.stringify({
    currentKid: 'current',
    keys: [{ kid: 'current', publicJwk, privateJwk, ...extra }]
  });
}

async function envFor(overrides = {}) {
  const pair = await generateSigningKeyPair();
  const bytes = () => toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  return {
    SIGNING_KEYS: registry(
      await exportPublicJwk(pair.publicKey, 'current'),
      await exportSigningPrivateJwk(pair.privateKey)
    ),
    EPOCH: JSON.stringify({ value: 1 }),
    ALLOWLIST: JSON.stringify([OWNER]),
    APPS: '[]',
    RESEND_API_KEY: 'local-not-real',
    MAIL_FROM: 'local@example.test',
    CODE_HMAC_KEY: bytes(),
    STATE_HMAC_KEY: bytes(),
    SERVICE_ORIGIN,
    ...overrides
  };
}

function objectFor(env) {
  const storage = makeDOStorage();
  return new SalutantStoreDO(
    {
      storage,
      // No platform failure policy is simulated by this construction shim.
      blockConcurrencyWhile: (fn) => fn()
    },
    env
  );
}

void test('entry retains unknown registry metadata and validates only the iterated JSON shape', async () => {
  await importTap(async (seen, pair) => {
    for (const keys of [[], '']) {
      const result = await importSigningKeys(
        JSON.stringify({ keys, currentKid: null })
      );
      assert.equal(result.currentKid, null);
      assert.equal(result.signingKeys.size, 0);
    }
    for (const keys of [null, false, 3, {}]) {
      await assert.rejects(
        importSigningKeys(JSON.stringify({ keys })),
        TypeError
      );
    }
    await assert.rejects(importSigningKeys('null'), TypeError);
    await assert.rejects(importSigningKeys('{}'), TypeError);
    await assert.rejects(importSigningKeys('{'), SyntaxError);
    await assert.rejects(importSigningKeys('{"keys":[null]}'), TypeError);
    const result = await importSigningKeys(
      registry(null, 4, {
        kid: 7,
        status: { raw: true },
        notAfterMs: 'later'
      })
    );
    const key = result.signingKeys.get(7);
    assert.ok(key);
    assert.equal(result.currentKid, 'current');
    assert.equal(key.publicKey, pair.publicKey);
    assert.equal(key.privateKey, pair.privateKey);
    assert.deepEqual(key.status, { raw: true });
    assert.equal(key.notAfterMs, 'later');
    assert.deepEqual(
      seen.map((call) => call.jwk),
      [{ alg: 'EdDSA' }, { alg: 'EdDSA' }]
    );
    await importSigningKeys('{"keys":"x"}');
    assert.equal(
      seen.length,
      4,
      'nonempty string retains its old character iteration'
    );
  });
});

void test('entry JWK conversion retains scalar DOMString and boolean semantics while normalizing the label', async () => {
  await importTap(async (seen) => {
    for (const scalar of ['text', 7, false, null]) {
      const strings = Object.fromEntries(
        [
          'crv',
          'd',
          'dp',
          'dq',
          'e',
          'k',
          'kty',
          'n',
          'p',
          'q',
          'qi',
          'use',
          'x',
          'y'
        ].map((name) => [name, scalar])
      );
      await importSigningKeys(
        registry({
          ...strings,
          ext: scalar,
          alg: { discarded: true },
          key_ops: [scalar],
          ignored: { untouched: true },
          oth: [{ d: scalar, r: scalar, t: scalar }, null, {}]
        })
      );
      const jwk = seen.at(-2).jwk;
      for (const name of Object.keys(strings))
        assert.equal(jwk[name], String(scalar));
      assert.equal(jwk.alg, 'EdDSA');
      assert.equal(jwk.ext, Boolean(scalar));
      assert.deepEqual(jwk.key_ops, [String(scalar)]);
      assert.deepEqual(jwk.oth, [
        { d: String(scalar), r: String(scalar), t: String(scalar) },
        {},
        {}
      ]);
      assert.equal('ignored' in jwk, false);
    }
  });
});

void test('entry rejects object or array JWK string members at conversion, before either import call', async () => {
  await importTap(async (seen) => {
    for (const member of [{}, []]) {
      for (const publicJwk of [
        { kty: member },
        { key_ops: [member] },
        { oth: [{ d: member }] }
      ]) {
        await assert.rejects(
          importSigningKeys(registry(publicJwk)),
          /JSON scalar/
        );
        assert.equal(seen.length, 0);
      }
    }
  });
});

void test('entry JWK sequence and nested dictionary boundaries use JSON arrays, not strings or scalar records', async () => {
  await importTap(async (seen) => {
    for (const value of [null, 'verify', 2, false, {}]) {
      for (const field of ['key_ops', 'oth']) {
        await assert.rejects(
          importSigningKeys(registry({ [field]: value })),
          /JSON sequence/
        );
        assert.equal(seen.length, 0);
      }
    }
    for (const row of [false, 2, 'row']) {
      await assert.rejects(
        importSigningKeys(registry({ oth: [row] })),
        /dictionary/
      );
      assert.equal(seen.length, 0);
    }
    await importSigningKeys(
      registry({ key_ops: [], oth: [[], null, { d: 'd' }] })
    );
    assert.deepEqual(seen[0].jwk.oth, [{}, {}, { d: 'd' }]);
  });
});

void test('entry allowlist keeps null, string and array behavior and checks invalid iteration only inside service construction', async () => {
  for (const [value, expected] of [
    [null, []],
    ['ab', ['a', 'b']],
    [[OWNER], [OWNER]]
  ]) {
    const object = objectFor(
      await envFor({ ALLOWLIST: JSON.stringify(value) })
    );
    const service = await object.service();
    assert.deepEqual([...service.allowlist], expected);
  }
  for (const value of [false, 3, {}]) {
    const object = objectFor(
      await envFor({ ALLOWLIST: JSON.stringify(value) })
    );
    await assert.rejects(object.service(), /JSON value is not iterable/);
    const competing = objectFor(
      await envFor({ ALLOWLIST: JSON.stringify(value), APPS: '{' })
    );
    await assert.rejects(
      competing.service(),
      SyntaxError,
      'APPS argument parses before Set consumes allowlist'
    );
  }
});

void test('entry epoch read evaluates now but always returns a promise, retaining unknown values and rejected null reads', async () => {
  for (const epoch of [{ value: { raw: true } }, {}, [], 7, 'text', false]) {
    const object = objectFor(await envFor({ EPOCH: JSON.stringify(epoch) }));
    const service = await object.service();
    const result = service.epochSource.read();
    assert.ok(result instanceof Promise);
    assert.deepEqual(await result, epoch?.value);
  }
  const probeEnv = await envFor({ EPOCH: '{"epochProbe":true}' });
  const originalParse = JSON.parse;
  const thrown = { sentinel: 'uncoerced rejection' };
  const order = [];
  const epochProbe = {
    get value() {
      order.push('read');
      throw thrown;
    }
  };
  let rejected;
  try {
    JSON.parse = (text, ...rest) =>
      text === probeEnv.EPOCH ? epochProbe : originalParse(text, ...rest);
    const probeService = await objectFor(probeEnv).service();
    assert.doesNotThrow(() => {
      rejected = probeService.epochSource.read();
    });
    order.push('returned');
  } finally {
    JSON.parse = originalParse;
  }
  assert.deepEqual(order, ['read', 'returned']);
  assert.ok(rejected instanceof Promise);
  await assert.rejects(rejected, (reason) => reason === thrown);
  const object = objectFor(await envFor({ EPOCH: 'null' }));
  const service = await object.service();
  let result;
  assert.doesNotThrow(() => {
    result = service.epochSource.read();
  });
  assert.ok(result instanceof Promise);
  await assert.rejects(result, TypeError);
  const response = await service.fetch(
    new Request(`${SERVICE_ORIGIN}/.well-known/jwks.json`)
  );
  assert.equal(response.status, 500, 'unreadable epoch remains closed');
});
