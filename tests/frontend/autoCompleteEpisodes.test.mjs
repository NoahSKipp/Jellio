import { test } from 'node:test';
import assert from 'node:assert/strict';

// Setup window and mock storage before importing runtime modules
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
const nativeSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...args) => {
  const t = nativeSetInterval(fn, ms, ...args);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
};
const nativeSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  const t = nativeSetTimeout(fn, ms, ...args);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
};
globalThis.window.setTimeout = globalThis.setTimeout;
globalThis.window.clearTimeout = (id) => clearTimeout(id);
globalThis.window.setInterval = globalThis.setInterval;
globalThis.window.clearInterval = (id) => clearInterval(id);

globalThis.document = globalThis.document || {
  createElement: () => ({ setAttribute: () => {}, appendChild: () => {}, addEventListener: () => {} }),
  addEventListener: () => {},
  removeEventListener: () => {},
  querySelector: () => null,
  querySelectorAll: () => [],
};

const { isEpisodicAnthology } = await import('../../src/Jellio/Frontend/runtime/api.js');

test('isEpisodicAnthology: detects anthology genres and tags', () => {
  assert.equal(isEpisodicAnthology({ Genres: ['Drama', 'Anthology'] }), true);
  assert.equal(isEpisodicAnthology({ Tags: ['sci-fi anthology', 'horror'] }), true);
});

test('isEpisodicAnthology: detects anthology in overview', () => {
  assert.equal(isEpisodicAnthology({ Overview: 'An animated anthology series presenting short stories.' }), true);
  assert.equal(isEpisodicAnthology({ Overview: 'A standalone horror anthology.' }), true);
});

test('isEpisodicAnthology: detects curated anthology series names', () => {
  assert.equal(isEpisodicAnthology({ Name: 'Black Mirror' }), true);
  assert.equal(isEpisodicAnthology({ Name: 'Love, Death & Robots' }), true);
  assert.equal(isEpisodicAnthology({ Name: 'Guillermo del Toro\'s Cabinet of Curiosities' }), true);
  assert.equal(isEpisodicAnthology({ Name: 'The Twilight Zone' }), true);
  assert.equal(isEpisodicAnthology({ Name: 'Star Wars: Visions' }), true);
});

test('isEpisodicAnthology: returns false for standard serialized series', () => {
  assert.equal(isEpisodicAnthology({ Name: 'Breaking Bad', Genres: ['Crime', 'Drama'], Overview: 'A chemistry teacher diagnosed with cancer.' }), false);
  assert.equal(isEpisodicAnthology({ Name: 'Stranger Things', Genres: ['Sci-Fi', 'Horror'], Overview: 'A young boy vanishes.' }), false);
  assert.equal(isEpisodicAnthology(null), false);
  assert.equal(isEpisodicAnthology({}), false);
});
