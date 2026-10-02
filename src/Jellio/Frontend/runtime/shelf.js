// The reader's own shelf organisation (Controllers/ShelfController.cs):
// categories on the Manga, Books and Audiobooks shelves, per-series
// settings and chapter bookmarks. Kept in memory per shelf kind; every
// change fires jellio:shelf-changed so open screens can repaint.
import { getServerAddress, getAuthHeaders } from './auth.js';

const EMPTY = { Categories: [], Series: {}, Bookmarks: [], Library: [], LibraryRemoved: [], SeriesDefaults: null };
const loaded = new Map();

function idKey(id) {
  return String(id || '').replace(/-/g, '').toLowerCase();
}

export function itemShelfKey(item) {
  return 'i:' + idKey(item.Id);
}

export function seriesShelfKey(seriesKey) {
  return 's:' + seriesKey;
}

async function send(method, path, body) {
  const response = await fetch(getServerAddress() + '/Jellio/shelf' + path, {
    method: method,
    headers: Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json' }, getAuthHeaders()),
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try {
      const parsed = JSON.parse(text);
      message = typeof parsed === 'string' ? parsed : parsed.title || parsed.detail || text;
    } catch (err) {
      // Plain text already.
    }
    throw new Error(message || 'The server said no (' + response.status + ')');
  }
  return text ? JSON.parse(text) : null;
}

function changed(kind) {
  if (kind) loaded.delete(kind);
  else loaded.clear();
  document.dispatchEvent(new CustomEvent('jellio:shelf-changed', { detail: { kind: kind || null } }));
}

// { Categories (this shelf's, in order), Series, Bookmarks }.
export function loadShelf(kind) {
  if (!loaded.has(kind)) {
    const promise = send('GET', '/' + kind).then(
      (data) => Object.assign({}, EMPTY, data),
      function (err) {
        loaded.delete(kind);
        console.warn('Jellio: could not load the shelf categories', err);
        return EMPTY;
      },
    );
    loaded.set(kind, promise);
  }
  return loaded.get(kind);
}

export function onShelfChange(listener) {
  document.addEventListener('jellio:shelf-changed', listener);
  return () => document.removeEventListener('jellio:shelf-changed', listener);
}

export function categoriesOf(shelf, key) {
  return shelf.Categories.filter((category) => category.Items.indexOf(key) !== -1);
}

export async function createCategory(kind, name) {
  const category = await send('POST', '/' + kind + '/categories', { Name: name });
  changed(kind);
  return category;
}

export async function updateCategory(kind, id, patch) {
  const category = await send('PATCH', '/categories/' + encodeURIComponent(id), patch);
  changed(kind);
  return category;
}

export async function deleteCategory(kind, id) {
  await send('DELETE', '/categories/' + encodeURIComponent(id));
  changed(kind);
}

export async function orderCategories(kind, ids) {
  await send('PUT', '/' + kind + '/order', { Ids: ids });
  changed(kind);
}

// keys go into exactly categoryIds.
export async function setMembership(kind, keys, categoryIds) {
  await send('PUT', '/' + kind + '/membership', { Keys: keys, CategoryIds: categoryIds });
  changed(kind);
}

export async function saveSeriesPrefs(key, patch) {
  const prefs = await send('PUT', '/series', Object.assign({ Key: key }, patch));
  changed(null);
  return prefs;
}

// Mihon's "set as default" for chapter settings, and optionally every
// series on the shelf switched over to it.
export async function saveSeriesDefaults(settings, applyToLibrary) {
  await send('PUT', '/series/defaults', Object.assign({}, settings, { ApplyToLibrary: !!applyToLibrary }));
  changed(null);
}

// Manga series on the reader's shelf (Mihon's library).
export function isInLibrary(shelf, key) {
  return (shelf.Library || []).indexOf(key) !== -1;
}

export async function setInLibrary(key, inLibrary) {
  await send('PUT', '/library', { Key: key, InLibrary: inLibrary });
  changed('manga');
}

// Adds a series when the reader opens it, once per session.
const ensured = new Set();
export function ensureInLibrary(key) {
  if (!key || ensured.has(key)) return;
  ensured.add(key);
  loadShelf('manga').then(function (shelf) {
    if (!isInLibrary(shelf, key)) setInLibrary(key, true).catch(() => ensured.delete(key));
  });
}

export function isBookmarked(shelf, itemId) {
  return shelf.Bookmarks.indexOf(idKey(itemId)) !== -1;
}

export async function setBookmark(itemId, bookmarked) {
  await send('PUT', '/bookmarks/' + idKey(itemId), { Bookmarked: bookmarked });
  changed(null);
}
