// Pure helpers for the "More like this" row on the player end screen.

import { isFinished } from './continueWatching.js';

export const RECS_LIMIT = 12;
export const PREVIEW_DELAY_MS = 5000;

// The id to ask Similar for: the series for an episode, the item otherwise.
export function similarSourceId(item) {
  if (!item) return null;
  if (item.Type === 'Episode') return item.SeriesId || null;
  return item.Id || null;
}

// Only recommends titles the user has not finished, and never the title itself.
export function pickRecommendations(items, item, limit) {
  const own = new Set([item && item.Id, item && item.SeriesId].filter(Boolean));
  const max = limit > 0 ? limit : RECS_LIMIT;
  return (items || [])
    .filter(function (entry) {
      return entry && entry.Id && !own.has(entry.Id) && !isFinished(entry);
    })
    .slice(0, max);
}

// Moves a roving index along the row, clamped at both ends.
export function nextFocusIndex(current, delta, count) {
  if (!count) return -1;
  const next = (current < 0 ? 0 : current) + delta;
  return Math.max(0, Math.min(count - 1, next));
}

// Fires onFire(key) once a key has stayed focused for delayMs; moving focus
// restarts the wait and cancel() drops it.
export function createFocusPreview(onFire, delayMs, timers) {
  const api = timers || { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const wait = delayMs > 0 ? delayMs : PREVIEW_DELAY_MS;
  let handle = null;
  let current = null;
  function cancel() {
    if (handle != null) api.clearTimeout(handle);
    handle = null;
  }
  return {
    focus: function (key) {
      if (key === current && handle != null) return;
      cancel();
      current = key;
      if (key == null) return;
      handle = api.setTimeout(function () {
        handle = null;
        onFire(key);
      }, wait);
    },
    cancel: function () {
      cancel();
      current = null;
    },
  };
}
