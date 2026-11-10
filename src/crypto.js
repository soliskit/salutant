// Cryptographic primitives for the mock service.
// Everything uses Web Crypto so the same code runs in Node.js (tests)
// and in Cloudflare Workers. No dependencies, no secrets in the repo:
// keys are generated per service instance in phase 1; in production the
// private signing key and the HMAC keys are service secrets (R12).

const subtle = globalThis.crypto.subtle;

/** @param {Uint8Array} bytes */
export function toBase64Url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** @param {string} text */
export function fromBase64Url(text) {
  const b64 = text.replaceAll('-', '+').replaceAll('_', '/');
  const s = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const te = new TextEncoder();

// Six-digit code from the platform's cryptographically secure random
// source (R2), with rejection sampling so every code is equally likely.
export function generateCode() {
  const limit = 4_294_000_000; // largest multiple of 1,000,000 below 2^32
  const buf = new Uint32Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    if (buf[0] < limit) return String(buf[0] % 1_000_000).padStart(6, '0');
  }
}

export function randomId(byteCount = 16) {
  const bytes = new Uint8Array(byteCount);
  globalThis.crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

// Constant-time comparison over equal-length byte strings (R2, E11).
/**
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 */
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** @param {BufferSource} keyBytes */
export async function importHmacKey(keyBytes) {
  return subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

/**
 * @param {CryptoKey} key
 * @param {string} message
 */
export async function hmacSha256(key, message) {
  return new Uint8Array(await subtle.sign('HMAC', key, te.encode(message)));
}

export async function generateSigningKeyPair() {
  return subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
}

/**
 * @param {CryptoKey} publicKey
 * @param {unknown} kid
 */
export async function exportPublicJwk(publicKey, kid) {
  const jwk = await subtle.exportKey('jwk', publicKey);
  return {
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    kid,
    alg: 'EdDSA',
    use: 'sig'
  };
}

// RFC 8037 registers "EdDSA" as the JWS alg value for Ed25519 keys;
// Node's JWK export labels them "Ed25519" instead, which Workers'
// importKey rejects. Normalize before import, and before a JWK leaves
// this process for the SIGNING_KEYS secret.
/** @param {JsonWebKey} jwk */
export function normalizeEd25519Jwk(jwk) {
  return { ...jwk, alg: 'EdDSA' };
}

// Private half of the signing pair as a JWK for the SIGNING_KEYS secret,
// with the label normalized as above.
/** @param {CryptoKey} privateKey */
export async function exportSigningPrivateJwk(privateKey) {
  return normalizeEd25519Jwk(await subtle.exportKey('jwk', privateKey));
}

// Compact JWS with one pinned algorithm (R4). No 'none', no RSA, no
// algorithm from the token itself is ever honored at verify time.
/**
 * @param {Record<string, unknown>} claims
 * @param {CryptoKey} privateKey
 * @param {unknown} kid
 */
export async function signProof(claims, privateKey, kid) {
  const header = toBase64Url(
    te.encode(JSON.stringify({ alg: 'EdDSA', kid, typ: 'JWT' }))
  );
  const payload = toBase64Url(te.encode(JSON.stringify(claims)));
  const data = te.encode(`${header}.${payload}`);
  const sig = new Uint8Array(
    await subtle.sign({ name: 'Ed25519' }, privateKey, data)
  );
  return `${header}.${payload}.${toBase64Url(sig)}`;
}

// A record view of parsed JSON for reading named members. null throws a
// TypeError, as reading a member of null did. A non-null primitive has no
// own members, so it maps to {} and every named read is undefined, as it
// was for a primitive (for ordinary, unmodified primitive prototypes).
// Objects and arrays are returned as they are; their members stay unknown.
/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
export function recordOf(value) {
  if (value === null) throw new TypeError('JSON value is null');
  if (typeof value !== 'object') return {};
  return /** @type {Record<string, unknown>} */ (value);
}

// Verifies structure and signature only. Claim checks (iss, aud, exp,
// nbf, epoch, nonce, jti) are the caller's job.
/**
 * @param {string} token
 * @param {CryptoKey} publicKey
 */
export async function verifyProofSignature(token, publicKey) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed proof');
  const [header, payload, signature] = parts;
  /** @type {unknown} */
  let headerValue;
  try {
    headerValue = JSON.parse(new TextDecoder().decode(fromBase64Url(header)));
  } catch {
    throw new Error('malformed proof header');
  }
  if (recordOf(headerValue).alg !== 'EdDSA')
    throw new Error('unexpected algorithm');
  const data = te.encode(`${header}.${payload}`);
  const ok = await subtle.verify(
    { name: 'Ed25519' },
    publicKey,
    fromBase64Url(signature),
    data
  );
  if (!ok) throw new Error('bad signature');
  /** @type {unknown} */
  let claims;
  try {
    claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
  } catch {
    throw new Error('malformed proof payload');
  }
  return { header: headerValue, claims };
}
