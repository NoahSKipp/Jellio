// Streams that failed to play (an error, a placeholder clip, no picture),
// remembered per title for a couple of days so the stream picker can flag
// them and automatic retries skip them. Kept per browser.
const KEY = 'jellio_bad_streams';
const LIFETIME_MS = 48 * 60 * 60 * 1000;

function load() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return {};
  }
}

function save(map) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(map));
  } catch (err) {}
}

// A source's id can change when Gelato refreshes its rows; its name (the
// addon's release line) doesn't, so both are kept.
function keysFor(source) {
  const keys = [];
  if (source && source.Id) keys.push('id:' + source.Id);
  const name = source && String(source.Name || '').split('\n')[0].trim();
  if (name) keys.push('name:' + name);
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
// failed" video and similar placeholders run about two minutes against a
// runtime of an hour or more.
export function looksLikePlaceholder(actualSeconds, expectedSeconds) {
  if (!actualSeconds || !isFinite(actualSeconds) || !expectedSeconds) return false;
  if (expectedSeconds < 600) return false;
  return actualSeconds < expectedSeconds * 0.25;
}
