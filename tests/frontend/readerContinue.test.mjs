import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dismissalMarker, isContinueDismissed, latestRead, withoutHiddenContinue } from '../../src/Jellio/Frontend/runtime/readerContinue.js';

const book = (id) => ({ Id: id, Type: 'Book' });
const chapter = (id, series, at) => ({ Id: id, Type: 'Book', series: series, JellioUpdatedAt: at });
const itemKey = (item) => 'i:' + item.Id;
const seriesKey = (item) => (item.series ? 's:' + item.series : '');

test('a dismissal is stored under the last read time, or a dash when never read', () => {
  assert.equal(dismissalMarker('2026-01-02T03:04:05+00:00'), '2026-01-02T03:04:05+00:00');
  assert.equal(dismissalMarker(null), '-');
  assert.equal(dismissalMarker(''), '-');
});

test('a series is dismissed while its stored marker equals its last read marker', () => {
  const prefs = { 's:berserk': { ContinueDismissedAt: '2026-01-02T03:04:05+00:00' }, 's:vagabond': { ContinueDismissedAt: '-' } };
  assert.equal(isContinueDismissed(prefs, 's:berserk', '2026-01-02T03:04:05+00:00'), true);
  assert.equal(isContinueDismissed(prefs, 's:berserk', '2026-02-01T00:00:00+00:00'), false);
  assert.equal(isContinueDismissed(prefs, 's:vagabond', null), true);
  assert.equal(isContinueDismissed(prefs, 's:vagabond', '2026-02-01T00:00:00+00:00'), false);
  assert.equal(isContinueDismissed(prefs, 's:other', null), false);
  assert.equal(isContinueDismissed(undefined, 's:berserk', null), false);
});

test('the newest read time is returned as it was stored', () => {
  assert.equal(latestRead(['2026-01-01T00:00:00Z', undefined, '2026-03-01T00:00:00Z', '2026-02-01T00:00:00Z']), '2026-03-01T00:00:00Z');
  assert.equal(latestRead([]), null);
  assert.equal(latestRead(undefined), null);
});

test('books removed from the library leave Continue reading', () => {
  const shelf = { LibraryRemoved: ['i:verity'] };
  const kept = withoutHiddenContinue([book('verity'), book('ethics')], shelf, seriesKey, itemKey);
  assert.deepEqual(kept.map((item) => item.Id), ['ethics']);
});

test('chapters of a removed or dismissed series leave Continue reading until read again', () => {
  const items = [chapter('a', 'berserk', '2026-01-02T00:00:00Z'), chapter('b', 'berserk', '2026-01-01T00:00:00Z'), chapter('c', 'vagabond', '2026-01-05T00:00:00Z'), book('d')];
  const ids = (shelf) => withoutHiddenContinue(items, shelf, seriesKey, itemKey).map((item) => item.Id);
  assert.deepEqual(ids({}), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids({ LibraryRemoved: ['s:berserk'] }), ['c', 'd']);
  assert.deepEqual(ids({ Series: { 's:berserk': { ContinueDismissedAt: '2026-01-02T00:00:00Z' } } }), ['c', 'd']);
  assert.deepEqual(ids({ Series: { 's:berserk': { ContinueDismissedAt: '2026-01-01T00:00:00Z' } } }), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids({ Series: { 's:berserk': { ContinueDismissedAt: '-' } } }), ['a', 'b', 'c', 'd']);
});
