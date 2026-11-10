// node --test tests/frontend
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startBufferTarget } from '../../src/Jellio/Frontend/runtime/bufferSettings.js';

const standard = { startSeconds: 8, startTimeoutMs: 12000 };
const more = { startSeconds: 20, startTimeoutMs: 30000 };

test('cold or transcoded streams keep the 8 s start on Standard', () => {
  assert.deepEqual(startBufferTarget(standard, {}), { targetSeconds: 8, timeoutMs: 12000, acceptReadyState: true });
  assert.deepEqual(startBufferTarget(standard, { ready: true, transcoded: true }), { targetSeconds: 8, timeoutMs: 12000, acceptReadyState: true });
  assert.deepEqual(startBufferTarget(standard, { localFile: true, transcoded: true }).targetSeconds, 8);
});

test('a Ready stream or a local file played as is starts at 2 s', () => {
  assert.deepEqual(startBufferTarget(standard, { ready: true }), { targetSeconds: 2, timeoutMs: 5000, acceptReadyState: true });
  assert.deepEqual(startBufferTarget(standard, { localFile: true }), { targetSeconds: 2, timeoutMs: 5000, acceptReadyState: true });
});

test('a stream confirmed cached starts at 1 s, transcoded or not', () => {
  assert.equal(startBufferTarget(standard, { confirmedCached: true }).targetSeconds, 1);
  assert.equal(startBufferTarget(standard, { confirmedCached: true, transcoded: true }).timeoutMs, 2500);
});

test('a raised level always wins and needs the seconds actually buffered', () => {
  assert.deepEqual(startBufferTarget(more, { ready: true, confirmedCached: true }), { targetSeconds: 20, timeoutMs: 30000, acceptReadyState: false });
  assert.equal(startBufferTarget(null, {}).targetSeconds, 8);
});
