// Worker-style entry: request routing and the page routes. Every
// response, including errors and 404s, goes through respond() so the
// full header set is always present (R9).

import { respond } from './headers.js';
import { PAGE_HTML, PAGE_JS, PAGE_CSS } from './assets.js';

export function createWorker(service) {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/') {
        return codeEntryPage(service, url);
      }
      if (request.method === 'GET' && url.pathname === '/app.js') {
        return staticAsset(PAGE_JS, 'text/javascript; charset=utf-8');
      }
      if (request.method === 'GET' && url.pathname === '/style.css') {
        return staticAsset(PAGE_CSS, 'text/css; charset=utf-8');
      }
      return service.fetch(request);
    },
  };
}

function staticAsset(text, contentType) {
  const r = respond(200, text);
  r.headers.set('content-type', contentType);
  return r;
}

// The page is only served for a registered app origin (exact match, no
// wildcards and no sibling origins). The CSP connect-src is limited to
// the service itself plus that one exact origin, because the page script
// calls the app's callback. form-action is 'none': the exchange happens
// in script, never by form post (callback protocol finding).
function codeEntryPage(service, url) {
  const appOrigin = url.searchParams.get('app') ?? '';
  const known = service.apps.some((a) => a.origin === appOrigin);
  const r = respond(known ? 200 : 400, PAGE_HTML, known ? { connectOrigin: appOrigin } : {});
  r.headers.set('content-type', 'text/html; charset=utf-8');
  return r;
}
