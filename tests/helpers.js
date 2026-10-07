// Shared test harness. Builds a world: mock service + stub app with
// injected fakes and a controllable clock. Example addresses and origins
// only; nothing real is referenced.
import { MemoryStore } from '../src/storage.js';
import { SalutantService } from '../src/service.js';
import { MockMailAdapter } from '../src/mail-mock.js';
import { StubApp } from '../src/stub-app.js';
import { createWorker } from '../src/worker.js';
import { generateSigningKeyPair } from '../src/crypto.js';

export const SERVICE_ORIGIN = 'https://salutant.example.test';
export const APP_ORIGIN = 'https://app.example.test';
export const OWNER = 'owner@example.test';
export const STRANGER = 'stranger@example.test';
export const ATTACKER = 'attacker@example.test';

export class ControllableEpoch {
  constructor(value = 1) { this.value = value; this.available = true; }
  async read() {
    if (!this.available) throw new Error('epoch source unavailable');
    return this.value;
  }
}

export async function makeWorld({
  now = 1_759_600_000_000, // fixed start so windows are deterministic
  allowlist = [OWNER],
  mailerBehavior = 'accepted',
  config = {},
  appConfig = {},
} = {}) {
  let clockNow = now;
  const clock = () => clockNow;
  const store = new MemoryStore();
  const appStore = new MemoryStore();
  const mailer = new MockMailAdapter({ behavior: mailerBehavior });
  const epoch = new ControllableEpoch(1);
  const keyPair = await generateSigningKeyPair();
  const signingKeys = new Map([['k1', { ...keyPair, status: 'current', notAfterMs: null }]]);
  const logSink = [];
  const service = new SalutantService({
    store, mailer, epochSource: epoch, allowlist,
    apps: [{ origin: APP_ORIGIN, callbackUrl: `${APP_ORIGIN}/auth/callback` }],
    serviceOrigin: SERVICE_ORIGIN,
    codeHmacKeyBytes: globalThis.crypto.getRandomValues(new Uint8Array(32)),
    stateHmacKeyBytes: globalThis.crypto.getRandomValues(new Uint8Array(32)),
    signingKeys, currentKid: 'k1', clock, logSink, config,
  });
  await service.ready();
  const worker = createWorker(service);
  const app = new StubApp({
    origin: APP_ORIGIN, serviceOrigin: SERVICE_ORIGIN,
    fetchJwks: async () => {
      const r = await service.fetch(new Request(`${SERVICE_ORIGIN}/.well-known/jwks.json`));
      if (!r.ok) throw new Error('jwks unavailable');
      return r.json();
    },
    store: appStore,
    stateHmacKeyBytes: globalThis.crypto.getRandomValues(new Uint8Array(32)),
    clock, config: appConfig,
  });
  await app.ready();
  return {
    service, worker, app, store, appStore, mailer, epoch, logSink, clock,
    advance: (ms) => { clockNow += ms; },
    setNow: (v) => { clockNow = v; },
    getNow: () => clockNow,
  };
}

// A minimal browser: a cookie jar plus the fetch calls the page script
// would make. Never puts codes, proofs or addresses in URLs.
export class BrowserSession {
  constructor(world) {
    this.world = world;
    this.cookies = new Map(); // name -> { value, path }
  }
  _cookieHeaderFor(path) {
    return [...this.cookies.entries()]
      .filter(([, c]) => path.startsWith(c.path))
      .map(([n, c]) => `${n}=${c.value}`).join('; ') || null;
  }
  _storeCookies(response) {
    const setC = response.headers.getSetCookie?.() ?? [];
    for (const line of setC) {
      const [pair, ...attrs] = line.split(';').map((s) => s.trim());
      const [name, value] = pair.split('=');
      const path = attrs.find((a) => a.toLowerCase().startsWith('path='))?.slice(5) ?? '/';
      this.cookies.set(name, { value, path });
    }
  }
  async postChallenge({ address, appOrigin = APP_ORIGIN, stateId, idempotencyKey, headers = {} }) {
    const res = await this.world.worker.fetch(new Request(`${SERVICE_ORIGIN}/v1/challenges`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}), ...headers },
      body: JSON.stringify({ address, appOrigin, stateId }),
    }));
    this._storeCookies(res);
    return res;
  }
  async resend({ challengeId, address }) {
    const res = await this.world.worker.fetch(new Request(`${SERVICE_ORIGIN}/v1/challenges`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resendOf: challengeId, address }),
    }));
    this._storeCookies(res);
    return res;
  }
  async verify({ challengeId, code, address, omitCookies = false }) {
    const path = `/v1/challenges/${encodeURIComponent(challengeId)}/verify`;
    const headers = { 'content-type': 'application/json' };
    if (!omitCookies) {
      const c = this._cookieHeaderFor(path);
      if (c) headers.cookie = c;
    }
    return this.world.worker.fetch(new Request(`${SERVICE_ORIGIN}${path}`, {
      method: 'POST', headers, body: JSON.stringify({ code, address }),
    }));
  }
  async getPage(appOrigin = APP_ORIGIN, stateId = 'x'.repeat(24)) {
    return this.world.worker.fetch(new Request(
      `${SERVICE_ORIGIN}/?app=${encodeURIComponent(appOrigin)}&state=${encodeURIComponent(stateId)}`));
  }
}

// Drive a whole sign-in the honest way. Returns every artifact.
export async function honestSignIn(world, { address = OWNER, browser = new BrowserSession(world), redeem = true } = {}) {
  const start = await world.app.startSignIn(null);
  const page = await browser.getPage(APP_ORIGIN, start.stateId);
  const create = await browser.postChallenge({ address, stateId: start.stateId });
  const created = await create.json();
  await world.service.drain();
  const code = world.mailer.lastCode();
  const verify = await browser.verify({ challengeId: created.challengeId, code, address });
  const verified = await verify.json();
  let exchange = null;
  let complete = null;
  if (verified.proof && redeem) {
    exchange = await world.app.handleExchange(
      { proof: verified.proof, state: verified.state }, SERVICE_ORIGIN);
    if (exchange.status === 200) {
      complete = await world.app.handleComplete(`pre=${start.cookieValue}`);
    }
  }
  return { start, page, create, created, code, verify, verified, exchange, complete, browser };
}

export function bodyText(response) { return response.text(); }
