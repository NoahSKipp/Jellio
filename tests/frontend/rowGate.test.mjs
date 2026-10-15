import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRowGate } from '../../src/Jellio/Frontend/runtime/rowGate.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('runs at most the given number at once, top of the page first', async () => {
  const gate = createRowGate(2);
  const started = [];
  const releases = {};
  const job = (slot) => gate(slot, () => new Promise((resolve) => { started.push(slot); releases[slot] = resolve; }));
  [305, 301, 200, 303].forEach(job);
  await tick();
  assert.deepEqual(started, [305, 301], 'the first two go straight away');
  releases[305]();
  await tick();
  assert.deepEqual(started, [305, 301, 200], 'a catalog (200) goes before a later genre (303)');
});

test('opening the gate starts everything still waiting', async () => {
  const gate = createRowGate(1);
  const started = [];
  [1, 2, 3, 4].forEach((slot) => gate(slot, () => { started.push(slot); return new Promise(() => {}); }));
  await tick();
  assert.equal(started.length, 1);
  gate.open();
  await tick();
  assert.equal(started.length, 4);
});

test('a failed row load rejects only its own promise and frees its place', async () => {
  const gate = createRowGate(1);
  const failed = gate(1, () => Promise.reject(new Error('timeout')));
  const ok = gate(2, () => Promise.resolve('row'));
  await assert.rejects(failed, /timeout/);
  assert.equal(await ok, 'row');
});
