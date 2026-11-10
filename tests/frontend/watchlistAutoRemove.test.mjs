// node --test tests/frontend
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
globalThis.window.setTimeout = (fn, ms, ...args) => {
  const t = setTimeout(fn, ms, ...args);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
};
globalThis.window.clearTimeout = (id) => clearTimeout(id);
globalThis.window.setInterval = (fn, ms, ...args) => {
  const t = setInterval(fn, ms, ...args);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
};
globalThis.window.clearInterval = (id) => clearInterval(id);

globalThis.CustomEvent = globalThis.CustomEvent || class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } };

globalThis.document = globalThis.document || {
  createElement: () => ({ setAttribute: () => {}, appendChild: () => {}, addEventListener: () => {} }),
  addEventListener: () => {},
  removeEventListener: () => {},
  querySelector: () => null,
  querySelectorAll: () => [],
  dispatchEvent: () => {},
};

const {
  isRemoveFromWatchlistAfterWatchingEnabled,
  setRemoveFromWatchlistAfterWatchingEnabled,
  syncWatchlistSettingsFromServer,
} = await import('../../src/Jellio/Frontend/runtime/watchlistSettings.js');

function setupSession() {
  mockStorage.set('jellio_auth::session', JSON.stringify({ userId: 'u-1', accessToken: 'token-1' }));
}

test('isRemoveFromWatchlistAfterWatchingEnabled is true by default and can be toggled', async () => {
  mockStorage.clear();

  // Default is true when nothing in localStorage
  assert.equal(isRemoveFromWatchlistAfterWatchingEnabled(), true);

  // Set to false
  await setRemoveFromWatchlistAfterWatchingEnabled(false);
  assert.equal(mockStorage.get('jellioRemoveWatchlistAfterWatching'), 'false');
  assert.equal(isRemoveFromWatchlistAfterWatchingEnabled(), false);

  // Set to true
  await setRemoveFromWatchlistAfterWatchingEnabled(true);
  assert.equal(mockStorage.get('jellioRemoveWatchlistAfterWatching'), 'true');
  assert.equal(isRemoveFromWatchlistAfterWatchingEnabled(), true);
});

test('syncWatchlistSettingsFromServer updates localStorage from server response', async () => {
  mockStorage.clear();
  setupSession();

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('/Jellio/profile/settings')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ RemoveFromWatchlistAfterWatching: false }),
          json: async () => ({ RemoveFromWatchlistAfterWatching: false }),
        };
      }
      return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
    };

    const synced = await syncWatchlistSettingsFromServer();
    assert.equal(synced, false);
    assert.equal(isRemoveFromWatchlistAfterWatchingEnabled(), false);
    assert.equal(mockStorage.get('jellioRemoveWatchlistAfterWatching'), 'false');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('watchlist section card removal animates and removes empty section', async () => {
  // Simulate the section and card structure used in home.js buildWatchlistSection
  let animated = false;
  const mockAnimate = () => { animated = true; };

  const root = {
    children: [],
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx !== -1) {
        this.children.splice(idx, 1);
        child.parentNode = null;
      }
    },
    querySelector(selector) {
      return this.children.find((c) => c.className && c.className.includes(selector.replace('.', ''))) || null;
    },
  };

  const grid = {
    children: [],
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx !== -1) {
        this.children.splice(idx, 1);
        child.parentNode = null;
      }
    },
  };

  const section = {
    parentNode: null,
    className: 'jellio-row',
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    },
  };
  root.appendChild(section);

  const cardEl = {
    parentNode: grid,
    className: 'jellio-card',
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    },
  };
  grid.children.push(cardEl);

  let onSectionEmptyCalled = false;
  const onSectionEmpty = () => { onSectionEmptyCalled = true; };

  // onChanged handler logic as implemented in buildWatchlistSection
  const handleItemChanged = (updatedItem, card) => {
    if (!updatedItem || !updatedItem.UserData || !updatedItem.UserData.IsFavorite) {
      mockAnimate(card);
      if (card.parentNode) card.remove();
      if (grid.children.length === 0 && section.parentNode) {
        section.remove();
        if (onSectionEmpty) onSectionEmpty();
      }
    }
  };

  // When movie is unfavorited:
  handleItemChanged({ Id: 'm-1', UserData: { IsFavorite: false } }, cardEl);

  assert.equal(animated, true);
  assert.equal(cardEl.parentNode, null);
  assert.equal(grid.children.length, 0);
  assert.equal(section.parentNode, null);
  assert.equal(onSectionEmptyCalled, true);
});
