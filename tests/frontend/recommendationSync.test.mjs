import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
store.set('jellio_auth::session', JSON.stringify({ userId: 'u1', accessToken: 'tok' }));
globalThis.window = {
  Jellio: {},
  localStorage: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  },
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
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
  createElement: () => ({}),
  querySelector: () => null,
};

let profile = {};
let profileRequests = 0;
globalThis.fetch = async (url) => {
  if (String(url).endsWith('/Jellio/profile/settings')) profileRequests++;
  return { ok: true, status: 200, json: async () => profile };
};

const { syncRecommendationsFromServer, syncRecommendationsOnStart, getSelectedGenres, getCustomGenres } = await import(
  '../../src/Jellio/Frontend/runtime/recommendationSettings.js'
);

test('genres saved on the server reach a browser with nothing stored', async () => {
  profile = {
    IsPrivate: false,
    selectedGenres: ['Action', 'Drama'],
    customGenres: [{ name: 'Heist', category: 'Crime', enabled: false }],
  };
  await syncRecommendationsFromServer();
  assert.deepEqual(getSelectedGenres(), ['Action', 'Drama']);
  assert.deepEqual(getCustomGenres(), [{ name: 'Heist', category: 'Crime', enabled: false }]);
});

test('nothing saved on the server keeps what this browser has', async () => {
  profile = { selectedGenres: null, customGenres: null };
  await syncRecommendationsFromServer();
  assert.deepEqual(getSelectedGenres(), ['Action', 'Drama']);
});

test('the start-up sync asks once per user', async () => {
  profileRequests = 0;
  syncRecommendationsOnStart();
  syncRecommendationsOnStart();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(profileRequests, 1);
});
