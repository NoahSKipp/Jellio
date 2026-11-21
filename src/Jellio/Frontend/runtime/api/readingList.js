import { getCurrentUserId } from '../auth.js';
import { authedFetch, getJson, postJson } from './core.js';

// The reading list: books, audiobooks and manga kept apart from the
// watchlist. An older plugin answers 404 for it all; the probe below then
// flips `supported` to false and every entry point hides itself.
let supported = null;
let keys = null;
let keysInFlight = null;

function announce() {
  if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
    document.dispatchEvent(new CustomEvent('jellio:readinglist-changed'));
  }
}

function setSupported(value) {
  if (supported === value) return;
  supported = value;
  announce();
}

// true / false once known, null before the first answer.
export function readingListSupported() {
  return supported;
}

export function loadReadingListKeys(force) {
  if (!force && keys) return Promise.resolve(keys);
  if (keysInFlight) return keysInFlight;
  keysInFlight = getJson('/Jellio/reading-list/keys')
    .then(function (data) {
      keys = new Set((data && data.Keys) || []);
      setSupported(true);
      announce();
      return keys;
    })
    .catch(function (err) {
      if (err && err.status === 404) setSupported(false);
      throw err;
    })
    .finally(function () {
      keysInFlight = null;
    });
  return keysInFlight;
}

export function isOnReadingList(key) {
  return !!(keys && keys.has(key));
}

export function getReadingList() {
  return getJson('/Jellio/reading-list').then(function (data) {
    if (data && Array.isArray(data.Items)) {
      keys = new Set(data.Items.map(function (entry) { return entry.Key; }));
      announce();
    }
    return (data && data.Items) || [];
  });
}

// A POST whose refusals carry the JSON { Error } body (err.status, err.body).
async function send(method, path, body) {
  const response = await authedFetch(path, {
    method: method,
    headers: body === undefined ? { Accept: 'application/json' } : { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (e) {}
  if (!response.ok) {
    const err = new Error('Request failed: ' + path);
    err.status = response.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

// `target` comes from readingListHelpers.readingTargetFor*.
export function addToReadingList(target) {
  return send('POST', '/Jellio/reading-list', target).then(function (result) {
    if (!keys) keys = new Set();
    keys.add(result && result.Item ? result.Item.Key : target.Key);
    announce();
    return result;
  });
}

export function removeFromReadingList(key) {
  return send('DELETE', '/Jellio/reading-list?key=' + encodeURIComponent(key)).then(function (result) {
    if (keys) keys.delete(key);
    announce();
    return result;
  });
}

// Adds the item to friends' reading lists; same per-friend results as the
// watchlist (added, already_on_list, not_visible, muted, ...).
export function addReadingToFriends(target, userIds) {
  const body = Object.assign({}, target, { UserIds: userIds });
  return postJson('/Jellio/watchlist/friends', body).then(function (result) {
    return (result && result.Results) || [];
  });
}

// Books and audiobooks in the user's libraries matching a title, for
// opening a book that was put on the list before it arrived.
export function searchBooksByTitle(title) {
  const userId = getCurrentUserId();
  if (!userId || !title) return Promise.resolve([]);
  const params = new URLSearchParams({
    searchTerm: title,
    Recursive: 'true',
    IncludeItemTypes: 'Book,AudioBook',
    Limit: '20',
  });
  return getJson('/Users/' + userId + '/Items?' + params.toString()).then(function (result) {
    return (result && result.Items) || [];
  });
}
