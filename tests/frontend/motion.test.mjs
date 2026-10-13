import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMotionLevel } from '../../src/Jellio/Frontend/runtime/motionSettings.js';

test('auto follows the system reduced motion setting', () => {
  assert.equal(resolveMotionLevel('auto', false), 'full');
  assert.equal(resolveMotionLevel('auto', true), 'still');
});

test('a chosen level wins over the system setting', () => {
  for (const level of ['full', 'reduced', 'still', 'off']) {
    assert.equal(resolveMotionLevel(level, true), level);
    assert.equal(resolveMotionLevel(level, false), level);
  }
});

test('unknown values fall back to auto', () => {
  assert.equal(resolveMotionLevel('sparkly', false), 'full');
  assert.equal(resolveMotionLevel(null, true), 'still');
});
