// Offline: downloads kept on this device, whether the server can be
// reached, and changes made while it couldn't, sent once it can.
//
// Storage: each download is a record in IndexedDB (what it is, its item
// data for showing it offline, its files and their state), and its files
// sit in Cache Storage under /__jellio_offline__/<id>/<name>. Cache
// Storage writes a fetched response straight to disk as it streams in,
// so even a film never has to fit in memory. sw.js serves the Jellio
// interface itself from its own cache, so the page opens offline.
//
// Deliberately free of runtime/api.js (which builds on this): it talks
// to the server with its own fetch calls.
import { getServerAddress, getAuthHeaders, getCurrentUserId } from './auth.js';

const DB_NAME = 'jellio-offline';
const DB_VERSION = 1;
const FILES_CACHE = 'jellio-offline-files';
const FILE_PREFIX = '/__jellio_offline__/';
const PING_TIMEOUT_MS = 4000;

// --- connectivity ---------------------------------------------------------

let offline = false;
let checked = false;
let recheckTimer = null;

export function isOffline() {
  return offline;
}

function setOffline(value) {
  const changed = value !== offline || !checked;
  offline = value;
  checked = true;
  if (changed) document.dispatchEvent(new CustomEvent('jellio:connectivity', { detail: { offline: value } }));
  window.clearTimeout(recheckTimer);
  if (value) {
    // Keep trying while offline, so the app notices the server is back.
    recheckTimer = window.setTimeout(checkServer, 30000);
  } else {
    flushSyncQueue();
    resumeDownloads();
  }
}

// Whether the server answers: GET /System/Ping, anonymous and tiny.
export async function checkServer() {
  if (navigator.onLine === false) {
    setOffline(true);
    return false;
  }
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  try {
    const response = await fetch(getServerAddress() + '/System/Ping', { cache: 'no-store', signal: controller.signal });
    // Any answer from the server (even an error page) means it's up; a
    // service worker fallback is the only thing that can't be an answer.
    setOffline(response.status === 0 || response.headers.get('X-Jellio-Offline') === '1');
  } catch (err) {
    setOffline(true);
  } finally {
    window.clearTimeout(timer);
  }
  return !offline;
}

// A request failing for lack of a connection (not an error answer).
export function isNetworkError(err) {
  return !err || err.name === 'TypeError' || err.name === 'AbortError' || err.status === 0 || err.isNetworkError === true;
}

// Called by runtime/api.js when a request fails without an answer: the
// server may have gone away mid-session.
export function reportNetworkFailure() {
  if (!offline) checkServer();
}

window.addEventListener('online', checkServer);
window.addEventListener('offline', function () {
  setOffline(true);
});

// --- IndexedDB -------------------------------------------------------------

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(function (resolve, reject) {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = function () {
      const db = request.result;
      if (!db.objectStoreNames.contains('downloads')) db.createObjectStore('downloads', { keyPath: 'Id' });
      if (!db.objectStoreNames.contains('progress')) db.createObjectStore('progress', { keyPath: 'Key' });
      if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'Seq', autoIncrement: true });
    };
    request.onsuccess = function () {
      resolve(request.result);
    };
    request.onerror = function () {
      dbPromise = null;
      reject(request.error);
    };
  });
  return dbPromise;
}

async function withStore(name, mode, work) {
  const db = await openDb();
  return new Promise(function (resolve, reject) {
    const tx = db.transaction(name, mode);
    const store = tx.objectStore(name);
    let result;
    Promise.resolve(work(store)).then(function (value) {
      result = value;
    });
    tx.oncomplete = function () {
      resolve(result);
    };
    tx.onerror = function () {
      reject(tx.error);
    };
    tx.onabort = function () {
      reject(tx.error);
    };
  });
}

function requestResult(request) {
  return new Promise(function (resolve, reject) {
    request.onsuccess = function () {
      resolve(request.result);
    };
    request.onerror = function () {
      reject(request.error);
    };
  });
}

function idKey(id) {
  return String(id || '').replace(/-/g, '').toLowerCase();
}

// --- downloads ------------------------------------------------------------

const listeners = new Set();

export function onDownloadsChange(listener) {
  listeners.add(listener);
  return function () {
    listeners.delete(listener);
  };
}

function notify(record) {
  listeners.forEach(function (listener) {
    try {
      listener(record);
    } catch (err) {
      console.warn('Jellio: downloads listener failed', err);
    }
  });
}

function fileUrl(id, name) {
  return FILE_PREFIX + idKey(id) + '/' + name;
}

async function putRecord(record) {
  await withStore('downloads', 'readwrite', (store) => store.put(record));
  notify(record);
  return record;
}

// This reader's downloads, newest first.
export async function listDownloads() {
  if (!('indexedDB' in window)) return [];
  const userId = idKey(getCurrentUserId());
  const all = await withStore('downloads', 'readonly', (store) => requestResult(store.getAll()));
  return (all || []).filter((record) => record.UserId === userId).sort((a, b) => b.AddedAt - a.AddedAt);
}

export async function getDownload(id) {
  if (!id || !('indexedDB' in window)) return null;
  try {
    const record = await withStore('downloads', 'readonly', (store) => requestResult(store.get(idKey(id))));
    return record && record.UserId === idKey(getCurrentUserId()) ? record : null;
  } catch (err) {
    return null;
  }
}

// A finished download holding this item: its own, or an audiobook's that
// lists it as one of its tracks.
export async function findDownload(itemId) {
  const own = await getDownload(itemId);
  if (own) return own.Status === 'done' ? own : null;
  const key = idKey(itemId);
  const all = await listDownloads().catch(() => []);
  return all.find((record) => record.Status === 'done' && (record.TrackIds || []).indexOf(key) !== -1) || null;
}

// Any download (finished or not) holding this item, audiobook tracks
// included.
export async function findAnyDownload(itemId) {
  const own = await getDownload(itemId);
  if (own) return own;
  const key = idKey(itemId);
  const all = await listDownloads().catch(() => []);
  return all.find((record) => (record.TrackIds || []).indexOf(key) !== -1) || null;
}

export function recordHolds(record, itemId) {
  const key = idKey(itemId);
  return !!record && (record.Id === key || (record.TrackIds || []).indexOf(key) !== -1);
}

export async function getOfflineBlob(id, name) {
  if (!('caches' in window)) return null;
  try {
    const cache = await caches.open(FILES_CACHE);
    const response = await cache.match(fileUrl(id, name));
    return response ? await response.blob() : null;
  } catch (err) {
    return null;
  }
}

// An object URL for a downloaded file (the caller revokes it), or null.
export async function getOfflineObjectUrl(id, name) {
  const blob = await getOfflineBlob(id, name);
  return blob ? URL.createObjectURL(blob) : null;
}

// record: { Id, Kind: 'book' | 'manga' | 'audiobook' | 'video', Title,
// Subtitle?, Group?, GroupKey?, Item, Files: [{ Name, Url, Optional? }],
// ...kind-specific data }. Url is server-relative; downloads run one at a
// time while Jellio is open and pick up again on its next start.
export async function queueDownload(record) {
  const existing = await getDownload(record.Id);
  if (existing && existing.Status !== 'error') return existing;
  const stored = Object.assign(
    { Status: 'queued', DoneBytes: 0, TotalBytes: 0, AddedAt: Date.now(), Error: null },
    record,
    { Id: idKey(record.Id), UserId: idKey(getCurrentUserId()), Status: 'queued', Error: null },
  );
  await putRecord(stored);
  requestPersistence();
  runQueue();
  return stored;
}

// Merges fields into a stored download (e.g. fresher annotations).
export async function updateDownload(id, patch) {
  const record = await getDownload(id);
  if (!record) return null;
  return putRecord(Object.assign(record, patch));
}

export async function removeDownload(id) {
  const record = await getDownload(id);
  if (!record) return;
  if (activeDownload && activeDownload.id === record.Id) activeDownload.controller.abort();
  await withStore('downloads', 'readwrite', (store) => store.delete(record.Id));
  try {
    const cache = await caches.open(FILES_CACHE);
    const keys = await cache.keys();
    const prefix = FILE_PREFIX + record.Id + '/';
    const aliasCovers = (record.CoverAliases || []).map((alias) => fileUrl(alias, 'cover'));
    await Promise.all(
      keys
        .filter(function (request) {
          const path = new URL(request.url).pathname;
          return path.indexOf(prefix) === 0 || aliasCovers.indexOf(path) !== -1;
        })
        .map((request) => cache.delete(request)),
    );
  } catch (err) {
    console.warn('Jellio: could not remove downloaded files', err);
  }
  notify(Object.assign({}, record, { Status: 'removed' }));
}

export async function retryDownload(id) {
  const record = await getDownload(id);
  if (!record) return;
  record.Status = 'queued';
  record.Error = null;
  await putRecord(record);
  runQueue();
}

let activeDownload = null;
let queueRunning = false;

function resumeDownloads() {
  runQueue();
}

async function runQueue() {
  if (queueRunning || offline) return;
  queueRunning = true;
  try {
    for (;;) {
      const pending = (await listDownloads().catch(() => [])).filter((record) => record.Status === 'queued' || record.Status === 'downloading');
      if (!pending.length || offline) break;
      // Oldest first.
      await download(pending[pending.length - 1]);
    }
  } finally {
    queueRunning = false;
  }
}

async function download(record) {
  const controller = new AbortController();
  activeDownload = { id: record.Id, controller: controller };
  record.Status = 'downloading';
  record.DoneBytes = 0;
  await putRecord(record);
  const cache = await caches.open(FILES_CACHE);
  let lastNotify = 0;
  try {
    for (const file of record.Files) {
      let response;
      try {
        response = await fetch(getServerAddress() + file.Url, { headers: getAuthHeaders(), signal: controller.signal });
      } catch (err) {
        if (file.Optional) continue;
        throw err;
      }
      if (!response.ok) {
        if (file.Optional) continue;
        throw new Error('The server answered ' + response.status + ' for ' + (file.Label || file.Name));
      }
      const length = Number(response.headers.get('Content-Length')) || 0;
      if (length) record.TotalBytes += length;
      const counter = new TransformStream({
        transform(chunk, streamController) {
          record.DoneBytes += chunk.byteLength;
          const now = Date.now();
          if (now - lastNotify > 400) {
            lastNotify = now;
            notify(record);
          }
          streamController.enqueue(chunk);
        },
      });
      const headers = new Headers({ 'Content-Type': response.headers.get('Content-Type') || 'application/octet-stream' });
      await cache.put(fileUrl(record.Id, file.Name), new Response(response.body.pipeThrough(counter), { headers: headers }));
      file.Bytes = record.DoneBytes;
    }
    // The cover under other ids too (an audiobook's tracks), for the
    // service worker to find by whichever id a screen asks with.
    const cover = await cache.match(fileUrl(record.Id, 'cover'));
    if (cover && record.CoverAliases) {
      for (const alias of record.CoverAliases) {
        if (idKey(alias) !== record.Id) await cache.put(fileUrl(alias, 'cover'), cover.clone());
      }
    }
    record.TotalBytes = record.DoneBytes;
    record.Status = 'done';
    record.CompletedAt = Date.now();
    await putRecord(record);
  } catch (err) {
    const removed = !(await getDownload(record.Id));
    if (removed) return;
    record.Status = offline || isNetworkError(err) ? 'queued' : 'error';
    record.Error = err && err.message ? err.message : 'Download failed';
    await putRecord(record);
    if (record.Status === 'queued') {
      // Lost the connection: wait for it to come back.
      checkServer();
      throw err;
    }
  } finally {
    activeDownload = null;
  }
}

// Asks the browser not to clear downloads when space runs low.
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch (err) {
    // Not supported: downloads still work, the browser just may clear them.
  }
}

export async function storageEstimate() {
  try {
    return navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
  } catch (err) {
    return null;
  }
}

// --- local reading/listening progress ---------------------------------------

// The latest progress for a downloaded item on this device, so it opens
// where it was left even offline.
export async function getLocalProgress(itemId) {
  if (!('indexedDB' in window)) return null;
  try {
    return (await withStore('progress', 'readonly', (store) => requestResult(store.get(idKey(getCurrentUserId()) + ':' + idKey(itemId))))) || null;
  } catch (err) {
    return null;
  }
}

export async function setLocalProgress(itemId, progress) {
  if (!('indexedDB' in window)) return;
  const record = Object.assign({}, progress, { Key: idKey(getCurrentUserId()) + ':' + idKey(itemId), UpdatedAt: new Date().toISOString() });
  try {
    await withStore('progress', 'readwrite', (store) => store.put(record));
  } catch (err) {
    // Progress still reaches the server when online.
  }
}

// --- changes made offline -----------------------------------------------------

// A request to send once the server is back: { Method, Path, Body }.
// Replayed in order; one the server rejects is dropped, one that can't
// reach it waits for the next try.
export async function queueSync(method, path, body) {
  if (!('indexedDB' in window)) return;
  await withStore('queue', 'readwrite', (store) =>
    store.add({ Method: method, Path: path, Body: body === undefined ? null : body, UserId: idKey(getCurrentUserId()), At: Date.now() }),
  );
}

let flushing = false;

export async function flushSyncQueue() {
  if (flushing || offline || !('indexedDB' in window)) return;
  flushing = true;
  try {
    const entries = await withStore('queue', 'readonly', (store) => requestResult(store.getAll()));
    const userId = idKey(getCurrentUserId());
    for (const entry of entries || []) {
      if (entry.UserId !== userId) continue;
      let response;
      try {
        response = await fetch(getServerAddress() + entry.Path, {
          method: entry.Method,
          headers: Object.assign({ 'Content-Type': 'application/json' }, getAuthHeaders()),
          body: entry.Body === null ? undefined : JSON.stringify(entry.Body),
        });
      } catch (err) {
        break;
      }
      if (response.status >= 500) break;
      await withStore('queue', 'readwrite', (store) => store.delete(entry.Seq));
    }
  } catch (err) {
    console.warn('Jellio: could not send offline changes', err);
  } finally {
    flushing = false;
  }
}
