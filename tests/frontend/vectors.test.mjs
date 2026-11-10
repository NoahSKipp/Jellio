// Shared web/TV test vectors (tests/vectors/*.json), run against the web
// functions. The TV app runs the same files from its own copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeLanguage, preferredStreamLanguage, orderByLanguage } from '../../src/Jellio/Frontend/runtime/streamLanguage.js';
import { isUnreleasedItem, isReleasedToday, markTodayItemHasStream, clearVerifiedTodayStreamIds } from '../../src/Jellio/Frontend/runtime/releaseDate.js';
import { looksLikePlaceholder, looksLikeSilentSlideshow, stoppedTooEarly, markBadSource, unmarkBadSource, badSourceKind } from '../../src/Jellio/Frontend/runtime/streamHealth.js';
import { planFailover, failoverOutcome } from '../../src/Jellio/Frontend/runtime/failoverSources.js';
import { mergeSkipSegments, activeSkipSegment, shouldShowUpNextNow, chapterFallbackSegments } from '../../src/Jellio/Frontend/runtime/skipSegments.js';
import { syncTargetTicks, syncDriftSeconds } from '../../src/Jellio/Frontend/runtime/syncDrift.js';

const VECTORS_DIR = join(import.meta.dirname, '../vectors');
const TICKS_PER_SECOND = 10000000;
const TICKS_PER_MS = 10000;

const store = new Map();
globalThis.window = globalThis.window || {};
globalThis.window.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};

function withNow(ms, fn) {
  const real = Date.now;
  Date.now = () => ms;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

function toSource(source) {
  return { Id: source.id, Name: source.name };
}

function toSegments(segments) {
  if (!segments) return null;
  const range = (r) => (r ? { Start: r.start, End: r.end } : { Start: 0, End: 0 });
  return { Introduction: range(segments.intro), Credits: range(segments.credits) };
}

function fromSegments(segments) {
  if (!segments) return null;
  const range = (r) => (r && r.End > 0 && r.End > r.Start ? { start: r.Start, end: r.End } : null);
  return { intro: range(segments.Introduction), credits: range(segments.Credits) };
}

const runners = {
  normalize: (input) => normalizeLanguage(input.code),
  preferred: (input) => preferredStreamLanguage(input.audioPreference, input.displayLanguage),
  order: (input) => orderByLanguage(input.sources, input.language, (s) => s.languages).map((s) => s.id),

  releaseState: (input) => {
    clearVerifiedTodayStreamIds();
    (input.verifiedToday || []).forEach((id) => markTodayItemHasStream(id, true));
    const now = Date.parse(input.now);
    const result = { unreleased: isUnreleasedItem(input.item, now), releasedToday: isReleasedToday(input.item, now) };
    clearVerifiedTodayStreamIds();
    return result;
  },

  looksLikePlaceholder: (input) => looksLikePlaceholder(input.actualMs / 1000, input.expectedMs / 1000),
  silentSlideshow: (input) => looksLikeSilentSlideshow(input.frames, input.seconds, input.noAudio, input.expectedMs / 1000),
  stoppedTooEarly: (input) => stoppedTooEarly(input.positionMs / 1000, input.expectedMs / 1000),

  badKind: (input) => {
    store.clear();
    input.ops.forEach((op) => withNow(op.atMs, () => {
      if (op.op === 'mark') markBadSource(op.itemId, toSource(op.source), { soft: op.soft });
      else unmarkBadSource(op.itemId, toSource(op.source));
    }));
    return withNow(input.query.atMs, () => badSourceKind(input.query.itemId, toSource(input.query.source)));
  },
  planFailover: (input) => {
    const sources = input.sources.map((s) => ({ Id: s.id, source: s }));
    const plan = planFailover(sources, input.tried, {
      isBad: (s) => s.source.bad,
      byLanguage: (list) => orderByLanguage(list, input.language, (s) => s.source.languages),
      needsReencode: input.avoidReencode ? (s) => s.source.reencode : null,
      blockReencode: input.blockReencode,
    });
    return { ordered: plan.ordered.map((s) => s.Id), counts: plan.counts };
  },
  failoverOutcome: (input) => {
    const loaded = { origin: input.origin, error: input.errorKind ? { kind: input.errorKind } : null };
    return failoverOutcome(loaded, { ordered: input.ordered.map((id) => ({ Id: id })) });
  },

  activeSegment: (input) => {
    const active = activeSkipSegment(toSegments(input.segments), input.positionSeconds);
    return active ? { kind: active.kind, targetSeconds: active.target } : null;
  },
  upNextNow: (input) => shouldShowUpNextNow(toSegments(input.segments), input.positionSeconds, input.durationSeconds),
  merge: (input) => fromSegments(mergeSkipSegments(toSegments(input.current), toSegments(input.candidate), input.runtimeSeconds)),
  chapters: (input) => {
    const chapters = input.chapters.map((c) => ({ Name: c.name, StartPositionTicks: c.startSeconds * TICKS_PER_SECOND }));
    return fromSegments(chapterFallbackSegments(chapters, input.runtimeSeconds * TICKS_PER_SECOND, TICKS_PER_SECOND));
  },

  drift: (input) => {
    const command = {
      Command: input.command,
      PositionTicks: input.positionMs == null ? undefined : input.positionMs * TICKS_PER_MS,
      When: 'set',
    };
    const estimate = (ticks) => ticks + input.sinceCommandMs * TICKS_PER_MS;
    const target = syncTargetTicks(command, estimate);
    const drift = syncDriftSeconds(input.currentMs * TICKS_PER_MS, command, estimate, TICKS_PER_SECOND);
    return { targetMs: target == null ? null : target / TICKS_PER_MS, driftMs: Math.round(drift * 1000) };
  },
};

const files = readdirSync(VECTORS_DIR).filter((f) => f.endsWith('.json')).sort();

test('vector files carry a family, a version and cases', () => {
  assert.ok(files.length > 0);
  for (const file of files) {
    const data = JSON.parse(readFileSync(join(VECTORS_DIR, file), 'utf8'));
    assert.equal(typeof data.family, 'string', file);
    assert.ok(Number.isInteger(data.version) && data.version > 0, file + ' version');
    assert.ok(Array.isArray(data.cases) && data.cases.length > 0, file + ' cases');
  }
});

for (const file of files) {
  const data = JSON.parse(readFileSync(join(VECTORS_DIR, file), 'utf8'));
  for (const vector of data.cases) {
    test(data.family + ': ' + vector.name, () => {
      const run = runners[vector.fn];
      assert.ok(run, 'no web runner for ' + vector.fn);
      assert.deepEqual(run(vector.input), vector.expected);
    });
  }
}
