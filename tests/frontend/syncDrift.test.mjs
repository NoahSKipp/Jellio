// node --test tests/frontend
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncTargetTicks, syncDriftSeconds } from '../../src/Jellio/Frontend/runtime/syncDrift.js';

const TPS = 10000000;
// The command was sent 4 s ago.
const estimate = (ticks) => ticks + 4 * TPS;

test('a late Pause compares against the commanded position, not one extrapolated', () => {
  const pause = { Command: 'Pause', PositionTicks: 100 * TPS, When: new Date(0) };
  assert.equal(syncTargetTicks(pause, estimate), 100 * TPS);
  assert.equal(syncDriftSeconds(100.5 * TPS, pause, estimate, TPS), 0.5);
});

test('Unpause still moves the position on by the time since the command', () => {
  const unpause = { Command: 'Unpause', PositionTicks: 100 * TPS, When: new Date(0) };
  assert.equal(syncTargetTicks(unpause, estimate), 104 * TPS);
  assert.equal(syncDriftSeconds(100 * TPS, unpause, estimate, TPS), 4);
});

test('a command with no time or position falls back to what it says', () => {
  assert.equal(syncTargetTicks({ Command: 'Unpause', PositionTicks: 5 }, estimate), 5);
  assert.equal(syncTargetTicks(null, estimate), 0);
});
