import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PREVIEW_DELAY_MS,
  createFocusPreview,
  nextFocusIndex,
  pickRecommendations,
  similarSourceId,
} from '../../src/Jellio/Frontend/runtime/endScreenRecs.js';

test('asks Similar for the series of an episode and the item otherwise', () => {
  assert.equal(similarSourceId({ Type: 'Episode', Id: 'e', SeriesId: 's' }), 's');
  assert.equal(similarSourceId({ Type: 'Movie', Id: 'm' }), 'm');
  assert.equal(similarSourceId({ Type: 'Episode', Id: 'e' }), null);
  assert.equal(similarSourceId(null), null);
});

test('drops finished titles and the title itself, then caps the row', () => {
  const items = [
    { Id: 'a' },
    { Id: 'seen', UserData: { Played: true } },
    { Id: 'self' },
    { Id: 'show' },
    { Id: 'b', UserData: { Played: false } },
    { Id: 'c' },
  ];
  const picked = pickRecommendations(items, { Id: 'self', SeriesId: 'show' }, 2);
  assert.deepEqual(picked.map((i) => i.Id), ['a', 'b']);
  assert.deepEqual(pickRecommendations(null, null), []);
});

test('keeps a rewatched title that is only partly watched', () => {
  const rewatch = { Id: 'r', RunTimeTicks: 1000, UserData: { Played: true, PlaybackPositionTicks: 100 } };
  assert.equal(pickRecommendations([rewatch], { Id: 'x' }).length, 1);
});

test('focus index clamps at both ends', () => {
  assert.equal(nextFocusIndex(0, -1, 5), 0);
  assert.equal(nextFocusIndex(4, 1, 5), 4);
  assert.equal(nextFocusIndex(2, 1, 5), 3);
  assert.equal(nextFocusIndex(-1, 1, 5), 1);
  assert.equal(nextFocusIndex(0, 1, 0), -1);
});

function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout: (fn, ms) => {
      pending.set(nextId, { fn, at: now + ms });
      return nextId++;
    },
    clearTimeout: (id) => pending.delete(id),
    advance: (ms) => {
      now += ms;
      for (const [id, t] of [...pending]) {
        if (t.at <= now) {
          pending.delete(id);
          t.fn();
        }
      }
    },
  };
}

test('preview fires once after the delay on a steady focus', () => {
  const timers = fakeTimers();
  const fired = [];
  const preview = createFocusPreview((k) => fired.push(k), 0, timers);
  preview.focus('a');
  timers.advance(PREVIEW_DELAY_MS - 1);
  assert.deepEqual(fired, []);
  timers.advance(1);
  assert.deepEqual(fired, ['a']);
  timers.advance(PREVIEW_DELAY_MS * 2);
  assert.deepEqual(fired, ['a']);
});

test('moving focus restarts the wait and cancel drops it', () => {
  const timers = fakeTimers();
  const fired = [];
  const preview = createFocusPreview((k) => fired.push(k), 1000, timers);
  preview.focus('a');
  timers.advance(900);
  preview.focus('b');
  timers.advance(900);
  assert.deepEqual(fired, []);
  timers.advance(100);
  assert.deepEqual(fired, ['b']);
  preview.focus('c');
  preview.cancel();
  timers.advance(5000);
  assert.deepEqual(fired, ['b']);
});
