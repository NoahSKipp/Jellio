import { readString, writeJson, remove } from './storage.js';

const KEY = 'jellio_bad_streams_v2';
// Marks recorded on 2026-10-17, when a stalled stream cache made every stream
// time out, flagged working releases bad for two days. The key bump drops them.
const LEGACY_KEYS = ['jellio_bad_streams'];
const LIFETIME_MS = 48 * 60 * 60 * 1000;
// A stream that only timed out is as likely a slow or stalled backend as a
// dead release, so it is remembered briefly and only by its own source id.
const SOFT_LIFETIME_MS = 2 * 60 * 60 * 1000;
const MAX_PLACEHOLDER_SECONDS = 180;

function load() {
  try {
    LEGACY_KEYS.forEach(function (legacy) {
      if (readString(legacy) !== null) remove(legacy);
    });
    const parsed = JSON.parse(readString(KEY) || '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    let dirty = false;
    Object.keys(parsed).forEach(function (id) {
      const entries = parsed[id];
      if (!entries || typeof entries !== 'object') {
        delete parsed[id];
        dirty = true;
        return;
      }
      Object.keys(entries).forEach(function (key) {
        // Legacy 'name:' and 'desc:' keys poisoned other streams in the same
        // tier or episode when stream names shared line 1 or generic descriptions.
        if (key.indexOf('name:') === 0 || key.indexOf('desc:') === 0) {
          delete entries[key];
          dirty = true;
        }
      });
      if (!Object.keys(entries).length) {
        delete parsed[id];
        dirty = true;
      }
    });
    if (dirty) save(parsed);
    return parsed;
  } catch (err) {
    return {};
  }
}

function save(map) {
  writeJson(KEY, map);
}

function keysFor(source) {
  const keys = [];
  if (!source) return keys;
  if (source.Id) keys.push('id:' + source.Id);
  const name = String(source.Name || '').trim();
  if (name.indexOf('\n') !== -1) {
    keys.push('release:' + name);
  }
  return keys;
}

export function markBadSource(itemId, source, options) {
  const soft = !!(options && options.soft);
  if (!itemId || !source) return;
  const map = load();
  const now = Date.now();
  Object.keys(map).forEach(function (id) {
    const entries = map[id] || {};
    Object.keys(entries).forEach(function (key) {
      if (entries[key] < now) delete entries[key];
    });
    if (!Object.keys(entries).length) delete map[id];
  });
  const entries = map[itemId] || {};
  const keys = soft ? keysFor(source).filter(function (key) { return key.indexOf('id:') === 0; }) : keysFor(source);
  keys.forEach(function (key) {
    entries[key] = Math.max(entries[key] || 0, now + (soft ? SOFT_LIFETIME_MS : LIFETIME_MS));
  });
  map[itemId] = entries;
  save(map);
}

export function unmarkBadSource(itemId, source) {
  if (!itemId || !source) return;
  const map = load();
  const entries = map[itemId];
  if (!entries) return;
  let dirty = false;
  keysFor(source).forEach(function (key) {
    if (entries[key]) {
      delete entries[key];
      dirty = true;
    }
  });
  if (dirty) {
    if (!Object.keys(entries).length) delete map[itemId];
    save(map);
  }
}

// 'hard' for a mark that lasts the full two days, 'soft' for a short one,
// null when the source isn't marked.
export function badSourceKind(itemId, source) {
  const entries = load()[itemId];
  if (!entries) return null;
  const now = Date.now();
  let kind = null;
  keysFor(source).forEach(function (key) {
    const until = entries[key];
    if (!until || until <= now) return;
    if (until - now > SOFT_LIFETIME_MS) kind = 'hard';
    else if (!kind) kind = 'soft';
  });
  return kind;
}

export function isBadSource(itemId, source) {
  const entries = load()[itemId];
  if (!entries) return false;
  const now = Date.now();
  return keysFor(source).some(function (key) {
    return entries[key] && entries[key] > now;
  });
}

const PLACEHOLDER_MIN_RUNTIME_SECONDS = 600;
const PLACEHOLDER_MAX_FPS = 2;
const PLACEHOLDER_MIN_SAMPLE_SECONDS = 3;
export const PLACEHOLDER_STALL_MS = 8000;

// Whether the element decoded no audio at all: true or false when the
// browser can tell, null when it can't.
export function hasNoAudio(media) {
  if (!media) return null;
  if (media.audioTracks && typeof media.audioTracks.length === 'number') return media.audioTracks.length === 0;
  if (typeof media.mozHasAudio === 'boolean') return !media.mozHasAudio;
  if (typeof media.webkitAudioDecodedByteCount === 'number') return media.webkitAudioDecodedByteCount === 0;
  return null;
}

// AIOStreams' "failed to download" clip plays at 1 fps with no audio,
// whatever length the player was told. frames and seconds are the frames
// drawn over that much played time.
export function looksLikeSilentSlideshow(frames, seconds, noAudio, expectedSeconds) {
  if (!expectedSeconds || expectedSeconds < PLACEHOLDER_MIN_RUNTIME_SECONDS) return false;
  if (noAudio !== true) return false;
  if (!isFinite(frames) || frames < 0 || !isFinite(seconds) || seconds < PLACEHOLDER_MIN_SAMPLE_SECONDS) return false;
  return frames / seconds <= PLACEHOLDER_MAX_FPS;
}

// Ending or stalling in the first quarter of a long title, on any path.
export function stoppedTooEarly(positionSeconds, expectedSeconds) {
  if (!expectedSeconds || expectedSeconds < PLACEHOLDER_MIN_RUNTIME_SECONDS) return false;
  if (!isFinite(positionSeconds) || positionSeconds < 0) return false;
  return positionSeconds < expectedSeconds * 0.25;
}

export function looksLikePlaceholder(actualSeconds, expectedSeconds) {
  if (!actualSeconds || !isFinite(actualSeconds) || actualSeconds <= 0 || !expectedSeconds) return false;
  if (actualSeconds > MAX_PLACEHOLDER_SECONDS) return false;
  if (expectedSeconds < 600) return false;
  return actualSeconds < expectedSeconds * 0.25;
}

