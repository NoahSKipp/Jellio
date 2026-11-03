// node --test tests/frontend
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preferReadySource, alreadyWarmIds, normalizeId } from '../../src/Jellio/Frontend/runtime/readySources.js';
import { createStreamWarmup, createSearchWarmer } from '../../src/Jellio/Frontend/runtime/streamWarmup.js';

const src = (Id, tier, ready, rank = 0) => ({ Id, tier, ready, rank });
const pick = (list) =>
  preferReadySource(list, (s) => s.ready, (s) => s.tier, (s) => s.rank).map((s) => s.Id);

test('a ready source of the same tier goes first', () => {
  assert.deepEqual(pick([src('a', '2160p-hdr', false), src('b', '1080p-sdr', true), src('c', '2160p-hdr', true)]), ['c', 'a', 'b']);
});

test('never swaps across tiers: a ready 720p does not replace a 4K', () => {
  assert.deepEqual(pick([src('a', '2160p-sdr', false), src('b', '720p-sdr', true)]), ['a', 'b']);
});

test('no swap when the leader is ready, its tier unknown, or the ready one ranks worse', () => {
  assert.deepEqual(pick([src('a', '1080p-sdr', true), src('b', '1080p-sdr', true)]), ['a', 'b']);
  assert.deepEqual(pick([src('a', 'unknown', false), src('b', 'unknown', true)]), ['a', 'b']);
  assert.deepEqual(pick([src('a', '1080p-sdr', false, 0), src('b', '1080p-sdr', true, 2)]), ['a', 'b']);
});

test('already-warm ids from the server are normalised and skipped by the queue', async () => {
  const warm = alreadyWarmIds({ Queued: [], AlreadyWarm: ['0A1B2C3D-0000-0000-0000-000000000001'] });
  assert.deepEqual(warm, ['0a1b2c3d000000000000000000000001']);
  assert.deepEqual(alreadyWarmIds({ alreadyWarm: ['abc'] }), ['abc']);
  assert.deepEqual(alreadyWarmIds(null), []);
  const calls = [];
  const queue = createStreamWarmup({ prefetch: async (id) => { calls.push(id); }, canWarm: () => true, wait: async () => {} });
  queue.markWarm(warm);
  await queue.add([normalizeId('0a1b2c3d-0000-0000-0000-000000000001'), 'other']);
  assert.deepEqual(calls, ['other']);
});

function fakeTimers() {
  let now = 0;
  let next = 1;
  const timers = new Map();
  return {
    schedule: (fn, ms) => { const id = next++; timers.set(id, { at: now + ms, fn }); return id; },
    cancel: (id) => { timers.delete(id); },
    advance(ms) {
      now += ms;
      [...timers.entries()].sort((a, b) => a[1].at - b[1].at).forEach(([id, timer]) => {
        if (timer.at <= now && timers.has(id)) { timers.delete(id); timer.fn(); }
      });
    },
  };
}

test('search warms once results have stood still for the settle time', () => {
  const clock = fakeTimers();
  const settled = [];
  const warmer = createSearchWarmer({ ...clock, settleMs: 600, onSettled: (items) => settled.push(items), onFocused: () => {} });
  warmer.query();
  warmer.results(['a']);
  clock.advance(400);
  warmer.results(['a', 'b']);
  clock.advance(400);
  assert.deepEqual(settled, []);
  clock.advance(250);
  assert.deepEqual(settled, [['a', 'b']]);
});

test('a new query cancels pending warm-ups and tells the queue', () => {
  const clock = fakeTimers();
  const settled = [];
  const focused = [];
  let cancelled = 0;
  const warmer = createSearchWarmer({
    ...clock,
    settleMs: 600,
    focusMs: 400,
    onQueryChanged: () => { cancelled++; },
    onSettled: (items) => settled.push(items),
    onFocused: (id) => focused.push(id),
  });
  warmer.results(['old']);
  warmer.focus('old-card');
  clock.advance(300);
  warmer.query();
  clock.advance(1000);
  assert.deepEqual(settled, []);
  assert.deepEqual(focused, []);
  assert.equal(cancelled, 1);
});

test('focus warms after the focus time, blur before it does not', () => {
  const clock = fakeTimers();
  const focused = [];
  const warmer = createSearchWarmer({ ...clock, focusMs: 400, onSettled: () => {}, onFocused: (id) => focused.push(id) });
  warmer.focus('a');
  clock.advance(300);
  warmer.blur();
  clock.advance(500);
  warmer.focus('b');
  clock.advance(450);
  assert.deepEqual(focused, ['b']);
});

test('jobs of a cancelled group never run', async () => {
  const ran = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const queue = createStreamWarmup({ prefetch: async () => {}, canWarm: () => true, wait: async () => {} });
  const first = queue.addJob({ key: 'first', run: () => gate.then(() => ran.push('first')) });
  queue.addJob({ key: 'search-1', group: 'search', run: async () => { ran.push('search-1'); } });
  queue.cancelGroup('search');
  release();
  await first;
  assert.deepEqual(ran, ['first']);
});
