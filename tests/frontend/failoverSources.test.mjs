// node --test tests/frontend
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFailoverSources, planFailover, failoverOutcome, describeFailover, errorKind, RETRY_TIMEOUT_MS } from '../../src/Jellio/Frontend/runtime/failoverSources.js';

const timeout = () => Object.assign(new Error('Request timed out: /Users/x/Items/y'), { timedOut: true });
const src = (Id, lang = 'ger') => ({ Id, lang });
const deps = (bad = {}) => ({
  isBad: (s) => bad[s.Id] || null,
  byLanguage: (list) => list,
  needsReencode: null,
});

test('a list that times out is tried again with a longer timeout', async () => {
  const timeouts = [];
  let calls = 0;
  const loaded = await loadFailoverSources({
    lastList: () => null,
    fetchSources: async (ms) => {
      timeouts.push(ms);
      if (++calls === 1) throw timeout();
      return [src('a'), src('b')];
    },
  });
  assert.equal(loaded.origin, 'retry');
  assert.deepEqual(timeouts, [undefined, RETRY_TIMEOUT_MS]);
  assert.equal(loaded.sources.length, 2);
  assert.equal(loaded.error.kind, 'timeout');
});

test('two timeouts fall back to the list loaded at the start, not an empty one', async () => {
  let clock = 1_000_000;
  const loaded = await loadFailoverSources({
    now: () => clock,
    lastList: () => ({ at: clock - 5 * 60_000, sources: [src('a'), src('b'), src('c')] }),
    fetchSources: async () => {
      clock += 10_000;
      throw timeout();
    },
  });
  assert.equal(loaded.origin, 'fallback');
  assert.equal(loaded.sources.length, 3);
  assert.deepEqual(loaded.error, { kind: 'timeout', ms: 20_000, recovered: false });
  const plan = planFailover(loaded.sources, ['a'], deps());
  assert.deepEqual(failoverOutcome(loaded, plan), { action: 'navigate', sourceId: 'b' });
});

test('nothing to fall back to says the list failed, not that there is no other stream', async () => {
  const loaded = await loadFailoverSources({ lastList: () => null, fetchSources: async () => { throw Object.assign(new Error('x'), { status: 503 }); } });
  assert.equal(loaded.origin, 'failed');
  const outcome = failoverOutcome(loaded, planFailover(loaded.sources, ['a'], deps()));
  assert.deepEqual(outcome, { action: 'list-failed', kind: 'server' });
});

test('a list under a minute old is used without asking the server', async () => {
  let fetched = 0;
  const loaded = await loadFailoverSources({
    now: () => 100_000,
    lastList: () => ({ at: 60_000, sources: [src('a')] }),
    fetchSources: async () => { fetched++; return []; },
  });
  assert.equal(loaded.origin, 'recent');
  assert.equal(fetched, 0);
});

test('every source tried or marked bad is the real end, with the counts that say why', async () => {
  const loaded = { sources: [src('a'), src('b'), src('c'), src('d')], origin: 'fresh', error: null };
  const plan = planFailover(loaded.sources, ['a'], deps({ b: 'hard', c: 'soft', d: 'hard' }));
  assert.deepEqual(plan.counts, { total: 4, tried: 1, badHard: 2, badSoft: 1, afterLanguage: 0, afterTranscode: 0 });
  assert.deepEqual(failoverOutcome(loaded, plan), { action: 'none-left' });
});

test('candidates left: goes to the first after the language and transcode rules', () => {
  const loaded = { sources: [src('a'), src('b', 'eng'), src('c'), src('d')], origin: 'fresh', error: null };
  const plan = planFailover(loaded.sources, ['a'], {
    isBad: () => null,
    byLanguage: (list) => list.filter((s) => s.lang === 'ger'),
    needsReencode: (s) => s.Id === 'c',
    blockReencode: false,
  });
  assert.deepEqual(plan.ordered.map((s) => s.Id), ['d', 'c']);
  assert.equal(plan.counts.afterLanguage, 2);
  assert.deepEqual(failoverOutcome(loaded, plan), { action: 'navigate', sourceId: 'd' });
});

test('the decision line carries counts and ids only', () => {
  const line = describeFailover({
    reason: 'no picture after 25s',
    counts: { total: 39, tried: 3, badHard: 2, badSoft: 1, afterLanguage: 20, afterTranscode: 18 },
    loaded: { origin: 'retry', error: { kind: 'timeout', ms: 10_012 } },
    outcome: { action: 'navigate', sourceId: 'abc' },
  });
  assert.match(line, /sources 39, tried 3, bad 2 hard \/ 1 soft, after language 20, after transcode rule 18; list retry \(timeout after 10012 ms\); next abc/);
  assert.doesNotMatch(line, /https?:|api_key|token/i);
});

test('error kinds', () => {
  assert.equal(errorKind(timeout()), 'timeout');
  assert.equal(errorKind(Object.assign(new Error('x'), { status: 502 })), 'server');
  assert.equal(errorKind(new TypeError('Failed to fetch')), 'network');
});
