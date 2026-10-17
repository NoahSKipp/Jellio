// Streams that failed to play (an error, a placeholder clip, no picture),
// remembered per title for a couple of days so the stream picker can flag
// them and automatic retries skip them. Kept per browser.
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
      if (window.localStorage.getItem(legacy) !== null) window.localStorage.removeItem(legacy);
    });
    const parsed = JSON.parse(window.localStorage.getItem(KEY) || '{}');
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
  try {
    window.localStorage.setItem(KEY, JSON.stringify(map));
  } catch (err) {}
}

// Key strictly by unique source.Id, and for multi-line scraper names
// (which contain the exact release filename, size, indexer, and age on line 2+),
// also key by the full trimmed release name so stale or duplicate sync rows of
// the same dead release are all marked bad together.
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

export function isBadSource(itemId, source) {
  const entries = load()[itemId];
  if (!entries) return false;
  const now = Date.now();
  return keysFor(source).some(function (key) {
    return entries[key] && entries[key] > now;
  });
}

// A clip far shorter than the title it stands in for: AIOStreams' "download
// failed" video and similar placeholders run under three minutes against a
// runtime of ten minutes or more.
export function looksLikePlaceholder(actualSeconds, expectedSeconds) {
  if (!actualSeconds || !isFinite(actualSeconds) || actualSeconds <= 0 || !expectedSeconds) return false;
  if (actualSeconds > MAX_PLACEHOLDER_SECONDS) return false;
  if (expectedSeconds < 600) return false;
  return actualSeconds < expectedSeconds * 0.25;
}

