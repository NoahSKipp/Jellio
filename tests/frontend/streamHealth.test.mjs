// node --test tests/frontend
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markBadSource, isBadSource, looksLikePlaceholder } from '../../src/Jellio/Frontend/runtime/streamHealth.js';

function installMockLocalStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  const localStorage = {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
  };
  globalThis.localStorage = localStorage;
  globalThis.window = { localStorage };
  return store;
}

test('marking one FHD stream bad does not poison other FHD streams with the same line-1 header', () => {
  installMockLocalStorage();
  const itemId = 'episode-1';
  const streamA = {
    Id: 'src-a',
    Name: '🚀 FHD\nShow.S01E01.1080p.WEB-DL.DDP5.1.H.264-GroupA.mkv\n⚡ RealDebrid | 1.8 GB',
  };
  const streamB = {
    Id: 'src-b',
    Name: '🚀 FHD\nShow.S01E01.1080p.AMZN.WEB-DL.DDP5.1.H.264-GroupB.mkv\n⚡ RealDebrid | 2.1 GB',
  };
  const streamASameReleaseNewId = {
    Id: 'src-a-refreshed',
    Name: '🚀 FHD\nShow.S01E01.1080p.WEB-DL.DDP5.1.H.264-GroupA.mkv\n⚡ RealDebrid | 1.8 GB',
  };

  markBadSource(itemId, streamA);

  assert.equal(isBadSource(itemId, streamA), true);
  assert.equal(isBadSource(itemId, streamB), false, 'other FHD streams must remain playable');
  assert.equal(isBadSource(itemId, streamASameReleaseNewId), true, 'same release with a refreshed Gelato ID is still recognized via lines 2+');
});

test('single-line source names only key by id and never by shared tier name', () => {
  installMockLocalStorage();
  const itemId = 'episode-2';
  const streamA = { Id: 'src-1', Name: '🚀 4K' };
  const streamB = { Id: 'src-2', Name: '🚀 4K' };

  markBadSource(itemId, streamA);

  assert.equal(isBadSource(itemId, streamA), true);
  assert.equal(isBadSource(itemId, streamB), false);
});

test('legacy name: entries are automatically purged from localStorage on load', () => {
  const future = Date.now() + 3600_000;
  const store = installMockLocalStorage({
    jellio_bad_streams: JSON.stringify({
      'episode-1': {
        'name:🚀 FHD': future,
        'name:🚀 4K': future,
        'id:src-bad': future,
      },
    }),
  });

  const healthyFhd = {
    Id: 'src-good',
    Name: '🚀 FHD\nShow.S01E01.1080p.WEB-DL.mkv',
  };
  const badById = {
    Id: 'src-bad',
    Name: '🚀 FHD\nShow.S01E01.1080p.Other.mkv',
  };

  assert.equal(isBadSource('episode-1', healthyFhd), false);
  assert.equal(isBadSource('episode-1', badById), true);

  const persisted = JSON.parse(store.get('jellio_bad_streams'));
  assert.equal('name:🚀 FHD' in (persisted['episode-1'] || {}), false);
  assert.equal('name:🚀 4K' in (persisted['episode-1'] || {}), false);
  assert.equal('id:src-bad' in (persisted['episode-1'] || {}), true);
});

test('looksLikePlaceholder flags short error clips under 3 minutes but never real episodes', () => {
  // 2-minute AIOStreams placeholder vs 45-minute episode
  assert.equal(looksLikePlaceholder(120, 45 * 60), true);
  // 24-minute episode vs inflated 120-minute catalog metadata must not be treated as placeholder
  assert.equal(looksLikePlaceholder(24 * 60, 120 * 60), false);
  // 5-minute clip is over the 180s placeholder cap
  assert.equal(looksLikePlaceholder(300, 60 * 60), false);
  // Short expected runtime (< 10 min) is never treated as placeholder
  assert.equal(looksLikePlaceholder(60, 5 * 60), false);
});
