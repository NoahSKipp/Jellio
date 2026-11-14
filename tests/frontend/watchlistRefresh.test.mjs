import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WATCHLIST_POLL_INTERVAL_MS, watchlistIdsChanged } from '../../src/Jellio/Frontend/runtime/watchlistRefresh.js';

test('WATCHLIST_POLL_INTERVAL_MS matches the 20s poll interval', () => {
  assert.equal(WATCHLIST_POLL_INTERVAL_MS, 20000);
});

test('watchlistIdsChanged detects identical vs changed id lists', () => {
  assert.equal(watchlistIdsChanged([], []), false);
  assert.equal(watchlistIdsChanged(['a', 'b'], ['a', 'b']), false);
  assert.equal(watchlistIdsChanged(['a', 'b'], ['b', 'a']), true);
  assert.equal(watchlistIdsChanged(['a'], ['a', 'b']), true);
  assert.equal(watchlistIdsChanged(['a', 'b'], ['a']), true);
  assert.equal(watchlistIdsChanged(['a:1', 'b:0'], ['a:2', 'b:0']), true);
  assert.equal(watchlistIdsChanged(null, ['a']), true);
  assert.equal(watchlistIdsChanged(null, undefined), false);
});
