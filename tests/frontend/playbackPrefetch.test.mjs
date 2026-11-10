// node --test tests/frontend
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPlaybackCache,
  createDwellPrefetch,
  pickPlaySource,
  playbackKey,
  negotiationFits,
} from '../../src/Jellio/Frontend/runtime/playbackPrefetch.js';

function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map();
  return {
    now: () => now,
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

test('keys ignore id case and dashes', () => {
  assert.equal(playbackKey('AB-CD', 'Src-1', 50), playbackKey('abcd', 'src1', '50'));
  assert.notEqual(playbackKey('abcd', 'src1', 0), playbackKey('abcd', 'src1', 10));
});

test('an entry is taken once, by item, source and start position, within its lifetime', () => {
  const clock = fakeClock();
  const cache = createPlaybackCache({ ttlMs: 45000, now: clock.now });
  assert.equal(cache.put('a', 's1', 0, { promise: 1 }), true);
  assert.equal(cache.put('a', 's1', 0, { promise: 2 }), false);
  assert.equal(cache.take('a', 's1', 100), null);
  assert.equal(cache.take('a', 's2', 0), null);
  assert.deepEqual(cache.take('a', 's1', 0), { promise: 1 });
  assert.equal(cache.take('a', 's1', 0), null);

  cache.put('a', 's1', 0, { promise: 3 });
  clock.advance(45001);
  assert.equal(cache.take('a', 's1', 0), null);
  assert.equal(cache.size, 0);
});

test('a request made without a source serves a play that names one', () => {
  const cache = createPlaybackCache({ ttlMs: 1000, now: () => 0 });
  cache.put('a', null, 0, { promise: 'any' });
  assert.deepEqual(cache.take('a', 's1', 0), { promise: 'any' });
});

test('drop clears a title, has reports it', () => {
  const cache = createPlaybackCache({ ttlMs: 1000, now: () => 0 });
  cache.put('a', 's1', 0, {});
  cache.put('a', 's2', 0, {});
  cache.put('b', 's1', 0, {});
  assert.equal(cache.has('A'), true);
  cache.drop('a');
  assert.equal(cache.has('a'), false);
  assert.equal(cache.size, 1);
});

test('the dwell runs after a second of rest, once per title per window', () => {
  const clock = fakeClock();
  const runs = [];
  const dwell = createDwellPrefetch({ ...clock, delayMs: 1000, windowMs: 45000, run: (id) => runs.push(id) });
  dwell.start('a');
  clock.advance(600);
  dwell.stop();
  clock.advance(1000);
  assert.deepEqual(runs, []);
  dwell.start('a');
  clock.advance(1000);
  assert.deepEqual(runs, ['a']);
  dwell.start('a');
  clock.advance(2000);
  assert.deepEqual(runs, ['a']);
  dwell.start('b');
  clock.advance(1000);
  assert.deepEqual(runs, ['a', 'b']);
  clock.advance(45000);
  dwell.start('a');
  clock.advance(1000);
  assert.deepEqual(runs, ['a', 'b', 'a']);
});

test('a new rest replaces the one waiting', () => {
  const clock = fakeClock();
  const runs = [];
  const dwell = createDwellPrefetch({ ...clock, delayMs: 1000, run: (id) => runs.push(id) });
  dwell.start('a');
  clock.advance(500);
  dwell.start('b');
  clock.advance(1000);
  assert.deepEqual(runs, ['b']);
});

const S = (Id, tier, lang) => ({ Id, tier, lang });

test('pick: remembered first, unless it failed lately', () => {
  const list = [S('a', '1080p'), S('b', '1080p')];
  assert.equal(pickPlaySource(list, { rememberedId: 'b' }).Id, 'b');
  assert.equal(pickPlaySource(list, { rememberedId: 'b', isBad: (s) => s.Id === 'b' }).Id, 'a');
});

test('pick: failed sources last, language, then a Ready one of the same tier', () => {
  const list = [S('a', '2160p', 'en'), S('b', '2160p', 'de'), S('c', '2160p', 'de'), S('d', '720p', 'de')];
  const byLanguage = (want) => (sources) => sources.filter((s) => s.lang === want);
  assert.equal(pickPlaySource(list, {}).Id, 'a');
  assert.equal(pickPlaySource(list, { isBad: (s) => s.Id === 'a' }).Id, 'b');
  assert.equal(pickPlaySource(list, { byLanguage: byLanguage('de') }).Id, 'b');
  const ready = new Set(['c', 'd']);
  const opts = { byLanguage: byLanguage('de'), preferReady: true, isReady: (s) => ready.has(s.Id), tierOf: (s) => s.tier };
  assert.equal(pickPlaySource(list, opts).Id, 'c');
  assert.equal(pickPlaySource([S('a', '2160p'), S('d', '720p')], { ...opts, byLanguage: null }).Id, 'a');
  assert.equal(pickPlaySource(list, { byLanguage: byLanguage('fr') }).Id, 'a');
  assert.equal(pickPlaySource([], {}), null);
  assert.equal(pickPlaySource([S('x')], { isBad: () => true }).Id, 'x');
});

test('a negotiation fits when it has the stream asked for', () => {
  assert.equal(negotiationFits({ MediaSources: [{ Id: 'a' }] }, 'a'), true);
  assert.equal(negotiationFits({ MediaSources: [{ Id: 'a' }] }, null), true);
  assert.equal(negotiationFits({ MediaSources: [{ Id: 'a' }] }, 'b'), false);
  assert.equal(negotiationFits({ MediaSources: [] }, null), false);
  assert.equal(negotiationFits(null, 'a'), false);
});
