// R5 and the page side of the sign-in flow: the page's own script is run
// against a small fake document and a fake fetch, so the requests it makes
// can be counted without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { PAGE_JS } from '../src/assets.js';

class FakeElement {
  constructor() {
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.value = '';
    this.handlers = {};
  }
  addEventListener(type, handler) {
    this.handlers[type] = handler;
  }
  fire(type) {
    return this.handlers[type]({ preventDefault() {} });
  }
}

function ok(body, status = 200) {
  return { ok: status < 400, status, json: () => Promise.resolve(body) };
}

function deferred() {
  let finish;
  const promise = new Promise((resolve) => {
    finish = resolve;
  });
  return { promise, resolve: finish };
}

function loadPage(respond) {
  const elements = {};
  for (const id of [
    'address-form',
    'code-form',
    'message',
    'resend',
    'address',
    'code'
  ]) {
    elements[id] = new FakeElement();
  }
  elements['code-form'].hidden = true;
  const calls = [];
  let keyCount = 0;
  const context = vm.createContext({
    document: { getElementById: (id) => elements[id] },
    location: { search: '?app=https%3A%2F%2Fapp.example.test&state=s' },
    crypto: { randomUUID: () => `key-${String(++keyCount)}` },
    URLSearchParams,
    encodeURIComponent,
    JSON,
    fetch: (url, init) => {
      calls.push({
        url,
        key: init.headers['idempotency-key'],
        body: JSON.parse(init.body)
      });
      return respond(url, calls.length);
    }
  });
  vm.runInContext(PAGE_JS, context);
  return { elements, calls };
}

async function reachCodeStage(page) {
  page.elements.address.value = 'owner@example.test';
  await page.elements['address-form'].fire('submit');
}

void test('the first send carries an idempotency key and a network failure retries with the same key', async () => {
  let attempt = 0;
  const page = loadPage(() => {
    attempt += 1;
    if (attempt === 1) return Promise.reject(new Error('network'));
    return Promise.resolve(ok({ challengeId: 'c1' }));
  });
  page.elements.address.value = 'owner@example.test';
  await page.elements['address-form'].fire('submit');
  assert.equal(page.elements['code-form'].hidden, true, 'still on stage one');
  await page.elements['address-form'].fire('submit');
  assert.equal(page.calls.length, 2);
  assert.ok(page.calls[0].key, 'the first request has a key');
  assert.equal(page.calls[1].key, page.calls[0].key, 'the retry reuses it');
  assert.equal(page.elements['code-form'].hidden, false);
});

void test('a changed address or any received response gets a new key', async () => {
  let attempt = 0;
  const page = loadPage(() => {
    attempt += 1;
    if (attempt === 1) return Promise.reject(new Error('network'));
    return Promise.resolve(
      ok({ challengeId: `c${attempt}` }, attempt === 2 ? 500 : 200)
    );
  });
  page.elements.address.value = 'owner@example.test';
  await page.elements['address-form'].fire('submit');
  page.elements.address.value = 'other@example.test';
  await page.elements['address-form'].fire('submit');
  assert.notEqual(page.calls[1].key, page.calls[0].key, 'new address');
  await page.elements['address-form'].fire('submit');
  assert.notEqual(
    page.calls[2].key,
    page.calls[1].key,
    'a received response, even an error, drops the key'
  );
});

void test('a resend names its challenge, has its own key and shows the wait message on a refusal', async () => {
  const page = loadPage((url, n) => {
    if (n === 1) return Promise.resolve(ok({ challengeId: 'c1' }));
    return Promise.resolve(
      n === 2 ? ok({ error: 'cooldown' }, 429) : ok({}, 200)
    );
  });
  await reachCodeStage(page);
  await page.elements.resend.fire('click');
  const first = page.calls[1];
  assert.equal(first.body.resendOf, 'c1');
  assert.equal(first.body.address, 'owner@example.test');
  assert.ok(first.key && first.key !== page.calls[0].key);
  assert.match(page.elements.message.textContent, /wait a little/);
  assert.equal(page.elements.resend.disabled, false, 'button is usable again');
  await page.elements.resend.fire('click');
  assert.notEqual(page.calls[2].key, first.key, 'a new request, a new key');
  assert.match(page.elements.message.textContent, /new code is on its way/);
});

void test('a double-click on Continue sends one verify and resend is blocked while it runs', async () => {
  const verify = deferred();
  const page = loadPage((url) =>
    url.includes('/verify') ? verify.promise : ok({ challengeId: 'c1' })
  );
  await reachCodeStage(page);
  page.elements.code.value = '123456';
  const first = page.elements['code-form'].fire('submit');
  const second = page.elements['code-form'].fire('submit');
  await second;
  await page.elements.resend.fire('click');
  const verifies = page.calls.filter((c) => c.url.includes('/verify'));
  assert.equal(verifies.length, 1, 'one verify request');
  assert.equal(page.calls.length, 2, 'no resend went out during the verify');
  assert.equal(page.elements.resend.disabled, true);
  verify.resolve(ok({ error: 'invalid_or_expired_code' }, 200));
  await first;
  assert.equal(page.elements.resend.disabled, false);
  assert.match(page.elements.message.textContent, /did not work/);
});
