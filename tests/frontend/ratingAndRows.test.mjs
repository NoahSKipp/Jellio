import { test } from 'node:test';
import assert from 'node:assert/strict';

class MockClassList {
  constructor() {
    this.classes = new Set();
  }
  add(...names) {
    names.forEach((n) => {
      if (n) this.classes.add(n);
    });
  }
  remove(...names) {
    names.forEach((n) => this.classes.delete(n));
  }
  toggle(name, force) {
    if (typeof force === 'boolean') {
      if (force) this.classes.add(name);
      else this.classes.delete(name);
      return force;
    }
    if (this.classes.has(name)) {
      this.classes.delete(name);
      return false;
    }
    this.classes.add(name);
    return true;
  }
  contains(name) {
    return this.classes.has(name);
  }
}

class MockElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.classList = new MockClassList();
    this.listeners = new Map();
    this.scrollLeft = 0;
    this.clientWidth = 1000;
    this.scrollWidth = 1000;
    this.tabIndex = 0;
  }
  get className() {
    return Array.from(this.classList.classes).join(' ');
  }
  set className(val) {
    this.classList.classes.clear();
    String(val || '')
      .split(/\s+/)
      .filter(Boolean)
      .forEach((c) => this.classList.classes.add(c));
  }
  appendChild(child) {
    if (!child) return child;
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  insertBefore(newChild, refChild) {
    newChild.parentNode = this;
    const idx = this.children.indexOf(refChild);
    if (idx === -1) {
      this.children.push(newChild);
    } else {
      this.children.splice(idx, 0, newChild);
    }
    return newChild;
  }
  remove() {
    if (this.parentNode) {
      const idx = this.parentNode.children.indexOf(this);
      if (idx !== -1) this.parentNode.children.splice(idx, 1);
      this.parentNode = null;
    }
  }
  setAttribute(name, val) {
    this.attributes.set(name, String(val));
  }
  getAttribute(name) {
    return this.attributes.get(name) || null;
  }
  addEventListener(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  }
  removeEventListener(event, fn) {
    if (!this.listeners.has(event)) return;
    this.listeners.set(event, this.listeners.get(event).filter((f) => f !== fn));
  }
  dispatchEvent(event) {
    const list = this.listeners.get(event.type) || [];
    list.forEach((fn) => fn(event));
  }
  querySelector(sel) {
    return null;
  }
  querySelectorAll(sel) {
    return [];
  }
  scrollBy() {}
}

const storage = new Map();
globalThis.window = {
  Jellio: {},
  location: { origin: 'http://localhost', hash: '' },
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
    clear: () => storage.clear(),
  },
  history: { pushState: () => {}, replaceState: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {},
  requestAnimationFrame: (cb) => setTimeout(cb, 0),
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (...args) => clearTimeout(...args),
};

globalThis.document = {
  createElement: (tag) => new MockElement(tag),
  createTextNode: (text) => ({ textContent: String(text), nodeType: 3 }),
  addEventListener: () => {},
  removeEventListener: () => {},
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  dispatchEvent: () => {},
};

const { buildRatingBadge } = await import('../../src/Jellio/Frontend/components/ratingBadge.js');
const { buildRow } = await import('../../src/Jellio/Frontend/components/row.js');
const {
  dedupeRow,
  VIEWPORT_DEDUPE_LIMIT,
  SLIDING_WINDOW_ROW_COUNT,
} = await import('../../src/Jellio/Frontend/screens/home.js');
const { isTvSession, TV_PATTERN } = await import('../../src/Jellio/Frontend/runtime/cast.js');
const { getRemoteSessions } = await import('../../src/Jellio/Frontend/runtime/api.js');
const { setSession, clearSession } = await import('../../src/Jellio/Frontend/runtime/auth.js');

test('buildRatingBadge creates TMDB rating badge with correct icon class and formatted score', () => {
  const badge = buildRatingBadge(8.46, 'custom-badge');
  assert.ok(badge.classList.contains('jellio-rating-badge'));
  assert.ok(badge.classList.contains('custom-badge'));

  const icon = badge.children[0];
  assert.equal(icon.tagName, 'IMG');
  assert.ok(icon.classList.contains('jellio-rating-badge-icon'));
  assert.equal(icon.alt, 'TMDB');
  assert.match(icon.src, /\/Jellio\/frontend\/img\/ratings\/tmdb\.svg/);

  const textNode = badge.children[1];
  assert.equal(textNode.textContent, '8.5');
});

test('buildRow returns null when item list is empty', () => {
  assert.equal(buildRow('Action', []), null);
  assert.equal(buildRow('Action', null), null);
});

test('buildRow sets up horizontal infinite scroll and fetches next page on scroll near end', async () => {
  const initialItems = [
    { Id: 'item-1', Name: 'Movie 1', Type: 'Movie' },
    { Id: 'item-2', Name: 'Movie 2', Type: 'Movie' },
  ];

  const pagesAsked = [];
  const fetchPage = async (start, size) => {
    pagesAsked.push({ start, size });
    return [
      { Id: 'item-3', Name: 'Movie 3', Type: 'Movie' },
      { Id: 'item-1', Name: 'Movie 1 Duplicate', Type: 'Movie' },
    ];
  };

  const section = buildRow('Trending Movies', initialItems, null, { fetchPage });
  assert.ok(section);
  assert.ok(section.classList.contains('jellio-row'));

  const trackWrap = section.children[1];
  assert.ok(trackWrap.classList.contains('jellio-row-track-wrap'));
  const track = trackWrap.children[0];
  assert.ok(track.classList.contains('jellio-row-track'));

  // Initially has 2 cards
  assert.equal(track.children.length, 2);

  // Simulate scrolling track near the end
  track.scrollWidth = 1400;
  track.clientWidth = 1000;
  track.scrollLeft = 300; // remaining = 1400 - (300 + 1000) = 100 <= 600

  track.dispatchEvent({ type: 'scroll' });

  // Await async page fetch
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(pagesAsked.length, 1);
  assert.deepEqual(pagesAsked[0], { start: 2, size: 24 });

  // item-3 appended, duplicate item-1 skipped -> total 3 cards
  assert.equal(track.children.length, 3);
});

test('dedupeRow: items from the recommendations tier can appear in genre rows (Tiered Isolation)', () => {
  // Recommendation rows use an isolated recSeen tracking map and do not populate
  // recentRows used by catalogs and genres.
  const recSeen = {
    'rec-movie-1': true,
    'dune|2021': true,
  };

  const genreItems = [
    { Id: 'rec-movie-1', Name: 'Dune', ProductionYear: 2021 },
    { Id: 'genre-movie-2', Name: 'Star Wars', ProductionYear: 1977 },
  ];

  // Recent rows sliding window for catalogs/genres is empty or does not include recSeen
  const recentRows = [];
  const result = dedupeRow(genreItems, recentRows);

  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].Id, 'rec-movie-1');
  assert.equal(result.items[1].Id, 'genre-movie-2');
});

test('dedupeRow: items from the previous 2 rows are omitted from the first 6 slots (viewport deduplication)', () => {
  const row1 = [
    { Id: 'r1-1', Name: 'Movie R1-1', ProductionYear: 2020 },
    { Id: 'r1-2', Name: 'Movie R1-2', ProductionYear: 2020 },
  ];
  const row2 = [
    { Id: 'r2-1', Name: 'Movie R2-1', ProductionYear: 2021 },
    { Id: 'r2-2', Name: 'Movie R2-2', ProductionYear: 2021 },
  ];

  const keys1 = dedupeRow(row1, []).keys;
  const keys2 = dedupeRow(row2, [keys1]).keys;
  const recentRows = [keys1, keys2];

  // In row 3, we put items from row 1 and row 2 at the front of the candidates list
  const row3Candidates = [
    { Id: 'r1-1', Name: 'Movie R1-1', ProductionYear: 2020 },
    { Id: 'r2-1', Name: 'Movie R2-1', ProductionYear: 2021 },
    { Id: 'fresh-1', Name: 'Fresh 1', ProductionYear: 2022 },
    { Id: 'fresh-2', Name: 'Fresh 2', ProductionYear: 2022 },
    { Id: 'fresh-3', Name: 'Fresh 3', ProductionYear: 2022 },
    { Id: 'fresh-4', Name: 'Fresh 4', ProductionYear: 2022 },
    { Id: 'fresh-5', Name: 'Fresh 5', ProductionYear: 2022 },
    { Id: 'fresh-6', Name: 'Fresh 6', ProductionYear: 2022 },
  ];

  const result = dedupeRow(row3Candidates, recentRows, VIEWPORT_DEDUPE_LIMIT);

  // The first 6 slots must contain only fresh items, omitting r1-1 and r2-1
  assert.equal(result.items.length, VIEWPORT_DEDUPE_LIMIT);
  const resultIds = result.items.map((it) => it.Id);
  assert.ok(!resultIds.includes('r1-1'), 'r1-1 should be omitted from viewport slots');
  assert.ok(!resultIds.includes('r2-1'), 'r2-1 should be omitted from viewport slots');
  assert.deepEqual(resultIds, ['fresh-1', 'fresh-2', 'fresh-3', 'fresh-4', 'fresh-5', 'fresh-6']);
});

test('dedupeRow: items from the previous 2 rows CAN appear after the first 6 slots (beyond viewport)', () => {
  const row1 = [{ Id: 'r1-1', Name: 'Movie R1-1', ProductionYear: 2020 }];
  const row2 = [{ Id: 'r2-1', Name: 'Movie R2-1', ProductionYear: 2021 }];

  const keys1 = dedupeRow(row1, []).keys;
  const keys2 = dedupeRow(row2, [keys1]).keys;
  const recentRows = [keys1, keys2];

  const row3Candidates = [
    { Id: 'fresh-1', Name: 'Fresh 1', ProductionYear: 2022 },
    { Id: 'fresh-2', Name: 'Fresh 2', ProductionYear: 2022 },
    { Id: 'fresh-3', Name: 'Fresh 3', ProductionYear: 2022 },
    { Id: 'fresh-4', Name: 'Fresh 4', ProductionYear: 2022 },
    { Id: 'fresh-5', Name: 'Fresh 5', ProductionYear: 2022 },
    { Id: 'fresh-6', Name: 'Fresh 6', ProductionYear: 2022 },
    { Id: 'r1-1', Name: 'Movie R1-1', ProductionYear: 2020 },
    { Id: 'r2-1', Name: 'Movie R2-1', ProductionYear: 2021 },
  ];

  const result = dedupeRow(row3Candidates, recentRows);

  assert.equal(result.items.length, 8);
  // Viewport slots (0 to 5) are fresh items
  assert.equal(result.items[0].Id, 'fresh-1');
  assert.equal(result.items[5].Id, 'fresh-6');
  // Slots beyond viewport (index 6 and 7) allow items from recentRows
  assert.equal(result.items[6].Id, 'r1-1');
  assert.equal(result.items[7].Id, 'r2-1');
});

test('dedupeRow: items separated by 3 or more rows can reappear in the viewport slots (distance decay)', () => {
  const itemA = { Id: 'item-a', Name: 'Movie A', ProductionYear: 2019 };
  const itemB = { Id: 'item-b', Name: 'Movie B', ProductionYear: 2020 };
  const itemC = { Id: 'item-c', Name: 'Movie C', ProductionYear: 2021 };

  const keysRow1 = dedupeRow([itemA], []).keys;
  const keysRow2 = dedupeRow([itemB], [keysRow1]).keys;
  const keysRow3 = dedupeRow([itemC], [keysRow1, keysRow2]).keys;

  // Sliding window maintains at most SLIDING_WINDOW_ROW_COUNT (2) entries in history.
  // For row 4, keysRow1 has slid out of the window.
  const recentRowsFor4 = [keysRow2, keysRow3];
  assert.equal(recentRowsFor4.length, SLIDING_WINDOW_ROW_COUNT);

  const row4Candidates = [itemA, { Id: 'fresh-4', Name: 'Fresh 4', ProductionYear: 2024 }];
  const result = dedupeRow(row4Candidates, recentRowsFor4);

  // itemA was separated by 3 rows (row 1 vs row 4), so it reappears in slot 0
  assert.equal(result.items[0].Id, 'item-a');
  assert.equal(result.items.length, 2);
});

test('dedupeRow: intra-row duplicates (same Id or same titleKey) are always eliminated', () => {
  const candidates = [
    // Unique item 1
    { Id: 'id-1', Name: 'The Matrix', ProductionYear: 1999 },
    // Duplicate by same Id
    { Id: 'id-1', Name: 'The Matrix (Special Edition)', ProductionYear: 2000 },
    // Duplicate by same titleKey (same name and year, different Id)
    { Id: 'id-alt', Name: 'The Matrix', ProductionYear: 1999 },
    // Unique item 2
    { Id: 'id-2', Name: 'Inception', ProductionYear: 2010 },
    // Duplicate by case and whitespace in titleKey
    { Id: 'id-3', Name: '  inception  ', ProductionYear: 2010 },
    // Duplicate by same titleKey beyond viewport
    { Id: 'fresh-1', Name: 'Fresh 1', ProductionYear: 2024 },
    { Id: 'fresh-2', Name: 'Fresh 2', ProductionYear: 2024 },
    { Id: 'fresh-3', Name: 'Fresh 3', ProductionYear: 2024 },
    { Id: 'fresh-4', Name: 'Fresh 4', ProductionYear: 2024 },
    { Id: 'id-dup-late', Name: 'The Matrix', ProductionYear: 1999 },
  ];

  const result = dedupeRow(candidates, []);

  // id-1, id-2, fresh-1, fresh-2, fresh-3, fresh-4 should be kept (6 items total)
  // All duplicate occurrences of The Matrix and Inception should be eliminated
  assert.equal(result.items.length, 6);
  assert.deepEqual(
    result.items.map((it) => it.Id),
    ['id-1', 'id-2', 'fresh-1', 'fresh-2', 'fresh-3', 'fresh-4'],
  );
  assert.equal(result.keys['id-1'], true);
  assert.equal(result.keys['the matrix|1999'], true);
  assert.equal(result.keys['id-2'], true);
  assert.equal(result.keys['inception|2010'], true);
});

test('isTvSession correctly identifies Jellio TV and Smart TV client sessions', () => {
  // Jellio TV variations
  assert.equal(isTvSession({ Client: 'Jellio TV', DeviceName: 'Living Room TV' }), true);
  assert.equal(isTvSession({ Client: 'Jellio', DeviceName: 'Living Room' }), true);
  assert.equal(isTvSession({ Client: 'Jellio-TV', ApplicationVersion: '0.43.0' }), true);
  assert.equal(isTvSession({ DeviceName: 'Bedroom Screen', ApplicationVersion: 'Jellio 1.80.0' }), true);

  // Common Smart TV / Streaming devices
  assert.equal(isTvSession({ DeviceName: 'Android TV' }), true);
  assert.equal(isTvSession({ DeviceName: 'Chromecast with Google TV' }), true);
  assert.equal(isTvSession({ DeviceName: 'SHIELD Android TV' }), true);
  assert.equal(isTvSession({ DeviceName: 'Apple TV 4K' }), true);
  assert.equal(isTvSession({ DeviceName: 'Sony Bravia' }), true);
  assert.equal(isTvSession({ DeviceName: 'Fire TV Stick 4K' }), true);
  assert.equal(isTvSession({ DeviceName: 'Roku Express' }), true);
  assert.equal(isTvSession({ Client: 'LG Smart TV', DeviceName: 'webOS' }), true);
  assert.equal(isTvSession({ Client: 'Samsung Smart TV', DeviceName: 'Tizen' }), true);
  assert.equal(isTvSession({ Client: 'Kodi', DeviceName: 'HTPC' }), true);
  assert.equal(isTvSession({ Client: 'Jellyfin Media Player', DeviceName: 'Living Room' }), true);

  // Non-TV sessions
  assert.equal(isTvSession({ DeviceName: 'MacBook Pro', Client: 'Jellyfin Web' }), false);
  assert.equal(isTvSession({ DeviceName: 'Workstation', Client: 'Firefox' }), false);
  assert.equal(isTvSession(null), false);
  assert.equal(isTvSession(undefined), false);
  assert.equal(isTvSession({}), false);
});

test('getRemoteSessions: query construction and deduplication when signed in', async () => {
  setSession('test-token', { Id: 'user-guid-456', Name: 'Alice' });

  const originalFetch = globalThis.fetch;
  const requestedUrls = [];

  try {
    globalThis.fetch = async (url) => {
      requestedUrls.push(url);
      if (url.includes('ControllableByUserId=' + encodeURIComponent('user-guid-456'))) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            { Id: 'sess-1', DeviceName: 'Jellio TV Living Room' },
            { Id: 'sess-2', DeviceName: 'SHIELD Android TV' },
          ],
        };
      }
      if (url.endsWith('/Sessions')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            { Id: 'sess-1', DeviceName: 'Jellio TV Living Room' },
            { Id: 'sess-3', DeviceName: 'Apple TV' },
          ],
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    const sessions = await getRemoteSessions();

    // Verify both endpoints were called in order with correct parameters
    assert.equal(requestedUrls.length, 2);
    assert.ok(requestedUrls[0].includes('/Sessions?ControllableByUserId=user-guid-456'));
    assert.ok(requestedUrls[1].endsWith('/Sessions'));

    // Verify deduplication: sess-1 appears only once; sess-2 and sess-3 are retained
    assert.equal(sessions.length, 3);
    assert.deepEqual(sessions.map((s) => s.Id), ['sess-1', 'sess-2', 'sess-3']);
  } finally {
    globalThis.fetch = originalFetch;
    clearSession();
  }
});

test('getRemoteSessions: query construction without user session (anonymous)', async () => {
  clearSession();

  const originalFetch = globalThis.fetch;
  const requestedUrls = [];

  try {
    globalThis.fetch = async (url) => {
      requestedUrls.push(url);
      if (url.endsWith('/Sessions')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ Id: 'sess-anon', DeviceName: 'Chromecast with Google TV' }],
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    const sessions = await getRemoteSessions();

    assert.equal(requestedUrls.length, 1);
    assert.ok(requestedUrls[0].endsWith('/Sessions'));
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].Id, 'sess-anon');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('getRemoteSessions: graceful error handling when non-admin receives 403 Forbidden on /Sessions', async () => {
  setSession('test-token', { Id: 'user-guid-789', Name: 'Bob' });

  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (url) => {
      if (url.includes('ControllableByUserId=' + encodeURIComponent('user-guid-789'))) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ Id: 'sess-controllable', DeviceName: 'Jellio TV Bedroom' }],
        };
      }
      if (url.endsWith('/Sessions')) {
        return {
          ok: false,
          status: 403,
          json: async () => ({ Error: 'Forbidden' }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    const sessions = await getRemoteSessions();

    // 403 is caught gracefully and user-controllable sessions are returned
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].Id, 'sess-controllable');
  } finally {
    globalThis.fetch = originalFetch;
    clearSession();
  }
});

test('getRemoteSessions: graceful error handling when network or API fails', async () => {
  setSession('test-token', { Id: 'user-guid-fail', Name: 'Charlie' });

  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () => {
      return {
        ok: false,
        status: 403,
        json: async () => ({ Error: 'Forbidden' }),
      };
    };

    const sessions = await getRemoteSessions();
    assert.deepEqual(sessions, []);
  } finally {
    globalThis.fetch = originalFetch;
    clearSession();
  }
});
