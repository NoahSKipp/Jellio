import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
const storage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};
store.set('jellio_auth::session', JSON.stringify({ userId: 'u1', accessToken: 'tok' }));

const listeners = new Map();
globalThis.window = {
  Jellio: {},
  localStorage: storage,
  location: { origin: 'http://server', hash: '' },
  addEventListener: () => {},
  removeEventListener: () => {},
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clearTimeout: (id) => clearTimeout(id),
};
globalThis.document = {
  addEventListener: (name, fn) => listeners.set(name, fn),
  removeEventListener: () => {},
  dispatchEvent: () => true,
  createElement: () => ({}),
  querySelector: () => null,
};

const calls = [];
let statusFor = () => 200;
globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  return { status: statusFor(url), ok: statusFor(url) < 400 };
};

const { authedFetch } = await import('../../src/Jellio/Frontend/runtime/api.js');

test('authedFetch prefixes the server and adds auth headers last', async () => {
  calls.length = 0;
  const response = await authedFetch('/Jellio/x', { method: 'POST', headers: { Accept: 'application/json' } });
  assert.equal(response.status, 200);
  assert.equal(calls[0].url, 'http://server/Jellio/x');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Accept, 'application/json');
  assert.match(calls[0].init.headers.Authorization, /Token="tok"/);
});

test('authedFetch confirms a 401 with one probe of the current user', async () => {
  calls.length = 0;
  statusFor = (url) => (url.endsWith('/Jellio/strict') ? 401 : 200);
  const response = await authedFetch('/Jellio/strict');
  assert.equal(response.status, 401);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(
    calls.map((c) => c.url),
    ['http://server/Jellio/strict', 'http://server/Users/u1'],
  );
});

test('authedFetch leaves sign-in endpoints alone on a 401', async () => {
  calls.length = 0;
  statusFor = () => 401;
  await authedFetch('/QuickConnect/Authorize?code=1', { method: 'POST' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls.length, 1);
});
