import { getDisplayLanguage } from '../i18n.js';
import { getServerAddress, getAccessToken, getCurrentUserId, getAuthHeaders, clearSession, getCurrentUser as getSessionUser } from '../auth.js';
import { createRowCache, pickStorage, createTabChannel, createReturnWatcher, USER_DATA_CLASSES } from '../rowcache.js';
import { isOffline, stillOffline, reportNetworkFailure } from '../offline.js';
import { shouldConfirmUnauthorized, createSessionGuard } from '../sessionCheck.js';

export const DEFAULT_TIMEOUT_MS = 10000;
export const NEGOTIATION_TIMEOUT_MS = 30000;
export const SEARCH_TIMEOUT_MS = 30000;
export const ITEM_DETAILS_TIMEOUT_MS = 30000;

const BASE_CONCURRENT_REQUESTS = 4;
const BASE_PRIORITY_EXTRA_SLOTS = 2;
const MULTIPLEXED_CONCURRENT_REQUESTS = 12;
const MULTIPLEXED_PRIORITY_EXTRA_SLOTS = 4;

let isMultiplexedProtocol = false;
function detectMultiplexing() {
  if (typeof window === 'undefined' || !window.performance || typeof window.performance.getEntriesByType !== 'function') return;
  const entries = window.performance.getEntriesByType('resource');
  const serverAddress = getServerAddress() || '';
  const serverHost = serverAddress.replace(/^https?:\/\//, '').split('/')[0];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (serverHost && entry.name && entry.name.includes(serverHost) && entry.nextHopProtocol) {
      const proto = entry.nextHopProtocol.toLowerCase();
      if (proto.startsWith('h2') || proto.startsWith('h3') || proto.includes('http/2') || proto.includes('http/3')) {
        isMultiplexedProtocol = true;
        return;
      }
    }
  }
}

let activeRequestCount = 0;
const queuedRequestStarts = [];

function checkMultiplexUpgrade() {
  if (isMultiplexedProtocol) return;
  detectMultiplexing();
  if (isMultiplexedProtocol) {
    while (queuedRequestStarts.length > 0 && activeRequestCount < slotLimit(queuedRequestStarts[0].priority)) {
      queuedRequestStarts.shift().start();
    }
  }
}

function slotLimit(priority) {
  const base = isMultiplexedProtocol ? MULTIPLEXED_CONCURRENT_REQUESTS : BASE_CONCURRENT_REQUESTS;
  const extra = isMultiplexedProtocol ? MULTIPLEXED_PRIORITY_EXTRA_SLOTS : BASE_PRIORITY_EXTRA_SLOTS;
  return Math.min(base + (priority ? extra : 0), startupRequestCap());
}

const PAGE_STARTED_AT = Date.now();
const STARTUP_WINDOW_MS = 5000;

function inStartupWindow() {
  return Date.now() - PAGE_STARTED_AT < STARTUP_WINDOW_MS;
}

function startupRequestCap() {
  if (!rowCacheFlag || !inStartupWindow()) return Infinity;
  if (rowCache && rowCache.isPlayingElsewhere()) return 1;
  // HTTP/2+ multiplexes on one connection, so the HTTP/1.1 cap only adds queueing.
  if (!isMultiplexedProtocol) detectMultiplexing();
  return isMultiplexedProtocol ? 8 : 3;
}

function pumpRequestQueue() {
  while (queuedRequestStarts.length > 0 && activeRequestCount < slotLimit(queuedRequestStarts[0].priority)) {
    queuedRequestStarts.shift().start();
  }
}

if (typeof window !== 'undefined') window.setTimeout(pumpRequestQueue, STARTUP_WINDOW_MS + 10);

// For the home load report: requests started in the startup window and
// the most in flight at once then.
const startupRequests = { started: 0, maxConcurrent: 0 };

function acquireRequestSlot(priority) {
  return new Promise(function (resolve) {
    function start() {
      activeRequestCount++;
      if (inStartupWindow()) {
        startupRequests.started++;
        startupRequests.maxConcurrent = Math.max(startupRequests.maxConcurrent, activeRequestCount);
      }
      resolve(function releaseRequestSlot() {
        activeRequestCount--;
        const next = queuedRequestStarts[0];
        if (next && activeRequestCount < slotLimit(next.priority)) {
          queuedRequestStarts.shift().start();
        }
      });
    }
    if (activeRequestCount < slotLimit(priority)) start();
    else if (priority) {
      // Behind any priority requests already waiting, ahead of the rest.
      const firstNormal = queuedRequestStarts.findIndex(function (entry) {
        return !entry.priority;
      });
      queuedRequestStarts.splice(firstNormal === -1 ? queuedRequestStarts.length : firstNormal, 0, { start: start, priority: true });
    } else queuedRequestStarts.push({ start: start, priority: false });
  });
}

function fetchWithTimeout(url, options, timeoutMs, externalSignal) {
  const controller = new AbortController();
  const timer = window.setTimeout(function () {
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = function () {
    controller.abort();
  };
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort);
  }
  return fetch(url, Object.assign({}, options, { signal: controller.signal })).finally(function () {
    window.clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  });
}

export async function requestJson(url, options, path, timeoutMs, externalSignal, priority) {
  // Offline (runtime/offline.js): fail straight away rather than wait out
  // a timeout for every request.
  if (isOffline() && (await stillOffline())) {
    const offlineErr = new TypeError('Offline: ' + path);
    offlineErr.isNetworkError = true;
    throw offlineErr;
  }
  const releaseRequestSlot = await acquireRequestSlot(priority);
  try {
    if (externalSignal && externalSignal.aborted) {
      const abortedErr = new Error('Request timed out: ' + path);
      abortedErr.timedOut = true;
      throw abortedErr;
    }

    let response;
    let attempts = 0;
    const isIdempotent = !options || !options.method || options.method === 'GET' || options.method === 'HEAD';
    const maxAttempts = isIdempotent ? 3 : 1;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        response = await fetchWithTimeout(url, options, timeoutMs, externalSignal);
        if (response.ok || (response.status < 500 && response.status !== 429)) {
          break;
        }
      } catch (err) {
        if (err && err.name === 'AbortError') {
          const timeoutErr = new Error('Request timed out: ' + path);
          timeoutErr.timedOut = true;
          if (!(externalSignal && externalSignal.aborted)) reportNetworkFailure();
          throw timeoutErr;
        }
        if (attempts >= maxAttempts || (externalSignal && externalSignal.aborted)) {
          if (err) err.isNetworkError = true;
          reportNetworkFailure();
          throw err;
        }
      }
      if (attempts < maxAttempts && !(externalSignal && externalSignal.aborted)) {
        await new Promise(function (resolve) {
          setTimeout(resolve, 500 * attempts);
        });
      }
    }

    if (!response.ok) {
      if (response.status === 401 && shouldConfirmUnauthorized(url, path, getServerAddress())) {
        sessionGuard.report(getAccessToken());
      }
      const err = new Error('Request failed: ' + path);
      err.status = response.status;
      if (response.status === 503) {
        try {
          const body = await response.json();
          if (body && typeof body.Error === 'string') err.errorCode = body.Error;
        } catch (e) {}
      }
      throw err;
    }
    return response;
  } finally {
    releaseRequestSlot();
    checkMultiplexUpgrade();
  }
}

let sessionExpiredNotified = false;
document.addEventListener('jellio:session-captured', function () {
  sessionExpiredNotified = false;
});

const sessionGuard = createSessionGuard({
  probe: async function (token) {
    const userId = getCurrentUserId();
    if (!userId || getAccessToken() !== token) return 0;
    const response = await fetchWithTimeout(
      getServerAddress() + '/Users/' + encodeURIComponent(userId),
      { headers: Object.assign({ Accept: 'application/json' }, getAuthHeaders()), cache: 'no-store' },
      DEFAULT_TIMEOUT_MS,
    );
    return response.status;
  },
  onExpired: function (token) {
    if (getAccessToken() === token) notifySessionExpired();
  },
});

function notifySessionExpired() {
  if (sessionExpiredNotified) return;
  sessionExpiredNotified = true;
  clearCachedRows();
  clearSession();
  document.dispatchEvent(new CustomEvent('jellio:session-expired'));
}

export async function getJson(path, timeoutMs, signal, priority) {
  const response = await requestJson(
    getServerAddress() + path,
    { headers: Object.assign({ Accept: 'application/json' }, getAuthHeaders()), cache: 'no-store' },
    path,
    timeoutMs || DEFAULT_TIMEOUT_MS,
    signal,
    priority,
  );
  return response.json();
}

export async function postJson(path, body, timeoutMs) {
  const response = await requestJson(
    getServerAddress() + path,
    {
      method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/json', Accept: 'application/json' },
        getAuthHeaders(),
      ),
      body: JSON.stringify(body || {}),
    },
    path,
    timeoutMs || DEFAULT_TIMEOUT_MS,
  );
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

export async function deleteJson(path, timeoutMs) {
  await requestJson(
    getServerAddress() + path,
    { method: 'DELETE', headers: getAuthHeaders() },
    path,
    timeoutMs || DEFAULT_TIMEOUT_MS,
  );
}

const CACHE_TTL_MS = 60000;
export const SHORT_CACHE_TTL_MS = 8000;
export const cache = new Map();
const CACHE_MAX_ENTRIES = 500;

const RECENT_TTL_MS = 30 * 60 * 1000;
const recentValues = new Map();

function rememberRecent(key, value) {
  if (recentValues.size >= 300) recentValues.delete(recentValues.keys().next().value);
  recentValues.delete(key);
  recentValues.set(key, { ts: Date.now(), value: value });
}

export function cachedRecent(key, fetcher, ttlMs, itemId) {
  const hit = cache.get(key);
  const fresh = hit && Date.now() - hit.ts < ttlMs;
  const recent = recentValues.get(key);
  if (!fresh && recent && Date.now() - recent.ts < RECENT_TTL_MS) {
    cached(key, fetcher, ttlMs)
      .then(function (value) {
        const changed = JSON.stringify(value) !== JSON.stringify(recent.value);
        rememberRecent(key, value);
        if (changed) window.dispatchEvent(new CustomEvent('jellio-item-refreshed', { detail: { itemId: String(itemId) } }));
      })
      .catch(function () {});
    return Promise.resolve(recent.value);
  }
  return cached(key, fetcher, ttlMs).then(function (value) {
    rememberRecent(key, value);
    return value;
  });
}

export function cached(key, fetcher, ttlMs) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < (ttlMs || CACHE_TTL_MS)) return hit.promise;
  if (hit) cache.delete(key);
  if (cache.size >= CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
  const entry = { promise: null, ts: Date.now(), value: null };
  const promise = fetcher()
    .then(function (result) {
      entry.value = result;
      return result;
    })
    .catch(function (err) {
      cache.delete(key);
      throw err;
    });
  entry.promise = promise;
  cache.set(key, entry);
  return promise;
}

export function invalidateCache(key) {
  cache.delete(key);
}

export function clearCache() {
  cache.clear();
  recentValues.clear();
}

const ROW_CACHE_FLAG_KEY = 'jellio_home_row_cache';
const ROW_CACHE_WIPE_KEY = 'jellio_rowcache_wipe';
const ROW_CACHE_REPORT_MS = 6000;

function readRowCacheFlag() {
  try {
    return window.localStorage.getItem(ROW_CACHE_FLAG_KEY) !== '0';
  } catch (err) {
    return true;
  }
}

let rowCacheFlag = typeof window !== 'undefined' ? readRowCacheFlag() : false;
let rowCache = null;

export function isHomeRowCacheEnabled() {
  return rowCacheFlag;
}

function setHomeRowCacheEnabled(enabled) {
  const next = !!enabled;
  if (next === rowCacheFlag) return;
  rowCacheFlag = next;
  try {
    window.localStorage.setItem(ROW_CACHE_FLAG_KEY, next ? '1' : '0');
  } catch (err) {}
  if (!next) clearCachedRows();
}

function applyRowCacheConfig(config) {
  if (config && typeof config.HomeRowCache === 'boolean') setHomeRowCacheEnabled(config.HomeRowCache);
  return config;
}

function safeLocalStorage() {
  try {
    return window.localStorage;
  } catch (err) {
    return null;
  }
}

function rowCacheScope() {
  const user = getSessionUser();
  return { serverId: (user && user.ServerId) || getServerAddress(), userId: getCurrentUserId(), language: getDisplayLanguage() };
}

// Invalidate caches and refresh row cache scope when display language changes
if (typeof window !== 'undefined') {
  window.addEventListener('jellio-display-language-change', function () {
    clearCachedRows();
    if (rowCache) {
      rowCache.setScope(rowCacheScope());
    }
  });
}
function activeRowCache() {
  if (!rowCacheFlag || !getCurrentUserId()) return null;
  const scope = rowCacheScope();
  if (rowCache) {
    rowCache.setScope(scope);
    return rowCache;
  }
  let wipeOnStart = false;
  try {
    wipeOnStart = window.localStorage.getItem(ROW_CACHE_WIPE_KEY) === '1';
    window.localStorage.removeItem(ROW_CACHE_WIPE_KEY);
  } catch (err) {}
  rowCache = createRowCache({
    storage: pickStorage(window),
    channel: createTabChannel(window),
    locks: (typeof navigator !== 'undefined' && navigator.locks) || null,
    leaseStore: safeLocalStorage(),
    scope: scope,
    wipeOnStart: wipeOnStart,
  });
  rowCache.onChange(onRowCacheChange);
  createReturnWatcher({ document: document, window: window }, function () {
    if (rowCache && rowCacheFlag && !rowCache.isPlayingHere) rowCache.revalidateStale();
  });
  // The server's setting, read once the first rows are in.
  window.setTimeout(function () {
    getJellioConfig().catch(function () {});
  }, STARTUP_WINDOW_MS + 500);
  window.setTimeout(reportHomeLoad, Math.max(0, PAGE_STARTED_AT + ROW_CACHE_REPORT_MS - Date.now()));
  return rowCache;
}

function onRowCacheChange(event) {
  cache.clear();
  recentValues.clear();
  document.dispatchEvent(new CustomEvent('jellio:rowcache-change', { detail: event }));
}

const ROW_RANKS = { personal: 1, user: 2, views: 3, collections: 3, hero: 3, watchlist: 4, latest: 4 };

export function rowJson(path, cls, options) {
  const o = options || {};
  const fetcher = function () {
    return getJson(path, o.timeout, undefined, o.priority);
  };
  const rc = activeRowCache();
  if (!rc) return fetcher();
  const rank = typeof o.rank === 'number' ? o.rank : Object.prototype.hasOwnProperty.call(ROW_RANKS, cls) ? ROW_RANKS[cls] : 6;
  return rc.get(path, cls, fetcher, { priority: rank });
}

export function invalidateUserDataRows() {
  if (rowCache) rowCache.invalidate(USER_DATA_CLASSES);
}

let lastProgressInvalidation = 0;
export function invalidateUserDataRowsThrottled(intervalMs) {
  if (Date.now() - lastProgressInvalidation < intervalMs) return;
  lastProgressInvalidation = Date.now();
  invalidateUserDataRows();
}

export const COLLECTIONS_CACHE_TTL_MS = 10 * 60 * 1000;
export const COLLECTIONS_SESSION_PREFIX = 'jellio_collections_';

export function clearCollectionsSessionCache(userId) {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return;
    if (userId) {
      window.sessionStorage.removeItem(COLLECTIONS_SESSION_PREFIX + userId);
    } else {
      const currentUserId = getCurrentUserId();
      if (currentUserId) {
        window.sessionStorage.removeItem(COLLECTIONS_SESSION_PREFIX + currentUserId);
      }
    }
    if (typeof window.sessionStorage.length === 'number' && typeof window.sessionStorage.key === 'function') {
      const keys = [];
      for (let i = 0; i < window.sessionStorage.length; i++) {
        const key = window.sessionStorage.key(i);
        if (key && key.indexOf(COLLECTIONS_SESSION_PREFIX) === 0) {
          keys.push(key);
        }
      }
      keys.forEach(function (key) {
        window.sessionStorage.removeItem(key);
      });
    }
  } catch (err) {}
}

// Settings > Clear cached rows, logout and the setting going off.
export function clearCachedRows() {
  cache.clear();
  recentValues.clear();
  clearCollectionsSessionCache();
  if (rowCache) {
    rowCache.wipe();
  } else {
    try {
      window.localStorage.setItem(ROW_CACHE_WIPE_KEY, '1');
    } catch (err) {}
  }
}

// screens/player.js: a video is playing in this tab. Other tabs then
// refresh one row at a time.
export function setPlaybackActive(playing) {
  const rc = playing ? activeRowCache() : rowCache;
  if (rc) rc.setPlaying(playing);
}

let firstRowPaintMs = null;
// screens/home.js, when the first row goes on screen.
export function markHomeRowPainted() {
  if (firstRowPaintMs != null) return;
  firstRowPaintMs = Math.round(typeof performance !== 'undefined' ? performance.now() : Date.now() - PAGE_STARTED_AT);
  try {
    performance.mark('jellio-first-row');
  } catch (err) {}
}

// One line per page load in the console and the Jellyfin log: how the
// row cache did and how hard the start hit the server.
function reportHomeLoad() {
  if (!rowCache) return;
  const stats = rowCache.stats();
  const report = {
    Hits: stats.hits,
    Stale: stats.stale,
    Misses: stats.misses,
    Fetches: stats.fetches,
    FromOtherTabs: stats.fromOtherTabs,
    RequestsFirst5s: startupRequests.started,
    MaxConcurrentFirst5s: startupRequests.maxConcurrent,
    FirstRowPaintMs: firstRowPaintMs,
    StreamPlayingElsewhere: rowCache.isPlayingElsewhere(),
    Storage: rowCache.storageName,
    Route: (window.location.hash || '').split('?')[0] || '#/home',
  };
  console.info('Jellio home load', report);
  try {
    fetch(getServerAddress() + '/Jellio/playback/homeload', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, getAuthHeaders()),
      body: JSON.stringify(report),
      keepalive: true,
    }).catch(function () {});
  } catch (err) {}
}

export function getJellioConfig() {
  return cached('jellio-config', function () {
    return getJson('/Jellio/config').then(applyRowCacheConfig);
  }, SHORT_CACHE_TTL_MS);
}
