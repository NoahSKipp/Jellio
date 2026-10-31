import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitTimestamps,
  formatClock,
  clockSkewMs,
  countdownSecondsLeft,
  readyCount,
  partyProgress,
  partyTitle,
} from '../../src/Jellio/Frontend/runtime/parties.js';

test('finds timestamps in chat and leaves other numbers alone', () => {
  assert.deepEqual(splitTimestamps('look at 12:31 lol'), [{ text: 'look at ' }, { text: '12:31', seconds: 751 }, { text: ' lol' }]);
  assert.deepEqual(splitTimestamps('1:02:03'), [{ text: '1:02:03', seconds: 3723 }]);
  assert.deepEqual(splitTimestamps('score was 3-1, 10.5 min'), [{ text: 'score was 3-1, 10.5 min' }]);
  assert.deepEqual(splitTimestamps('12:61 is not a time'), [{ text: '12:61 is not a time' }]);
  assert.equal(splitTimestamps('back to 0:45 and 2:10').filter((p) => p.seconds != null).length, 2);
});

test('formats clocks', () => {
  assert.equal(formatClock(75), '1:15');
  assert.equal(formatClock(3723), '1:02:03');
  assert.equal(formatClock(-5), '0:00');
});

test('countdown uses the server clock', () => {
  const now = 1_000_000;
  const skew = clockSkewMs(new Date(now + 2000).toISOString(), now);
  assert.equal(skew, 2000);
  assert.equal(countdownSecondsLeft(new Date(now + 2000 + 3000).toISOString(), skew, now), 3);
  assert.equal(countdownSecondsLeft('nope', 0, now), null);
});

test('ready check counts only this title', () => {
  const state = { Ready: [{ PlaylistItemId: 'a' }, { PlaylistItemId: 'a' }, { PlaylistItemId: 'old' }] };
  assert.deepEqual(readyCount(state, 'a', 3), { ready: 2, total: 3, all: false });
  assert.deepEqual(readyCount(state, 'a', 2), { ready: 2, total: 2, all: true });
  assert.equal(readyCount(null, 'a', 0).all, false);
});

test('cards describe their title and progress', () => {
  assert.equal(partyTitle({ Type: 'Episode', SeriesName: 'Severance', SeasonNumber: 2, EpisodeNumber: 3, Name: 'x' }), 'Severance · S2 E3');
  assert.equal(partyTitle({ Type: 'Movie', Name: 'Dune' }), 'Dune');
  assert.equal(partyProgress({ Item: { RunTimeTicks: 100 }, PositionTicks: 25 }), 0.25);
  assert.equal(partyProgress({ Item: { RunTimeTicks: 100 }, PositionTicks: null }), null);
});
