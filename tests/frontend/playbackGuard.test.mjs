import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || globalThis;

const guard = await import('../../src/Jellio/Frontend/runtime/playbackGuard.js');

test('no progress after stopped until started again', () => {
  assert.equal(guard.canReportProgress('a', 'm'), true);
  guard.markPlaybackStopped('a', 'm');
  assert.equal(guard.canReportProgress('a', 'm'), false);
  assert.equal(guard.canReportProgress('b', 'm'), true);
  guard.markPlaybackStarted('a', 'm');
  assert.equal(guard.canReportProgress('a', 'm'), true);
});

test('pause gate reports once, stays quiet, then stops once', () => {
  const gate = guard.createPauseGate(1000);
  assert.equal(gate.tick(false, 0), 'progress');
  assert.equal(gate.tick(true, 100), 'progress');
  assert.equal(gate.tick(true, 600), 'skip');
  assert.equal(gate.tick(true, 1100), 'stop');
  assert.equal(gate.tick(true, 5000), 'skip');
  assert.equal(gate.tick(true, 99999), 'skip');
  assert.equal(gate.tick(false, 100000), 'progress');
  assert.equal(gate.tick(true, 100100), 'progress');
});

test('only one progress timer runs at a time', () => {
  let a = 0;
  let b = 0;
  const first = guard.startProgressTimer(() => { a++; }, 5);
  const second = guard.startProgressTimer(() => { b++; }, 5);
  return new Promise((resolve) => {
    setTimeout(() => {
      guard.stopProgressTimer(second);
      assert.equal(a, 0);
      assert.ok(b > 0);
      assert.notEqual(first, second);
      resolve();
    }, 40);
  });
});
