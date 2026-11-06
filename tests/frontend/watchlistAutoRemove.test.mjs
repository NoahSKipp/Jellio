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

const {
  maybeRemoveFromWatchlistAfterWatching,
} = await import('../../src/Jellio/Frontend/runtime/api.js');

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

test('maybeRemoveFromWatchlistAfterWatching removes watched Movie from watchlist when enabled', async () => {
  mockStorage.clear();
  setupSession();
  const watchlistCalls = [];
  const movie = {
    Id: 'm-1',
    Type: 'Movie',
    Name: 'The Matrix',
    UserData: { IsFavorite: true, Played: true },
  };

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, opts = {}) => {
      const urlStr = String(url);
      if (urlStr.includes('/FavoriteItems/m-1')) {
        watchlistCalls.push({ url: urlStr, method: opts.method });
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (urlStr.includes('/Items') && urlStr.includes('m-1')) {
        return { ok: true, status: 200, json: async () => ({ Items: [movie] }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    await maybeRemoveFromWatchlistAfterWatching('m-1');
    assert.equal(watchlistCalls.length, 1);
    assert.equal(watchlistCalls[0].method, 'DELETE');
    assert.equal(movie.UserData.IsFavorite, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('maybeRemoveFromWatchlistAfterWatching keeps Movie on watchlist when setting is disabled', async () => {
  mockStorage.clear();
  setupSession();
  mockStorage.set('jellioRemoveWatchlistAfterWatching', 'false');
  const watchlistCalls = [];
  const movie = {
    Id: 'm-1',
    Type: 'Movie',
    UserData: { IsFavorite: true, Played: true },
  };

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, opts = {}) => {
      if (String(url).includes('/FavoriteItems/')) {
        watchlistCalls.push({ url: String(url), method: opts.method });
      }
      return { ok: true, status: 200, json: async () => ({ Items: [movie] }) };
    };

    await maybeRemoveFromWatchlistAfterWatching('m-1');
    assert.equal(watchlistCalls.length, 0);
    assert.equal(movie.UserData.IsFavorite, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('maybeRemoveFromWatchlistAfterWatching never removes Continuing series from watchlist', async () => {
  mockStorage.clear();
  setupSession();
  const watchlistCalls = [];
  const series = {
    Id: 's-1',
    Type: 'Series',
    Name: 'Airing Anime',
    Status: 'Continuing',
    UserData: { IsFavorite: true },
  };
  const ep1 = {
    Id: 'ep-1',
    Type: 'Episode',
    SeriesId: 's-1',
    ParentIndexNumber: 1,
    IndexNumber: 1,
    PremiereDate: '2026-01-01T00:00:00Z',
    UserData: { Played: true },
  };

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, opts = {}) => {
      const urlStr = String(url);
      if (urlStr.includes('/FavoriteItems/')) {
        watchlistCalls.push({ url: urlStr, method: opts.method });
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (urlStr.includes('/Items') && urlStr.includes('ep-1')) {
        return { ok: true, status: 200, json: async () => ({ Items: [ep1] }) };
      }
      if (urlStr.includes('/Items') && urlStr.includes('s-1')) {
        return { ok: true, status: 200, json: async () => ({ Items: [series] }) };
      }
      if (urlStr.includes('/Shows/s-1/Episodes')) {
        return { ok: true, status: 200, json: async () => ({ Items: [ep1] }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    await maybeRemoveFromWatchlistAfterWatching('ep-1');
    // Series should NOT be removed from watchlist because Status is Continuing
    assert.equal(watchlistCalls.some((c) => c.url.includes(series.Id)), false);
    assert.equal(series.UserData.IsFavorite, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('maybeRemoveFromWatchlistAfterWatching keeps Ended series on watchlist if regular episodes unwatched or unreleased', async () => {
  mockStorage.clear();
  setupSession();
  const watchlistCalls = [];
  const series = {
    Id: 's-ended',
    Type: 'Series',
    Status: 'Ended',
    UserData: { IsFavorite: true },
  };
  const ep1 = {
    Id: 'ep-1',
    Type: 'Episode',
    SeriesId: 's-ended',
    ParentIndexNumber: 1,
    IndexNumber: 1,
    PremiereDate: '2026-01-01T00:00:00Z',
    UserData: { Played: true },
  };
  const ep2Unwatched = {
    Id: 'ep-2',
    Type: 'Episode',
    SeriesId: 's-ended',
    ParentIndexNumber: 1,
    IndexNumber: 2,
    PremiereDate: '2026-01-08T00:00:00Z',
    UserData: { Played: false },
  };

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, opts = {}) => {
      const urlStr = String(url);
      if (urlStr.includes('/FavoriteItems/')) {
        watchlistCalls.push({ url: urlStr, method: opts.method });
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (urlStr.includes('/Items') && urlStr.includes('ep-1')) {
        return { ok: true, status: 200, json: async () => ({ Items: [ep1] }) };
      }
      if (urlStr.includes('/Items') && urlStr.includes('s-ended')) {
        return { ok: true, status: 200, json: async () => ({ Items: [series] }) };
      }
      if (urlStr.includes('/Shows/s-ended/Episodes')) {
        return { ok: true, status: 200, json: async () => ({ Items: [ep1, ep2Unwatched] }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    await maybeRemoveFromWatchlistAfterWatching('ep-1');
    assert.equal(watchlistCalls.some((c) => c.url.includes(series.Id)), false);
    assert.equal(series.UserData.IsFavorite, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('maybeRemoveFromWatchlistAfterWatching removes Ended series when all regular episodes are watched, even with unwatched special', async () => {
  mockStorage.clear();
  setupSession();
  const watchlistCalls = [];
  const series = {
    Id: 's-ended',
    Type: 'Series',
    Status: 'Ended',
    UserData: { IsFavorite: true },
  };
  const ep1 = {
    Id: 'ep-1',
    Type: 'Episode',
    SeriesId: 's-ended',
    ParentIndexNumber: 1,
    IndexNumber: 1,
    PremiereDate: '2026-01-01T00:00:00Z',
    UserData: { Played: true },
  };
  const ep2 = {
    Id: 'ep-2',
    Type: 'Episode',
    SeriesId: 's-ended',
    ParentIndexNumber: 1,
    IndexNumber: 2,
    PremiereDate: '2026-01-08T00:00:00Z',
    UserData: { Played: false },
  };
  const specialEp = {
    Id: 'ep-special',
    Type: 'Episode',
    SeriesId: 's-ended',
    ParentIndexNumber: 0, // Specials Season
    IndexNumber: 1,
    UserData: { Played: false },
  };

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, opts = {}) => {
      const urlStr = String(url);
      if (urlStr.includes('/FavoriteItems/s-ended')) {
        watchlistCalls.push({ url: urlStr, method: opts.method });
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (urlStr.includes('/Items') && urlStr.includes('ep-2')) {
        return { ok: true, status: 200, json: async () => ({ Items: [ep2] }) };
      }
      if (urlStr.includes('/Items') && urlStr.includes('s-ended')) {
        return { ok: true, status: 200, json: async () => ({ Items: [series] }) };
      }
      if (urlStr.includes('/Shows/s-ended/Episodes')) {
        return { ok: true, status: 200, json: async () => ({ Items: [ep1, ep2, specialEp] }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    // Watching ep2 (the final unwatched regular episode)
    await maybeRemoveFromWatchlistAfterWatching('ep-2');
    assert.equal(watchlistCalls.some((c) => c.url.includes(series.Id) && c.method === 'DELETE'), true);
    assert.equal(series.UserData.IsFavorite, false);
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
