// Finding the next stream after one failed. The list of other streams is
// loaded with a retry and falls back to the last list loaded for the title;
// a list that could not be loaded is never taken for an empty one.
export const RECENT_LIST_MS = 60 * 1000;
export const RETRY_TIMEOUT_MS = 30 * 1000;

export function errorKind(err) {
  if (!err) return 'unknown';
  if (err.timedOut || err.name === 'AbortError' || /timed out/i.test(String(err.message || ''))) return 'timeout';
  if (typeof err.status === 'number' && err.status >= 500) return 'server';
  if (typeof err.status === 'number') return 'http ' + err.status;
  return 'network';
}

// deps.lastList(itemId) -> { sources, at } or null; deps.fetchSources(timeoutMs)
// -> sources (throws on failure); deps.now() -> ms.
// origin: 'recent' (the list already loaded, under a minute old), 'fresh',
// 'retry', 'fallback' (an older loaded list after both tries failed) or
// 'failed' (nothing to go on). error holds the last failure's kind and how
// long the tries took.
export async function loadFailoverSources(deps) {
  const now = deps.now || Date.now;
  const last = deps.lastList ? deps.lastList() : null;
  if (last && last.sources && last.sources.length && now() - last.at < RECENT_LIST_MS) {
    return { sources: last.sources, origin: 'recent', error: null };
  }
  const started = now();
  let failure = null;
  try {
    return { sources: await deps.fetchSources(undefined), origin: 'fresh', error: null };
  } catch (err) {
    failure = err;
  }
  try {
    return {
      sources: await deps.fetchSources(RETRY_TIMEOUT_MS),
      origin: 'retry',
      error: { kind: errorKind(failure), ms: now() - started, recovered: true },
    };
  } catch (err) {
    failure = err;
  }
  const error = { kind: errorKind(failure), ms: now() - started, recovered: false };
  if (last && last.sources && last.sources.length) {
    return { sources: last.sources, origin: 'fallback', error: error };
  }
  return { sources: null, origin: 'failed', error: error };
}

// Ordering the candidates with the counts that explain the outcome.
// deps.isBad(source) -> 'hard' | 'soft' | null; deps.byLanguage(list);
// deps.needsReencode(source) or null when re-encoding is not avoided;
// deps.blockReencode.
export function planFailover(sources, tried, deps) {
  const list = sources || [];
  const counts = { total: list.length, tried: 0, badHard: 0, badSoft: 0, afterLanguage: 0, afterTranscode: 0 };
  const candidates = [];
  list.forEach(function (source) {
    if (tried.indexOf(source.Id) !== -1) {
      counts.tried++;
      return;
    }
    const bad = deps.isBad(source);
    if (bad === 'hard') counts.badHard++;
    else if (bad === 'soft') counts.badSoft++;
    else candidates.push(source);
  });
  let ordered = deps.byLanguage(candidates);
  counts.afterLanguage = ordered.length;
  if (deps.needsReencode) {
    const copyable = candidates.filter(function (source) { return !deps.needsReencode(source); });
    const reencode = deps.blockReencode ? [] : candidates.filter(deps.needsReencode);
    ordered = deps.byLanguage(copyable).concat(deps.byLanguage(reencode));
  }
  counts.afterTranscode = ordered.length;
  return { ordered: ordered, counts: counts };
}

// What the player does next: go to a stream, say there is truly none left,
// or say the list could not be loaded (with a way to try again).
export function failoverOutcome(loaded, plan) {
  if (plan.ordered.length) return { action: 'navigate', sourceId: plan.ordered[0].Id };
  if (loaded.origin === 'failed' || loaded.origin === 'fallback') {
    return { action: 'list-failed', kind: loaded.error ? loaded.error.kind : 'unknown' };
  }
  return { action: 'none-left' };
}

// One line for the console and the server log; ids and counts only.
export function describeFailover(entry) {
  const c = entry.counts;
  const list = entry.loaded;
  return (
    'Jellio failover: ' + entry.reason +
    '; sources ' + c.total + ', tried ' + c.tried + ', bad ' + c.badHard + ' hard / ' + c.badSoft + ' soft' +
    ', after language ' + c.afterLanguage + ', after transcode rule ' + c.afterTranscode +
    '; list ' + list.origin + (list.error ? ' (' + list.error.kind + ' after ' + list.error.ms + ' ms)' : '') +
    '; ' + (entry.outcome.action === 'navigate' ? 'next ' + entry.outcome.sourceId : entry.outcome.action)
  );
}
