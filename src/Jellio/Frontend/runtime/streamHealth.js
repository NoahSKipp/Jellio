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
        // Legacy 'name:' keys stored the first line of source.Name (the shared
        // addon/quality badge like "FHD" or "4K"), which falsely poisoned every
        // stream in that quality tier across the entire item.
        if (key.indexOf('name:') === 0) {
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

// A source's id can change when Gelato refreshes its rows; its release
// description (lines 2+ of source.Name) identifies the specific release file
// without matching the shared addon/quality badge on line 1.
function keysFor(source) {
  const keys = [];
  if (source && source.Id) keys.push('id:' + source.Id);
  const lines = String((source && source.Name) || '').split('\n');
  const desc = lines.slice(1).join('\n').trim();
  if (desc) keys.push('desc:' + desc);
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

