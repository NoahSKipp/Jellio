// Streams that failed to play (an error, a placeholder clip, no picture),
// remembered per title for a couple of days so the stream picker can flag
// them and automatic retries skip them. Kept per browser.
const KEY = 'jellio_bad_streams';
const LIFETIME_MS = 48 * 60 * 60 * 1000;
const MAX_PLACEHOLDER_SECONDS = 180;

function load() {
  try {
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

// Key strictly by unique source.Id so one failing stream never poisons other
// streams on the same title.
function keysFor(source) {
  const keys = [];
  if (source && source.Id) keys.push('id:' + source.Id);
  return keys;
}

export function markBadSource(itemId, source) {
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
  keysFor(source).forEach(function (key) {
    entries[key] = now + LIFETIME_MS;
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

