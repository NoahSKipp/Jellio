// node --test tests/frontend/customGenres.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mockStorage = new Map();
const mockLocalStorage = {
  getItem(key) {
    return mockStorage.has(key) ? mockStorage.get(key) : null;
  },
  setItem(key, value) {
    mockStorage.set(key, String(value));
  },
  removeItem(key) {
    mockStorage.delete(key);
  },
  clear() {
    mockStorage.clear();
  },
};

globalThis.localStorage = mockLocalStorage;
globalThis.window = globalThis.window || {};
globalThis.window.Jellio = globalThis.window.Jellio || {};
globalThis.window.localStorage = mockLocalStorage;
globalThis.window.location = globalThis.window.location || { origin: 'http://localhost', hash: '' };
globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
globalThis.window.removeEventListener = globalThis.window.removeEventListener || (() => {});
globalThis.window.setTimeout = (fn, ms, ...args) => {
  const t = setTimeout(fn, ms, ...args);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
};
globalThis.window.clearTimeout = (id) => clearTimeout(id);

globalThis.document = globalThis.document || {
  createElement: () => ({ setAttribute: () => {}, appendChild: () => {}, addEventListener: () => {} }),
  addEventListener: () => {},
  removeEventListener: () => {},
  querySelector: () => null,
  querySelectorAll: () => [],
  dispatchEvent: () => {},
};

const {
  getCustomGenres,
  setCustomGenres,
  addCustomGenre,
  removeCustomGenre,
} = await import('../../src/Jellio/Frontend/runtime/recommendationSettings.js');

const {
  searchGenreOrCategory,
} = await import('../../src/Jellio/Frontend/runtime/api.js');

test('custom genres: getCustomGenres defaults to empty array', () => {
  mockStorage.clear();
  const genres = getCustomGenres();
  assert.deepEqual(genres, []);
});

test('custom genres: addCustomGenre stores genre with name, category, enabled: true', () => {
  mockStorage.clear();
  const result = addCustomGenre({ name: 'Cyberpunk', category: 'Sci-Fi' });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], { name: 'Cyberpunk', category: 'Sci-Fi', enabled: true });

  const retrieved = getCustomGenres();
  assert.deepEqual(retrieved, [{ name: 'Cyberpunk', category: 'Sci-Fi', enabled: true }]);
});

test('custom genres: addCustomGenre updates existing entry case-insensitively', () => {
  mockStorage.clear();
  addCustomGenre({ name: 'Cyberpunk', category: 'Sci-Fi', enabled: true });
  addCustomGenre({ name: 'cyberpunk', category: 'Science Fiction', enabled: false });

  const retrieved = getCustomGenres();
  assert.equal(retrieved.length, 1);
  assert.deepEqual(retrieved[0], { name: 'cyberpunk', category: 'Science Fiction', enabled: false });
});

test('custom genres: removeCustomGenre removes entry case-insensitively', () => {
  mockStorage.clear();
  addCustomGenre({ name: 'C-Drama' });
  addCustomGenre({ name: 'Martial Arts' });

  assert.equal(getCustomGenres().length, 2);

  removeCustomGenre('c-drama');
  const retrieved = getCustomGenres();
  assert.equal(retrieved.length, 1);
  assert.equal(retrieved[0].name, 'Martial Arts');
});

test('custom genres: setCustomGenres sets list directly', () => {
  mockStorage.clear();
  setCustomGenres([
    { name: 'Noir', category: null, enabled: true },
    { name: 'Space Western', category: 'Western', enabled: false },
  ]);

  const retrieved = getCustomGenres();
  assert.equal(retrieved.length, 2);
  assert.equal(retrieved[0].name, 'Noir');
  assert.equal(retrieved[1].enabled, false);
});

test('searchGenreOrCategory: exported as a function', () => {
  assert.equal(typeof searchGenreOrCategory, 'function');
});
