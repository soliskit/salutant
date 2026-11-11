// Security headers (R9). Every response the
// service generates goes through respond() so success, error, redirect,
// 404 and callback responses all carry the full set. These are set in
// code because a static header file does not cover generated responses.

const CSP_BASE = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'"
];

// options:
//   connectOrigin - the one exact app origin the code page may call
//   formAction    - CSP form-action value ("'none'" by default)
//   cache         - "no-store" (sign-in and proof responses) or
//                   { publicSeconds: n } for the key endpoint
/**
 * @param {{ connectOrigin?: string | null, formAction?: string,
 *   cache?: 'no-store' | { publicSeconds: number } }} [options]
 */
export function securityHeaders(options = {}) {
  const {
    connectOrigin = null,
    formAction = "'none'",
    cache = 'no-store'
  } = options;
  const csp = [...CSP_BASE];
  csp.push(
    connectOrigin ? `connect-src 'self' ${connectOrigin}` : "connect-src 'self'"
  );
  csp.push(`form-action ${formAction}`);
  const h = new Headers({
    'content-security-policy': csp.join('; '),
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'strict-transport-security': 'max-age=31536000',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'cross-origin-opener-policy': 'same-origin'
  });
  if (cache === 'no-store') h.set('cache-control', 'no-store');
  else h.set('cache-control', `public, max-age=${String(cache.publicSeconds)}`);
  return h;
}

/**
 * @param {number | undefined} status
 * @param {string | Record<string, unknown> | null | undefined} body
 * @param {Parameters<typeof securityHeaders>[0]} [options]
 */
export function respond(status, body, options = {}) {
  const headers = securityHeaders(options);
  /** @type {string | null | undefined} */
  let payload;
  if (typeof body === 'object' && body !== null) {
    payload = JSON.stringify(body);
    headers.set('content-type', 'application/json; charset=utf-8');
  } else payload = body;
  return new Response(payload, { status, headers });
}
