// Signing-key JWK boundary regressions. The generation path emitted
// "alg": "Ed25519", which Workers' WebCrypto importKey rejected;
// "EdDSA" is the RFC 8037 registered label for Ed25519 keys. Node's importKey accepts the wrong label, so a bare
// successful import would prove nothing here - these tests assert the
// JWK objects crossing the boundaries themselves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateSigningKeyPair, exportPublicJwk, exportSigningPrivateJwk, normalizeEd25519Jwk } from '../src/crypto.js';
import { importSigningKeys } from '../src/entry.js';

test('R2: exportSigningPrivateJwk emits the registered label and preserves the exported key fields', async () => {
  const { privateKey } = await generateSigningKeyPair();
  const raw = await crypto.subtle.exportKey('jwk', privateKey);
  const jwk = await exportSigningPrivateJwk(privateKey);
  assert.equal(jwk.alg, 'EdDSA');
  const { alg: _a, ...restOut } = jwk;
  const { alg: _b, ...restRaw } = raw;
  assert.deepEqual(restOut, restRaw);
});

// Generation-path wiring: the deploy workflow must route the private JWK
// through the normalizing export. Reads the workflow source as data;
// does not execute it.
test('R2: deploy workflow generates the private JWK via exportSigningPrivateJwk', () => {
  const wf = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(wf, /exportSigningPrivateJwk\(privateKey\)/);
  assert.doesNotMatch(wf, /exportKey\('jwk', privateKey\)/);
});

test('R1: normalizeEd25519Jwk rewrites the nonstandard label without mutating the input', () => {
  const input = { kty: 'OKP', crv: 'Ed25519', x: 'x', d: 'd', alg: 'Ed25519', key_ops: ['sign'], ext: true };
  const out = normalizeEd25519Jwk(input);
  assert.equal(out.alg, 'EdDSA');
  assert.equal(input.alg, 'Ed25519');
  const { alg: _a, ...restOut } = out;
  const { alg: _b, ...restIn } = input;
  assert.deepEqual(restOut, restIn);
});

test('R1: normalizeEd25519Jwk supplies the label when alg is absent', () => {
  const out = normalizeEd25519Jwk({ kty: 'OKP', crv: 'Ed25519', x: 'x' });
  assert.equal(out.alg, 'EdDSA');
});

test('R1: importSigningKeys passes only registered-label JWKs to importKey', async () => {
  const { privateKey, publicKey } = await generateSigningKeyPair();
  const rawPrivate = await crypto.subtle.exportKey('jwk', privateKey);
  // Force the boundary inputs - the nonstandard label and an absent
  // label - so a future Node export change cannot pass this vacuously.
  const badLabel = { ...rawPrivate, alg: 'Ed25519' };
  const absentLabel = { ...rawPrivate };
  delete absentLabel.alg;
  const publicJwk = await exportPublicJwk(publicKey, 'k1');
  const seen = [];
  const originalImportKey = crypto.subtle.importKey.bind(crypto.subtle);
  crypto.subtle.importKey = async (format, jwk, ...rest) => {
    seen.push(jwk);
    return originalImportKey(format, jwk, ...rest);
  };
  try {
    for (const privateJwk of [badLabel, absentLabel]) {
      await importSigningKeys(JSON.stringify({
        currentKid: 'k1',
        keys: [{ kid: 'k1', publicJwk, privateJwk, status: 'active', notAfterMs: Date.now() + 60_000 }],
      }));
    }
  } finally {
    crypto.subtle.importKey = originalImportKey;
  }
  assert.equal(seen.length, 4);
  for (const jwk of seen) assert.equal(jwk.alg, 'EdDSA');
});
