// node --test tests/frontend
import { test, beforeEach } from 'node:test';
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

globalThis.CustomEvent = globalThis.CustomEvent || class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } };

globalThis.document = globalThis.document || {
  createElement: () => ({ setAttribute: () => {}, appendChild: () => {}, addEventListener: () => {} }),
  addEventListener: () => {},
  removeEventListener: () => {},
  querySelector: () => null,
  querySelectorAll: () => [],
  dispatchEvent: () => {},
};

// Seed credentials into localStorage for auth.js
mockStorage.set('jellio_auth::session', JSON.stringify({
  accessToken: 'test-token',
  userId: 'user-123',
}));

const {
  isUnreleasedItem,
  episodeReleaseLabel,
  seasonEpisodeReleaseLabels,
  isReleasedToday,
  markTodayItemHasStream,
  isTodayItemStreamVerified,
  clearVerifiedTodayStreamIds,
} = await import('../../src/Jellio/Frontend/runtime/releaseDate.js');

const {
  getNextUp,
  getSeriesNextUp,
  getNextEpisode,
  verifyTodayEpisodesHaveStreams,
  clearTodayEmptyStreamsCache,
  invalidateUserDataRows,
} = await import('../../src/Jellio/Frontend/runtime/api.js');

const FIXED_NOW = Date.UTC(2026, 10, 5, 12, 0, 0); // 2026-11-05T12:00:00Z

beforeEach(() => {
  clearVerifiedTodayStreamIds();
  clearTodayEmptyStreamsCache();
  invalidateUserDataRows();
});

test('verifyTodayEpisodesHaveStreams filters out episode today with only placeholder source', async () => {
  const today = new Date().toISOString().split('T')[0];
  const episode = {
    Id: 'ep-placeholder',
    Type: 'Episode',
    SeriesId: 'series-1',
    PremiereDate: today + 'T00:00:00Z',
  };

  // Mock fetch: placeholder stream with no stream info (Gelato placeholder)
  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('/Items/ep-placeholder')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          Id: 'ep-placeholder',
          MediaSources: [
            {
              Id: 'src-placeholder',
              Name: 'Gelato Search Placeholder',
              // No MediaStreams, no Container, no Size, no Bitrate
            },
          ],
        }),
      };
    }
    return { ok: false, status: 404 };
  };

  assert.equal(isReleasedToday(episode), true);
  assert.equal(isTodayItemStreamVerified(episode.Id), false);

  const verified = await verifyTodayEpisodesHaveStreams([episode]);
  assert.equal(verified.length, 0);
  assert.equal(isTodayItemStreamVerified(episode.Id), false);
  assert.equal(isUnreleasedItem(episode), true);
  assert.equal(episodeReleaseLabel(episode), 'Today');
});

test('verifyTodayEpisodesHaveStreams verifies episode today with valid playable source', async () => {
  const today = new Date().toISOString().split('T')[0];
  const episode = {
    Id: 'ep-playable',
    Type: 'Episode',
    SeriesId: 'series-1',
    PremiereDate: today + 'T00:00:00Z',
  };

  // Mock fetch: valid stream with video stream info
  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('/Items/ep-playable')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          Id: 'ep-playable',
          MediaSources: [
            {
              Id: 'src-playable-1',
              Name: '1080p WEB-DL',
              MediaStreams: [{ Type: 'Video', Codec: 'h264', Width: 1920, Height: 1080 }],
            },
          ],
        }),
      };
    }
    return { ok: false, status: 404 };
  };

  const verified = await verifyTodayEpisodesHaveStreams([episode]);
  assert.equal(verified.length, 1);
  assert.equal(verified[0].Id, 'ep-playable');
  assert.equal(isTodayItemStreamVerified(episode.Id), true);
  assert.equal(isUnreleasedItem(episode), false);
  assert.equal(episodeReleaseLabel(episode), '');
});

test('getNextUp excludes today episode without valid streams and includes it once stream is available', async () => {
  const today = new Date().toISOString().split('T')[0];
  const pastEpisode = {
    Id: 'ep-prev',
    Name: 'Previous Episode',
    SeriesId: 'series-1',
    PremiereDate: '2026-10-01T00:00:00Z',
  };
  const todayEpisode = {
    Id: 'ep-today-no-stream',
    Name: 'Today Episode',
    SeriesId: 'series-2',
    PremiereDate: today + 'T00:00:00Z',
  };

  let hasRealStream = false;

  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('/Shows/NextUp')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          Items: [pastEpisode, todayEpisode],
        }),
      };
    }
    if (urlStr.includes('/Jellio/next-up-hidden')) {
      return {
        ok: true,
        status: 200,
        json: async () => [],
      };
    }
    if (urlStr.includes('/Items/ep-today-no-stream')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          Id: 'ep-today-no-stream',
          MediaSources: hasRealStream
            ? [
                {
                  Id: 'src-real',
                  Name: '720p HDTV',
                  MediaStreams: [{ Type: 'Video', Codec: 'h264' }],
                },
              ]
            : [
                {
                  Id: 'src-placeholder',
                  Name: 'Placeholder',
                },
              ],
        }),
      };
    }
    return { ok: false, status: 404 };
  };

  // Phase 1: Only placeholder stream exists
  const nextUpPhase1 = await getNextUp(10);
  assert.equal(nextUpPhase1.length, 1);
  assert.equal(nextUpPhase1[0].Id, 'ep-prev');
  // Today episode is badged as Today and unreleased
  assert.equal(isUnreleasedItem(todayEpisode), true);
  assert.equal(episodeReleaseLabel(todayEpisode), 'Today');

  // Phase 2: Stream becomes available
  hasRealStream = true;
  clearTodayEmptyStreamsCache();
  invalidateUserDataRows();

  const nextUpPhase2 = await getNextUp(10);
  assert.equal(nextUpPhase2.length, 2);
  assert.equal(nextUpPhase2[0].Id, 'ep-prev');
  assert.equal(nextUpPhase2[1].Id, 'ep-today-no-stream');
  // Today episode is now released and badge is empty
  assert.equal(isUnreleasedItem(todayEpisode), false);
  assert.equal(episodeReleaseLabel(todayEpisode), '');
});

test('getSeriesNextUp returns null for unverified today episode and returns episode once stream is verified', async () => {
  const today = new Date().toISOString().split('T')[0];
  const todayEpisode = {
    Id: 'ep-series-today',
    SeriesId: 'series-target',
    PremiereDate: today + 'T00:00:00Z',
  };

  let returnPlayable = false;

  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('/Shows/NextUp')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          Items: [todayEpisode],
        }),
      };
    }
    if (urlStr.includes('/Items/ep-series-today')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          Id: 'ep-series-today',
          MediaSources: returnPlayable
            ? [{ Id: 'src-1', Name: '1080p', MediaStreams: [{ Type: 'Video' }] }]
            : [],
        }),
      };
    }
    return { ok: false, status: 404 };
  };

  // When unverified, getSeriesNextUp returns null
  const resultUnverified = await getSeriesNextUp('series-target');
  assert.equal(resultUnverified, null);

  // When stream verified, getSeriesNextUp returns the episode
  returnPlayable = true;
  clearTodayEmptyStreamsCache();
  invalidateUserDataRows();

  const resultVerified = await getSeriesNextUp('series-target');
  assert.notEqual(resultVerified, null);
  assert.equal(resultVerified.Id, 'ep-series-today');
});

test('getNextEpisode skips unverified today episode and returns it once verified', async () => {
  const today = new Date().toISOString().split('T')[0];
  const currentEp = {
    Id: 'ep-curr',
    Type: 'Episode',
    SeriesId: 's1',
    SeasonId: 'season-1',
  };
  const nextEpToday = {
    Id: 'ep-next-today',
    Type: 'Episode',
    SeriesId: 's1',
    SeasonId: 'season-1',
    PremiereDate: today + 'T00:00:00Z',
  };

  let hasStreams = false;

  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('/Shows/s1/Episodes')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          Items: [currentEp, nextEpToday],
        }),
      };
    }
    if (urlStr.includes('/Items/ep-next-today')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          Id: 'ep-next-today',
          MediaSources: hasStreams
            ? [{ Id: 'src-1', Name: '1080p', MediaStreams: [{ Type: 'Video' }] }]
            : [],
        }),
      };
    }
    return { ok: false, status: 404 };
  };

  // When next episode is today without stream, getNextEpisode returns null
  const nextCandidate1 = await getNextEpisode(currentEp);
  assert.equal(nextCandidate1, null);

  // When next episode has streams, getNextEpisode returns it
  hasStreams = true;
  clearTodayEmptyStreamsCache();

  const nextCandidate2 = await getNextEpisode(currentEp);
  assert.notEqual(nextCandidate2, null);
  assert.equal(nextCandidate2.Id, 'ep-next-today');
});
