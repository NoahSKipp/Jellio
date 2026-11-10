import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || { localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, addEventListener: () => {} };

const { formatClock, formatTicksClock, formatBytes, formatFileSize, formatRuntime } = await import('../../src/Jellio/Frontend/runtime/format.js');

// The copies these replaced, kept to check the shared one prints the same.
function playerFormatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n) => (n < 10 ? '0' + n : String(n));
  return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
}
function audioFormatClock(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
}
function pickerResumeLabel(ticks) {
  const totalSeconds = Math.floor(ticks / 10000000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const ss = String(totalSeconds % 60).padStart(2, '0');
  if (hours > 0) return hours + ':' + String(minutes).padStart(2, '0') + ':' + ss;
  return minutes + ':' + ss;
}

test('formatClock prints like every copy it replaced', () => {
  const samples = [0, 0.4, 1, 9, 59.9, 60, 61, 599, 3599.99, 3600, 3661, 36000, 86399, 100000.5, -3, null];
  for (const value of samples) {
    assert.equal(formatClock(value), playerFormatTime(value), 'player ' + value);
    assert.equal(formatClock(value), audioFormatClock(value), 'audio ' + value);
  }
  assert.equal(formatClock(75), '1:15');
  assert.equal(formatClock(3723), '1:02:03');
  assert.equal(formatClock(-5), '0:00');
  assert.equal(formatClock(NaN), '0:00');
  assert.equal(formatClock(Infinity), '0:00');
});

test('formatTicksClock matches the stream picker resume label', () => {
  for (const ticks of [1, 10000000, 615000000, 36610000000, 123456789012]) {
    assert.equal(formatTicksClock(ticks), pickerResumeLabel(ticks));
  }
});

test('formatBytes and formatFileSize keep their own styles', () => {
  assert.equal(formatBytes(0), '0 MB');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '2 KB');
  assert.equal(formatBytes(3.4 * 1024 ** 3), '3.4 GB');
  assert.equal(formatBytes(12 * 1024 ** 3), '12 GB');
  assert.equal(formatFileSize(0), '');
  assert.equal(formatFileSize(1000), '');
  assert.equal(formatFileSize(700 * 1024 ** 2), '700 MB');
  assert.equal(formatFileSize(2.34 * 1024 ** 3), '2.3 GB');
});

test('formatRuntime prints hours and minutes, never 0m', () => {
  assert.equal(formatRuntime(0), '');
  assert.equal(formatRuntime(100), '');
  assert.equal(formatRuntime(45 * 600000000), '45m');
  assert.equal(formatRuntime(125 * 600000000), '2h 5m');
});
