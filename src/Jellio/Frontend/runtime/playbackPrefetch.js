import { normalizeId, preferReadySource } from './readySources.js';

// PlaybackInfo answers negotiated before the player opens: from resting on
// Play on the title page (45 s) and from the next-episode preload.
export const PREFETCH_TTL_MS = 45000;
export const PREWARM_TTL_MS = 150000;
export const PREFETCH_DWELL_MS = 1000;

export function playbackKey(itemId, sourceId, startTicks) {
  return normalizeId(itemId) + '|' + normalizeId(sourceId) + '|' + (Number(startTicks) || 0);
}

// value: { promise, audioIndex } or anything else the caller keeps with it.
export function createPlaybackCache(options) {
  const ttlMs = options.ttlMs;
  const now = options.now;
  const entries = new Map();

  function prune() {
    const at = now();
    entries.forEach(function (entry, key) {
      if (at - entry.at > ttlMs) entries.delete(key);
    });
  }

  return {
    put(itemId, sourceId, startTicks, value) {
      prune();
      const key = playbackKey(itemId, sourceId, startTicks);
      if (entries.has(key)) return false;
      entries.set(key, { at: now(), itemId: normalizeId(itemId), value: value });
      return true;
    },
    // Taken once. A request made without a source also serves one that
    // names a source; the caller checks the answer has it.
    take(itemId, sourceId, startTicks) {
      prune();
      const keys = [playbackKey(itemId, sourceId, startTicks)];
      if (sourceId) keys.push(playbackKey(itemId, null, startTicks));
      for (let i = 0; i < keys.length; i++) {
        const entry = entries.get(keys[i]);
        if (!entry) continue;
        entries.delete(keys[i]);
        return entry.value;
      }
      return null;
    },
    has(itemId) {
      prune();
      const id = normalizeId(itemId);
      let found = false;
      entries.forEach(function (entry) {
        if (entry.itemId === id) found = true;
      });
      return found;
    },
    drop(itemId) {
      const id = normalizeId(itemId);
      entries.forEach(function (entry, key) {
        if (entry.itemId === id) entries.delete(key);
      });
    },
    get size() {
      prune();
      return entries.size;
    },
  };
}

// Runs `run(itemId)` once the pointer or focus has rested for delayMs, at
// most once per title per windowMs. stop() cancels a wait not yet run.
export function createDwellPrefetch(options) {
  const delayMs = options.delayMs == null ? PREFETCH_DWELL_MS : options.delayMs;
  const windowMs = options.windowMs == null ? PREFETCH_TTL_MS : options.windowMs;
  const ranAt = new Map();
  let timer = null;

  function stop() {
    if (timer != null) options.cancel(timer);
    timer = null;
  }

  function ranLately(id) {
    const last = ranAt.get(id);
    return last != null && options.now() - last < windowMs;
  }

  function runNow(itemId) {
    stop();
    const id = normalizeId(itemId);
    if (ranLately(id)) return;
    ranAt.set(id, options.now());
    options.run(itemId);
  }

  return {
    start(itemId) {
      stop();
      if (ranLately(normalizeId(itemId))) return;
      timer = options.schedule(function () {
        timer = null;
        runNow(itemId);
      }, delayMs);
    },
    runNow: runNow,
    stop: stop,
  };
}

// The source Play would start: the remembered one, else the best ranked,
// with sources that failed lately last, the reader's language first and
// a Ready one of the same tier ahead of a cold one.
export function pickPlaySource(sources, options) {
  const list = (sources || []).filter(Boolean);
  if (!list.length) return null;
  const opts = options || {};
  const isBad = opts.isBad || function () { return false; };
  if (opts.rememberedId) {
    const remembered = list.find(function (source) {
      return source.Id === opts.rememberedId && !isBad(source);
    });
    if (remembered) return remembered;
  }
  const good = list.filter(function (source) { return !isBad(source); });
  if (!good.length) return list[0];
  let ordered = good;
  if (opts.byLanguage) {
    const matched = opts.byLanguage(good);
    if (matched && matched.length) ordered = matched;
  }
  if (opts.preferReady && opts.isReady && opts.tierOf) {
    ordered = preferReadySource(ordered, opts.isReady, opts.tierOf);
  }
  return ordered[0];
}

export const prefetchedPlayback = createPlaybackCache({ ttlMs: PREFETCH_TTL_MS, now: function () { return Date.now(); } });
export const prewarmedPlayback = createPlaybackCache({ ttlMs: PREWARM_TTL_MS, now: function () { return Date.now(); } });

// The answer has the source asked for (any, when none was).
export function negotiationFits(info, sourceId) {
  const list = (info && info.MediaSources) || [];
  if (!list.length) return false;
  if (!sourceId) return true;
  return list.some(function (source) {
    return source && source.Id === sourceId;
  });
}
