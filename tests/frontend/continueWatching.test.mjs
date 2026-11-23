import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withoutStaleEpisodes, isPartlyWatched, isFinished, recentlyPlayedFirst } from '../../src/Jellio/Frontend/runtime/continueWatching.js';

const ep = (id, season, num, extra) => Object.assign({ Id: id, SeriesId: 's1', ParentIndexNumber: season, IndexNumber: num }, extra || {});

test('drops titles already marked watched', () => {
  const items = [ep('a', 1, 3, { UserData: { Played: true } }), { Id: 'm', UserData: { Played: false } }];
  assert.deepEqual(withoutStaleEpisodes(items, []).map((i) => i.Id), ['m']);
});

test('drops episodes the show has moved past in Next Up', () => {
  const resume = [ep('old', 1, 2), ep('cur', 2, 1)];
  assert.deepEqual(withoutStaleEpisodes(resume, [ep('next', 1, 5)]).map((i) => i.Id), ['cur']);
});

test('keeps episodes of shows without a Next Up entry', () => {
  assert.deepEqual(withoutStaleEpisodes([ep('x', 1, 2)], []).map((i) => i.Id), ['x']);
});

const HOUR = 36000000000;
const played = (id, season, num, position) =>
  ep(id, season, num, { RunTimeTicks: HOUR, UserData: { Played: true, PlaybackPositionTicks: position } });

test('keeps a rewatched episode that is played but partly watched', () => {
  const rewatch = played('r', 22, 7, HOUR * 0.27);
  assert.equal(isPartlyWatched(rewatch), true);
  assert.equal(isFinished(rewatch), false);
  assert.deepEqual(withoutStaleEpisodes([rewatch], []).map((i) => i.Id), ['r']);
});

test('still drops a played episode that is nearly finished', () => {
  const done = played('d', 1, 3, HOUR * 0.99);
  assert.equal(isFinished(done), true);
  assert.deepEqual(withoutStaleEpisodes([done], []), []);
});

test('still drops an episode behind Next Up when it was only part watched', () => {
  const stale = ep('old', 1, 2, { RunTimeTicks: HOUR, UserData: { Played: false, PlaybackPositionTicks: HOUR / 2 } });
  assert.deepEqual(withoutStaleEpisodes([stale], [ep('next', 1, 4)]), []);
});

test('an unknown runtime trusts the saved position', () => {
  const item = ep('u', 1, 3, { UserData: { Played: true, PlaybackPositionTicks: 1000 } });
  assert.equal(isPartlyWatched(item), true);
});

test('most recently played comes first and undated items go last', () => {
  const dated = (id, date) => ({ Id: id, UserData: date ? { LastPlayedDate: date } : {} });
  const sorted = recentlyPlayedFirst([dated('old', '2026-11-01T10:00:00.0000000Z'), dated('none'), dated('new', '2026-11-22T20:00:00.0000000Z')]);
  assert.deepEqual(sorted.map((i) => i.Id), ['new', 'old', 'none']);
});

test('equal dates keep the server order', () => {
  const same = (id) => ({ Id: id, UserData: { LastPlayedDate: '2026-11-22T20:00:00.0000000Z' } });
  assert.deepEqual(recentlyPlayedFirst([same('a'), same('b'), same('c')]).map((i) => i.Id), ['a', 'b', 'c']);
});
