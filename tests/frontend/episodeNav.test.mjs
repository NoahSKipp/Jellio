import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSpecialsSeason,
  earlierSeasonIndexes,
  computeEpisodeNavState,
} from '../../src/Jellio/Frontend/runtime/episodeNav.js';
import { SKIP_PROMPT_SECONDS } from '../../src/Jellio/Frontend/runtime/skipSegments.js';

test('SKIP_PROMPT_SECONDS auto-dismisses skip prompt after 15 seconds', () => {
  assert.equal(SKIP_PROMPT_SECONDS, 15);
});

test('isSpecialsSeason detects season index 0', () => {
  assert.equal(isSpecialsSeason({ IndexNumber: 0 }), true);
  assert.equal(isSpecialsSeason({ IndexNumber: 1 }), false);
  assert.equal(isSpecialsSeason({ IndexNumber: 2 }), false);
  assert.equal(isSpecialsSeason(null), false);
  assert.equal(isSpecialsSeason({}), false);
});

test('earlierSeasonIndexes walks earlier non-special seasons nearest-first', () => {
  // Seasons: [Specials(0), S1(1), S2(2), S3(3)]
  const flags = [true, false, false, false];
  assert.deepEqual(earlierSeasonIndexes(flags, 3), [2, 1]);
  assert.deepEqual(earlierSeasonIndexes(flags, 2), [1]);
  assert.deepEqual(earlierSeasonIndexes(flags, 1), []);
});

test('earlierSeasonIndexes includes Specials only when starting in Specials', () => {
  // Seasons: [S1(1), Specials(0), S2(2)]
  const flags = [false, true, false];
  assert.deepEqual(earlierSeasonIndexes(flags, 2), [0]);
  assert.deepEqual(earlierSeasonIndexes(flags, 1), [0]);
  assert.deepEqual(earlierSeasonIndexes(flags, 0), []);
});

test('earlierSeasonIndexes handles invalid indexes and empty arrays', () => {
  assert.deepEqual(earlierSeasonIndexes([], 0), []);
  assert.deepEqual(earlierSeasonIndexes(null, 1), []);
  assert.deepEqual(earlierSeasonIndexes([false, false], -1), []);
  assert.deepEqual(earlierSeasonIndexes([false, false], 2), []);
});

test('computeEpisodeNavState gates previous and next buttons cleanly', () => {
  assert.deepEqual(
    computeEpisodeNavState({ isEpisode: true, blockedInGroup: false, hasPrevious: true, hasNext: true }),
    { showPrevious: true, showNext: true },
  );
  assert.deepEqual(
    computeEpisodeNavState({ isEpisode: true, blockedInGroup: false, hasPrevious: true, hasNext: false }),
    { showPrevious: true, showNext: false },
  );
  assert.deepEqual(
    computeEpisodeNavState({ isEpisode: true, blockedInGroup: true, hasPrevious: true, hasNext: true }),
    { showPrevious: false, showNext: false },
  );
  assert.deepEqual(
    computeEpisodeNavState({ isEpisode: false, blockedInGroup: true, hasPrevious: true, hasNext: true }),
    { showPrevious: false, showNext: false },
  );
  assert.deepEqual(
    computeEpisodeNavState({ isEpisode: false, blockedInGroup: false, hasPrevious: true, hasNext: true }),
    { showPrevious: false, showNext: false },
  );
});
