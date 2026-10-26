import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withoutStaleEpisodes } from '../../src/Jellio/Frontend/runtime/continueWatching.js';

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
