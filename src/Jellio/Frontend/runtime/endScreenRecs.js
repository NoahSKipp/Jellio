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

function tmdbOf(entry) {
  const ids = (entry && (entry.ProviderIds || entry.providerIds)) || {};
  return ids.Tmdb || ids.tmdb || null;
}

const OLD_EPISODE_DAYS = 120;
const DAY_MS = 86400000;

// Whether the title is truly finished: a movie, or the last episode of a
// series that is over. An unknown series status falls back to the episode's
// age; no next episode yet on a running series never counts.
export function isTitleFinished(item, series, hasNext, now) {
  if (!item || hasNext) return false;
  if (item.Type === 'Movie') return true;
  if (item.Type !== 'Episode') return false;
  const status = series && typeof series.Status === 'string' ? series.Status.trim().toLowerCase() : '';
  if (status) return status === 'ended';
  const premiere = item.PremiereDate ? Date.parse(item.PremiereDate) : NaN;
  if (Number.isNaN(premiere)) return false;
  return (now == null ? Date.now() : now) - premiere > OLD_EPISODE_DAYS * DAY_MS;
}

// Whether an episode needs its series fetched to learn the TMDB id.
export function needsSeriesLookup(item) {
  return !!item && item.Type === 'Episode' && !!item.SeriesId;
}

// What to ask the TMDB-backed suggestions for: the series for an episode
// (pass the fetched series), the item itself otherwise. Null without a TMDB id.
export function tmdbSeed(item, series) {
  if (!item) return null;
  const source = item.Type === 'Episode' ? series : item;
  const tmdbId = tmdbOf(source);
  if (!tmdbId) return null;
  const isTv = item.Type === 'Episode' || item.Type === 'Series';
  const name = (source && source.Name) || item.SeriesName || item.Name || '';
  return { tmdbId: String(tmdbId), mediaType: isTv ? 'tv' : 'movie', query: name };
}

// The items of the "similar" row of a suggestions answer, in TMDB order
// (library titles and virtual ones stay interleaved as the server ranks them).
export function similarRowItems(answer) {
  const rows = (answer && answer.Rows) || [];
  const row = rows.find(function (entry) {
    return entry && entry.Kind === 'similar';
  });
  return (row && row.Items) || [];
}

function identity(entry) {
  const tmdb = tmdbOf(entry);
  const type = entry.Type === 'Series' ? 'tv' : 'movie';
  return tmdb ? 'tmdb:' + type + ':' + tmdb : 'id:' + String(entry.Id).replace(/-/g, '').toLowerCase();
}

// Drops the title itself, duplicates and finished library titles (virtual
// titles carry no watch state and stay), keeps the given order, caps the row.
export function pickRecommendations(items, item, limit) {
  const own = new Set([item && item.Id, item && item.SeriesId].filter(Boolean).map(function (id) {
    return String(id).replace(/-/g, '').toLowerCase();
  }));
  const ownTmdb = tmdbOf(item);
  const max = limit > 0 ? limit : RECS_LIMIT;
  const seen = new Set();
  const out = [];
  (items || []).forEach(function (entry) {
    if (out.length >= max || !entry || !entry.Id) return;
    if (own.has(String(entry.Id).replace(/-/g, '').toLowerCase())) return;
    if (ownTmdb && item.Type !== 'Episode' && String(tmdbOf(entry)) === String(ownTmdb)) return;
    if (isFinished(entry)) return;
    const key = identity(entry);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  });
  return out;
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
