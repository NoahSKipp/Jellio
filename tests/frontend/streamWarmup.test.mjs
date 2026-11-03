// node --test tests/frontend
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldWarmStreams, pickWarmupItems, createStreamWarmup } from '../../src/Jellio/Frontend/runtime/streamWarmup.js';

test('only warms on a visible page without data saver or mobile data', () => {
  assert.equal(shouldWarmStreams('visible', null), true);
  assert.equal(shouldWarmStreams('visible', { effectiveType: '4g' }), true);
  assert.equal(shouldWarmStreams('hidden', null), false);
  assert.equal(shouldWarmStreams('visible', { saveData: true }), false);
  assert.equal(shouldWarmStreams('visible', { type: 'cellular' }), false);
  assert.equal(shouldWarmStreams('visible', { effectiveType: '2g' }), false);
});

test('takes Continue Watching and Next Up in turn, six at most, no repeats or books', () => {
  const resume = ['a', 'b', 'c', 'd', 'e'].map((Id) => ({ Id, Type: 'Episode' }));
  const nextUp = [{ Id: 'b', Type: 'Episode' }, { Id: 'x', Type: 'Episode' }, { Id: 'y', Type: 'Episode' }];
  assert.deepEqual(pickWarmupItems([resume, nextUp], 6), ['a', 'b', 'x', 'c', 'y', 'd']);
  assert.deepEqual(pickWarmupItems([[{ Id: 'k', Type: 'Book' }, { Id: 'm', Type: 'Movie' }], null], 6), ['m']);
});

test('warms one at a time with a gap, front-loads the hero, never twice', async () => {
  const calls = [];
  const waits = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const warmup = createStreamWarmup({
    prefetch: async (id) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      calls.push(id);
      await Promise.resolve();
      inFlight--;
    },
    canWarm: () => true,
    wait: async (ms) => { waits.push(ms); },
  });
  const first = warmup.add(['a', 'b', 'c']);
  warmup.add(['hero'], true);
  await first;
  assert.equal(maxInFlight, 1);
  assert.deepEqual(calls, ['a', 'hero', 'b', 'c']);
  assert.ok(waits.length >= 3 && waits.every((ms) => ms === 1500));
  await warmup.add(['a', 'c']);
  assert.deepEqual(calls, ['a', 'hero', 'b', 'c']);
});

test('stops while the page is hidden and carries on when it is back', async () => {
  let visible = false;
  const calls = [];
  const warmup = createStreamWarmup({ prefetch: async (id) => { calls.push(id); }, canWarm: () => visible, wait: async () => {} });
  await warmup.add(['a', 'b']);
  assert.deepEqual(calls, []);
  assert.deepEqual(warmup.pending(), ['a', 'b']);
  visible = true;
  await warmup.resume();
  assert.deepEqual(calls, ['a', 'b']);
});
