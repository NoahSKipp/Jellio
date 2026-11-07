import { getDisplayCulture, getDisplayLanguage, setDisplayLanguage } from './i18n.js';
import { markPlaybackStarted, markPlaybackStopped, canReportProgress } from './playbackGuard.js';
import { loadItemInfo } from './itemInfo.js';
import { avoidingVideoTranscodes, browserCaps, getVideoTranscodePolicy, setVideoTranscodePolicy } from './transcodePolicy.js';
import { copyableVideoCodecs } from './transcodeClassifier.js';
import { hasStreamInfo, filterPlayableSources } from './quality.js';
import { getServerAddress, getAuthHeaders, getCurrentUserId, getAccessToken, getDeviceId, clearSession, getCurrentUser as getSessionUser, updateSessionUser } from './auth.js';
export { getCurrentUserId };
import { createReturnWatcher, createRowCache, createTabChannel, pickStorage, USER_DATA_CLASSES } from './rowcache.js';
import { languageName } from './languages.js';
import { isOffline, stillOffline, isNetworkError, reportNetworkFailure, findDownload, queueSync } from './offline.js';
import {
  isUnreleasedItem,
  filterReleasedItems,
  isReleasedToday,
  isTodayItemStreamVerified,
  markTodayItemHasStream,
} from './releaseDate.js';
import { isRemoveFromWatchlistAfterWatchingEnabled } from './watchlistSettings.js';

export const DEFAULT_TIMEOUT_MS = 10000;
const NEGOTIATION_TIMEOUT_MS = 30000;
const SEARCH_TIMEOUT_MS = 30000;
const ITEM_DETAILS_TIMEOUT_MS = 30000;

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
  return rowCache && rowCache.isPlayingElsewhere() ? 1 : 3;
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
      if (response.status === 401) {
        notifySessionExpired();
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

function cachedRecent(key, fetcher, ttlMs, itemId) {
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

// Settings > Clear cached rows, logout and the setting going off.
export function clearCachedRows() {
  cache.clear();
  recentValues.clear();
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

export function getItem(itemId) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const culture = getDisplayCulture();
  return cached('item:' + itemId + ':' + culture, function () {
    return loadItemInfo(getJson, userId, itemId, { culture: culture });
  }).catch(function (err) {
    return downloadedItem(itemId, err);
  });
}

export function isUnreachable(err) {
  return isNetworkError(err) || !!(err && err.timedOut);
}

// A downloaded item's stored data, standing in for the server's when it
// can't be reached; otherwise the original error.
async function downloadedItem(itemId, err) {
  if (!isUnreachable(err)) throw err;
  const record = await findDownload(itemId);
  if (!record) throw err;
  const key = String(itemId).replace(/-/g, '').toLowerCase();
  const track = (record.Tracks || []).find((entry) => String(entry.Id).replace(/-/g, '').toLowerCase() === key);
  return track || record.Item;
}

export function seedItemCache(item) {
  if (!item) return;
  const id = item.Id || item.id;
  if (!id) return;
  if (!item.Id) item.Id = id;
  const key = 'item:' + id;
  const existing = cache.get(key);
  if (!existing) {
    cache.set(key, { promise: Promise.resolve(item), ts: Date.now(), value: item });
  } else if (!existing.value) {
    existing.value = item;
  }
  const culture = getDisplayCulture();
  if (culture) {
    const cultureKey = 'item:' + id + ':' + culture;
    const existingCulture = cache.get(cultureKey);
    if (!existingCulture) {
      cache.set(cultureKey, { promise: Promise.resolve(item), ts: Date.now(), value: item });
    } else if (!existingCulture.value) {
      existingCulture.value = item;
    }
  }
}

export function getCachedItemSync(itemId) {
  if (!itemId) return null;
  const culture = getDisplayCulture();
  const hit = cache.get('details:' + itemId + ':' + culture) ||
    cache.get('details:' + itemId + ':full:' + culture) ||
    cache.get('item:' + itemId + ':' + culture) ||
    cache.get('details:' + itemId) ||
    cache.get('details:' + itemId + ':full') ||
    cache.get('item:' + itemId);
  return hit ? hit.value : null;
}

export function getItemDetails(itemId, options) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const opts = options || {};
  const culture = getDisplayCulture();
  const cacheKey = 'details:' + itemId + (opts.includePlaybackFields ? ':full' : '') + ':' + culture;
  // Info only (runtime/itemInfo.js): streams come from getMediaSources.
  return cachedRecent(cacheKey, function () {
    return loadItemInfo(getJson, userId, itemId, {
      includePlaybackFields: !!opts.includePlaybackFields,
      timeoutMs: ITEM_DETAILS_TIMEOUT_MS,
      culture: culture,
      signal: opts.signal,
    });
  }, SHORT_CACHE_TTL_MS, itemId).catch(function (err) {
    return downloadedItem(itemId, err);
  });
}

export function getCurrentUser() {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  return cached('user:' + userId, function () {
    return rowJson('/Users/' + userId, 'user').then(function (user) {
      updateSessionUser(user);
      return user;
    });
  });
}

function invalidateCurrentUser() {
  const userId = getCurrentUserId();
  if (userId) invalidateCache('user:' + userId);
}

export function getUserViews() {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  return cached('views:' + userId, function () {
    return rowJson('/Users/' + userId + '/Views', 'views').then(function (result) {
      return (result && result.Items) || [];
    });
  });
}

export function getResumeItems(limit) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const query =
    '/Users/' +
    userId +
    '/Items/Resume?Limit=' +
    (limit || 20) +
    // Video only: a half-listened audiobook resumes into its own
    // Continue Listening row (getContinueListening below), not here.
    '&MediaTypes=Video' +
    '&Fields=PrimaryImageAspectRatio,RunTimeTicks&EnableImageTypes=Primary,Backdrop,Thumb' +
    (getDisplayCulture() ? '&Culture=' + encodeURIComponent(getDisplayCulture()) : '');
  return rowJson(query, 'personal', { priority: true, rank: 0 }).then(function (result) {
    return applyRealDurationOverrides((result && result.Items) || []);
  });
}

let audiobookLibraryMissing = false;

export function getAudiobookLibraryChapters(itemId) {
  if (audiobookLibraryMissing) return Promise.resolve(null);
  return getJson('/AudiobookLibrary/Books/' + itemId + '/Chapters').catch(function (err) {
    // A 404 on the route itself most likely means the plugin isn't
    // installed at all; stop asking for the rest of this page's life.
    if (err && err.status === 404) audiobookLibraryMissing = true;
    return null;
  });
}

const todayEmptyStreamsCache = new Map();
export const TODAY_EMPTY_STREAMS_TTL_MS = 2 * 60 * 1000;

export function clearTodayEmptyStreamsCache() {
  todayEmptyStreamsCache.clear();
}

export async function verifyTodayEpisodesHaveStreams(items) {
  if (!Array.isArray(items) || !items.length) return items || [];
  const now = Date.now();
  await Promise.all(
    items.map(async function (item) {
      if (!item || !item.Id) return;
      if (!isReleasedToday(item, now)) return;
      const dateStr = item.PremiereDate || item.EndDate;
      if (dateStr) {
        const d = new Date(dateStr);
        if (!isNaN(d.getTime()) && d.getTime() > now) {
          return;
        }
      }
      if (isTodayItemStreamVerified(item.Id)) return;
      const idStr = String(item.Id);
      const lastEmptyTime = todayEmptyStreamsCache.get(idStr);
      if (lastEmptyTime && now - lastEmptyTime < TODAY_EMPTY_STREAMS_TTL_MS) {
        return;
      }
      try {
        const sources = await getMediaSources(item.Id);
        const hasStreams = Array.isArray(sources) && sources.length > 0;
        markTodayItemHasStream(item.Id, hasStreams);
        if (hasStreams) {
          todayEmptyStreamsCache.delete(idStr);
        } else {
          todayEmptyStreamsCache.set(idStr, Date.now());
        }
      } catch (_) {
        markTodayItemHasStream(item.Id, false);
        todayEmptyStreamsCache.set(idStr, Date.now());
      }
    }),
  );
  return items.filter(function (item) {
    return !isUnreleasedItem(item, now) && (!isReleasedToday(item, now) || isTodayItemStreamVerified(item.Id));
  });
}

export function getNextUp(limit) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const targetLimit = limit || 20;
  const fetchLimit = Math.max(targetLimit * 2, 40);
  const params = new URLSearchParams({
    userId: userId,
    Limit: String(fetchLimit),
    Fields: 'PrimaryImageAspectRatio,Genres,People,RunTimeTicks,PremiereDate,EndDate',
    enableResumable: 'false',
  });
  const path = '/Shows/NextUp?' + params.toString();
  return Promise.all([
    cached(path, function () {
      return rowJson(path, 'personal', { priority: true, rank: 1 });
    }, SHORT_CACHE_TTL_MS),
    getHiddenNextUpSeries(),
  ]).then(async function (results) {
    const rawItems = (results[0] && results[0].Items) || [];
    const verifiedItems = await verifyTodayEpisodesHaveStreams(rawItems);
    const items = filterReleasedItems(verifiedItems);
    const hidden = results[1];
    const filtered = !hidden.length
      ? items
      : items.filter(function (item) {
          return hidden.indexOf(item.SeriesId) === -1;
        });
    return filtered.slice(0, targetLimit);
  });
}

function getHiddenNextUpSeries() {
  return cached('next-up-hidden', function () {
    return rowJson('/Jellio/next-up-hidden', 'personal', { priority: true, rank: 1 });
  }, SHORT_CACHE_TTL_MS).catch(function () {
    return [];
  });
}

export function hideSeriesFromNextUp(seriesId) {
  invalidateCache('next-up-hidden');
  return fetch(getServerAddress() + '/Jellio/next-up-hidden/' + encodeURIComponent(seriesId), {
    method: 'POST',
    headers: getAuthHeaders(),
  }).then(function (response) {
    if (!response.ok) throw new Error('Failed to hide series from Up Next');
    invalidateUserDataRows();
  });
}

export function getSeriesNextUp(seriesId) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const params = new URLSearchParams({
    userId: userId,
    seriesId: seriesId,
    Limit: '1',
    Fields: 'PrimaryImageAspectRatio,RunTimeTicks,PremiereDate,EndDate',
  });
  const path = '/Shows/NextUp?' + params.toString();
  return cached(path, function () {
    return getJson(path);
  }, SHORT_CACHE_TTL_MS).then(async function (result) {
    const rawItems = (result && result.Items) || [];
    const items = await verifyTodayEpisodesHaveStreams(rawItems);
    return items[0] || null;
  });
}

export function getRecentlyCompleted(limit) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const params = new URLSearchParams({
    Recursive: 'true',
    IncludeItemTypes: 'Movie,Series',
    Filters: 'IsPlayed',
    SortBy: 'DatePlayed',
    SortOrder: 'Descending',
    Limit: String(limit),
    Fields: 'Genres,People,ProductionYear,CommunityRating,RunTimeTicks',
  });
  return rowJson('/Users/' + userId + '/Items?' + params.toString(), 'personal', { rank: 5 }).then(function (result) {
    return (result && result.Items) || [];
  });
}

export async function getRecommendationCandidates(seed, limit) {
  const userId = getCurrentUserId();
  if (!userId) return [];

  const genres = seed.Genres || [];
  const people = (seed.People || [])
    .filter(function (person) {
      return person.Id && (person.Type === 'Actor' || person.Type === 'Director');
    })
    .slice(0, 5);

  const base =
    '/Users/' +
    userId +
    '/Items?Recursive=true&IncludeItemTypes=Movie,Series&Limit=' +
    (limit || 100) +
    '&Fields=Genres,ProductionYear,CommunityRating,RunTimeTicks&SortBy=CommunityRating&SortOrder=Descending';

  const jobs = [];
  if (genres.length) {
    jobs.push(
      rowJson(base + '&Genres=' + encodeURIComponent(genres.join('|')), 'rows')
        .then(function (result) {
          return { tag: 'genre', items: (result && result.Items) || [] };
        })
        .catch(function () {
          return { tag: 'genre', items: [] };
        }),
    );
  }
  if (people.length) {
    const personIds = people
      .map(function (person) {
        return person.Id;
      })
      .join(',');
    jobs.push(
      rowJson(base + '&PersonIds=' + personIds, 'rows')
        .then(function (result) {
          return { tag: 'person', items: (result && result.Items) || [] };
        })
        .catch(function () {
          return { tag: 'person', items: [] };
        }),
    );
  }
  if (!jobs.length) return [];

  const results = await Promise.all(jobs);
  const byId = {};
  results.forEach(function (result) {
    result.items.forEach(function (item) {
      let entry = byId[item.Id];
      if (!entry) entry = byId[item.Id] = { item: item, viaPerson: false };
      if (result.tag === 'person') entry.viaPerson = true;
    });
  });
  return shuffleInPlace(
    Object.keys(byId).map(function (id) {
      return byId[id];
    }),
  );
}

function shuffleInPlace(items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = items[i];
    items[i] = items[j];
    items[j] = tmp;
  }
  return items;
}

function getPersonItems(personId, limit) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const params = new URLSearchParams({
    Recursive: 'true',
    IncludeItemTypes: 'Movie,Series',
    PersonIds: personId,
    Limit: String(limit || 20),
    Fields: 'ProductionYear,CommunityRating,Genres',
    SortBy: 'CommunityRating',
    SortOrder: 'Descending',
  });
  return rowJson('/Users/' + userId + '/Items?' + params.toString(), 'people').then(function (result) {
    return (result && result.Items) || [];
  });
}

export function itemTypesForKind(collectionType) {
  if (collectionType === 'movies') return 'Movie';
  if (collectionType === 'books') return 'Book,AudioBook';
  return 'Series';
}

export function audiobookGroupKey(item) {
  return (item.ParentId || '') + '|' + (item.Album || '');
}

export function audiobookTitle(item, trackCount) {
  if (item.Album) return item.Album;
  if (trackCount > 1) {
    const parts = String(item.Path || '').split(/[\\/]/).filter(Boolean);
    if (parts.length >= 2) return parts[parts.length - 2];
  }
  return item.Name;
}

export function collapseAudiobookTracks(items) {
  const counts = new Map();
  (items || []).forEach(function (item) {
    if (item && item.Type === 'AudioBook') {
      const key = audiobookGroupKey(item);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  });
  const seen = new Set();
  const out = [];
  (items || []).forEach(function (item) {
    if (!item || item.Type !== 'AudioBook') {
      out.push(item);
      return;
    }
    const key = audiobookGroupKey(item);
    if (seen.has(key)) return;
    seen.add(key);
    const title = audiobookTitle(item, counts.get(key));
    out.push(title !== item.Name ? Object.assign({}, item, { Name: title, SortName: title }) : item);
  });
  return out;
}

export function getLibraryItems(parentId, collectionType, options) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const opts = options || {};
  const params = new URLSearchParams({
    ParentId: parentId,
    Recursive: 'true',
    IncludeItemTypes: itemTypesForKind(collectionType),
    SortBy: opts.sortBy || 'SortName',
    SortOrder: opts.sortOrder || 'Ascending',
    Fields: 'PrimaryImageAspectRatio,ProductionYear,CommunityRating,Path',
    Limit: String(opts.limit || 100),
    StartIndex: String(opts.startIndex || 0),
  });
  if (opts.genre) params.set('Genres', opts.genre);
  const path = '/Users/' + userId + '/Items?' + params.toString();
  return cached(path, function () {
    return getJson(path);
  }).then(function (result) {
    if (collectionType !== 'books' || !result) return result;
    return Object.assign({}, result, { Items: collapseAudiobookTracks(result.Items) });
  });
}

export function getSeasons(seriesId) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const culture = getDisplayCulture();
  const path = '/Shows/' + seriesId + '/Seasons?userId=' + userId + (culture ? '&Culture=' + encodeURIComponent(culture) : '');
  return cachedRecent(path, function () {
    return getJson(path);
  }, SHORT_CACHE_TTL_MS, seriesId).then(function (result) {
    return (result && result.Items) || [];
  });
}

// Every episode of a series, all seasons, in order, with watched state.
export function getSeriesEpisodes(seriesId) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const params = new URLSearchParams({ userId: userId, Fields: 'PrimaryImageAspectRatio,PremiereDate,EndDate' });
  return getJson('/Shows/' + seriesId + '/Episodes?' + params.toString(), 30000).then(function (result) {
    return (result && result.Items) || [];
  });
}

export function getEpisodes(seriesId, seasonId) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const culture = getDisplayCulture();
  const params = new URLSearchParams({
    userId: userId,
    Fields: 'Overview,PrimaryImageAspectRatio,PremiereDate,EndDate',
  });
  if (seasonId) params.set('seasonId', seasonId);
  if (culture) params.set('Culture', culture);
  const path = '/Shows/' + seriesId + '/Episodes?' + params.toString();
  return cachedRecent(path, function () {
    return getJson(path);
  }, SHORT_CACHE_TTL_MS, seriesId).then(function (result) {
    return (result && result.Items) || [];
  });
}

export function searchItems(term, limit, signal) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  if (!term) return Promise.resolve([]);
  const culture = getDisplayCulture();
  const params = new URLSearchParams({
    searchTerm: term,
    Recursive: 'true',
    IncludeItemTypes: 'Movie,Series',
    Fields: 'PrimaryImageAspectRatio',
    Limit: String(limit || 50),
  });
  if (culture) params.set('Culture', culture);
  return getJson('/Users/' + userId + '/Items?' + params.toString(), SEARCH_TIMEOUT_MS, signal).then(function (result) {
    return (result && result.Items) || [];
  });
}

export function searchLibrary(term, signal) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  if (!term) return Promise.resolve([]);
  const params = new URLSearchParams({
    searchTerm: 'local:' + term,
    Recursive: 'true',
    IncludeItemTypes: 'Movie,Series',
    Fields: 'PrimaryImageAspectRatio,ProviderIds,ProductionYear',
    Limit: '50',
  });
  return getJson('/Users/' + userId + '/Items?' + params.toString(), SEARCH_TIMEOUT_MS, signal).then(function (result) {
    return (result && result.Items) || [];
  });
}

function searchByType(term, mediaType, signal) {
  if (!term) return Promise.resolve([]);
  const params = new URLSearchParams({ q: term });
  return getJson('/gelato/search/' + mediaType + '?' + params.toString(), SEARCH_TIMEOUT_MS, signal);
}

export function searchMovies(term, signal) {
  return searchByType(term, 'movie', signal);
}

export function searchSeries(term, signal) {
  return searchByType(term, 'series', signal);
}

export function getWatchlistItems(limit) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const params = new URLSearchParams({
    Filters: 'IsFavorite',
    Recursive: 'true',
    IncludeItemTypes: 'Movie,Series',
    Fields: 'PrimaryImageAspectRatio,CommunityRating',
    Limit: String(limit || 100),
  });
  const path = '/Users/' + userId + '/Items?' + params.toString();
  return cached(path, function () {
    return getJson(path);
  }, SHORT_CACHE_TTL_MS).then(function (result) {
    return (result && result.Items) || [];
  });
}

export function getGrouplistIds() {
  return cached('grouplist:ids', function () {
    return getJson('/Jellio/grouplist');
  }, SHORT_CACHE_TTL_MS).then(function (result) {
    return (result && result.ItemIds) || [];
  });
}

export function getGrouplistItems() {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  return getGrouplistIds().then(function (ids) {
    if (!ids.length) return [];
    const params = new URLSearchParams({
      Ids: ids.join(','),
      Fields: 'PrimaryImageAspectRatio,CommunityRating',
    });
    return getJson('/Users/' + userId + '/Items?' + params.toString()).then(function (result) {
      return (result && result.Items) || [];
    });
  });
}

export function addToGrouplist(itemId) {
  return postJson('/Jellio/grouplist/' + itemId).then(function (result) {
    invalidateCache('grouplist:ids');
    return result;
  });
}

export async function removeFromGrouplist(itemId) {
  const response = await fetch(
    getServerAddress() + '/Jellio/grouplist/' + itemId,
    {
      method: 'DELETE',
      headers: Object.assign({ Accept: 'application/json' }, getAuthHeaders()),
    },
  );
  if (!response.ok) {
    const err = new Error('Request failed: Grouplist');
    err.status = response.status;
    throw err;
  }
  invalidateCache('grouplist:ids');
  return response.json();
}

export async function setPlayed(itemId, isPlayed) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const response = await fetch(
    getServerAddress() + '/Users/' + userId + '/PlayedItems/' + itemId,
    {
      method: isPlayed ? 'POST' : 'DELETE',
      headers: Object.assign({ Accept: 'application/json' }, getAuthHeaders()),
    },
  );
  if (!response.ok) {
    const err = new Error('Request failed: PlayedItems');
    err.status = response.status;
    throw err;
  }
  invalidateUserDataRows();
  if (isPlayed) {
    maybeRemoveFromWatchlistAfterWatching(itemId).catch(function () {});
  }
  return response.json();
}

export async function maybeRemoveFromWatchlistAfterWatching(itemId) {
  if (!isRemoveFromWatchlistAfterWatchingEnabled()) return;
  try {
    const item = await getItem(itemId);
    if (!item) return;

    if (item.Type === 'Movie') {
      if (item.UserData && item.UserData.IsFavorite) {
        await setWatchlist(item.Id, false);
        item.UserData.IsFavorite = false;
      }
      return;
    }

    if (item.Type === 'Episode') {
      if (item.UserData && item.UserData.IsFavorite) {
        await setWatchlist(item.Id, false);
        item.UserData.IsFavorite = false;
      }

      if (item.SeasonId) {
        try {
          const season = await getItem(item.SeasonId);
          if (season && season.UserData && season.UserData.IsFavorite) {
            const episodes = await getEpisodes(item.SeriesId, item.SeasonId);
            const regularEpisodes = episodes.filter(function (ep) {
              return ep.ParentIndexNumber == null || ep.ParentIndexNumber > 0;
            });
            if (regularEpisodes.length > 0) {
              const allDone = regularEpisodes.every(function (ep) {
                if (isUnreleasedItem(ep)) return false;
                return ep.Id === itemId || (ep.UserData && ep.UserData.Played);
              });
              if (allDone) {
                await setWatchlist(season.Id, false);
                season.UserData.IsFavorite = false;
              }
            }
          }
        } catch (err) {}
      }

      if (item.SeriesId) {
        try {
          const series = await getItem(item.SeriesId);
          if (series && series.UserData && series.UserData.IsFavorite) {
            if (String(series.Status || '').toLowerCase() === 'ended') {
              const episodes = await getSeriesEpisodes(series.Id);
              const regularEpisodes = episodes.filter(function (ep) {
                return ep.ParentIndexNumber == null || ep.ParentIndexNumber > 0;
              });
              if (regularEpisodes.length > 0) {
                const allDone = regularEpisodes.every(function (ep) {
                  if (isUnreleasedItem(ep)) return false;
                  return ep.Id === itemId || (ep.UserData && ep.UserData.Played);
                });
                if (allDone) {
                  await setWatchlist(series.Id, false);
                  series.UserData.IsFavorite = false;
                }
              }
            }
          }
        } catch (err) {}
      }
      return;
    }

    if (item.Type === 'Season') {
      if (item.UserData && item.UserData.IsFavorite) {
        try {
          const episodes = await getEpisodes(item.SeriesId, item.Id);
          const regularEpisodes = episodes.filter(function (ep) {
            return ep.ParentIndexNumber == null || ep.ParentIndexNumber > 0;
          });
          if (regularEpisodes.length > 0) {
            const allDone = regularEpisodes.every(function (ep) {
              if (isUnreleasedItem(ep)) return false;
              return ep.Id === itemId || (ep.UserData && ep.UserData.Played);
            });
            if (allDone) {
              await setWatchlist(item.Id, false);
              item.UserData.IsFavorite = false;
            }
          }
        } catch (err) {}
      }

      if (item.SeriesId) {
        try {
          const series = await getItem(item.SeriesId);
          if (series && series.UserData && series.UserData.IsFavorite) {
            if (String(series.Status || '').toLowerCase() === 'ended') {
              const episodes = await getSeriesEpisodes(series.Id);
              const regularEpisodes = episodes.filter(function (ep) {
                return ep.ParentIndexNumber == null || ep.ParentIndexNumber > 0;
              });
              if (regularEpisodes.length > 0) {
                const allDone = regularEpisodes.every(function (ep) {
                  if (isUnreleasedItem(ep)) return false;
                  return ep.UserData && ep.UserData.Played;
                });
                if (allDone) {
                  await setWatchlist(series.Id, false);
                  series.UserData.IsFavorite = false;
                }
              }
            }
          }
        } catch (err) {}
      }
      return;
    }

    if (item.Type === 'Series') {
      if (item.UserData && item.UserData.IsFavorite && String(item.Status || '').toLowerCase() === 'ended') {
        const episodes = await getSeriesEpisodes(item.Id);
        const regularEpisodes = episodes.filter(function (ep) {
          return ep.ParentIndexNumber == null || ep.ParentIndexNumber > 0;
        });
        if (regularEpisodes.length > 0) {
          const allDone = regularEpisodes.every(function (ep) {
            if (isUnreleasedItem(ep)) return false;
            return ep.UserData && ep.UserData.Played;
          });
          if (allDone) {
            await setWatchlist(item.Id, false);
            item.UserData.IsFavorite = false;
          }
        }
      }
      return;
    }
  } catch (err) {
  }
}

const KNOWN_ANTHOLOGIES = [
  'black mirror',
  'love, death & robots',
  'love death and robots',
  'love death & robots',
  'love death + robots',
  'twilight zone',
  'cabinet of curiosities',
  'electric dreams',
  'room 104',
  'star wars: visions',
  'star wars visions',
  'inside no. 9',
  'inside no 9',
  'modern love',
  'oats studios',
  'tales from the crypt',
  'tales from the loop',
  'american horror stories',
];

export function isEpisodicAnthology(series) {
  if (!series) return false;
  const genres = series.Genres || [];
  if (genres.some(function (g) { return g && g.toLowerCase().includes('anthology'); })) return true;
  const tags = series.Tags || [];
  if (tags.some(function (t) { return t && t.toLowerCase().includes('anthology'); })) return true;
  const name = (series.Name || '').toLowerCase();
  return KNOWN_ANTHOLOGIES.some(function (title) { return name.includes(title); });
}

export async function autoCompletePreviousEpisodesIfSkipped(episode) {
  if (!episode || episode.Type !== 'Episode') return;
  const seriesId = episode.SeriesId;
  const currentSeasonNum = episode.ParentIndexNumber;
  const currentEpNum = episode.IndexNumber;
  if (!seriesId || currentSeasonNum == null || currentEpNum == null || currentSeasonNum <= 0) {
    return;
  }

  let series = null;
  try {
    series = await getItem(seriesId);
  } catch (err) {
    console.warn('Jellio: could not load series metadata for anthology check', err);
  }

  if (isEpisodicAnthology(series)) {
    console.log('Jellio: Skipping auto-complete for anthology series:', series && series.Name);
    return;
  }

  try {
    const userId = getCurrentUserId();
    if (!userId) return;
    const allEpisodes = await getSeriesEpisodes(seriesId);
    const toMark = (allEpisodes || []).filter(function (ep) {
      if (!ep || !ep.Id || isUnreleasedItem(ep)) return false;
      if (typeof ep.IndexNumber !== 'number') return false;
      const sNum = ep.ParentIndexNumber || 0;
      const eNum = ep.IndexNumber;
      if (sNum <= 0) return false;
      const isBefore = sNum < currentSeasonNum || (sNum === currentSeasonNum && eNum < currentEpNum);
      const isUnfinished = !(ep.UserData && ep.UserData.Played) || (ep.UserData && ep.UserData.PlaybackPositionTicks > 0);
      return isBefore && isUnfinished;
    });

    if (toMark.length > 0) {
      console.info('Jellio: Auto-completing ' + toMark.length + ' previous skipped episodes for series', (series && series.Name) || seriesId);
      const culture = getDisplayCulture();
      for (let i = 0; i < toMark.length; i++) {
        const prevEp = toMark[i];
        try {
          await fetch(
            getServerAddress() + '/Users/' + userId + '/PlayedItems/' + prevEp.Id,
            {
              method: 'POST',
              headers: Object.assign({ Accept: 'application/json' }, getAuthHeaders()),
            },
          );
          invalidateCache('item:' + prevEp.Id);
          if (culture) invalidateCache('item:' + prevEp.Id + ':' + culture);
        } catch (err) {
          console.warn('Jellio: failed to mark previous episode played', prevEp.Id, err);
        }
      }
      invalidateUserDataRows();
    }
  } catch (err) {
    console.warn('Jellio: could not auto-complete previous episodes', err);
  }
}

export async function setWatchlist(itemId, isWatchlisted) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const response = await fetch(
    getServerAddress() + '/Users/' + userId + '/FavoriteItems/' + itemId,
    {
      method: isWatchlisted ? 'POST' : 'DELETE',
      headers: Object.assign({ Accept: 'application/json' }, getAuthHeaders()),
    },
  );
  if (!response.ok) {
    const err = new Error('Request failed: FavoriteItems');
    err.status = response.status;
    throw err;
  }
  // Adding a title to the Watchlist brings it back to Upcoming if it was
  // taken out.
  if (isWatchlisted) setUpcomingHidden(itemId, false).catch(function () {});
  invalidateUserDataRows();
  return response.json();
}

export async function setItemRating(itemId, likes) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const path = '/Users/' + userId + '/Items/' + itemId + '/Rating' + (likes == null ? '' : '?likes=' + likes);
  const response = await fetch(getServerAddress() + path, {
    method: likes == null ? 'DELETE' : 'POST',
    headers: Object.assign({ Accept: 'application/json' }, getAuthHeaders()),
  });
  if (!response.ok) {
    const err = new Error('Request failed: Rating');
    err.status = response.status;
    throw err;
  }
  return response.json();
}

export function getPlaybackInfo(itemId, startTimeTicks, mediaSourceId, audioStreamIndex, subtitleStreamIndex) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const body = {
    UserId: userId,
    StartTimeTicks: startTimeTicks || 0,
    EnableDirectPlay: true,
    EnableDirectStream: true,
    EnableTranscoding: true,
    AutoOpenLiveStream: true,
  };
  if (mediaSourceId) body.MediaSourceId = mediaSourceId;
  if (audioStreamIndex != null) body.AudioStreamIndex = audioStreamIndex;
  if (subtitleStreamIndex != null) body.SubtitleStreamIndex = subtitleStreamIndex;
  return postJson('/Items/' + itemId + '/PlaybackInfo', body, NEGOTIATION_TIMEOUT_MS);
}

// How many downloads the server is converting and whether it has room
// for this user's, plus whether it encodes HEVC in hardware.
export function getConversionStatus() {
  return getJson('/Jellio/downloads/conversions', 8000);
}

export function getDownloadPlaybackInfo(itemId, mediaSourceId, audioStreamIndex, maxHeight, maxBitrate, hevc) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const codecs = hevc ? ['hevc', 'h264'] : ['h264'];
  const body = {
    UserId: userId,
    StartTimeTicks: 0,
    EnableDirectPlay: true,
    EnableDirectStream: true,
    EnableTranscoding: true,
    AllowVideoStreamCopy: true,
    AllowAudioStreamCopy: true,
    AutoOpenLiveStream: true,
    MaxStreamingBitrate: maxBitrate || 120000000,
    DeviceProfile: {
      Name: 'Jellio download',
      MaxStreamingBitrate: maxBitrate || 120000000,
      MaxStaticBitrate: maxBitrate || 120000000,
      DirectPlayProfiles: maxHeight
        ? [{ Container: 'mp4,m4v', Type: 'Video', VideoCodec: codecs.join(','), AudioCodec: 'aac,mp3' }]
        : [{ Type: 'Video' }],
      TranscodingProfiles: [
        {
          Container: 'mp4',
          Type: 'Video',
          Protocol: 'http',
          Context: 'Streaming',
          VideoCodec: codecs.join(','),
          AudioCodec: 'aac',
          MaxAudioChannels: '2',
        },
      ],
      CodecProfiles: maxHeight
        ? codecs.map((codec) => ({ Type: 'Video', Codec: codec, Conditions: [{ Condition: 'LessThanEqual', Property: 'Height', Value: String(maxHeight) }] }))
        : [],
      SubtitleProfiles: [{ Format: 'vtt', Method: 'External' }],
    },
  };
  if (mediaSourceId) body.MediaSourceId = mediaSourceId;
  if (audioStreamIndex != null) body.AudioStreamIndex = audioStreamIndex;
  return postJson('/Items/' + itemId + '/PlaybackInfo', body, NEGOTIATION_TIMEOUT_MS);
}

const prefetchedItemIds = new Set();
export function prefetchStreams(itemId) {
  if (!itemId || prefetchedItemIds.has(itemId)) return Promise.resolve();
  prefetchedItemIds.add(itemId);
  return fetch(getServerAddress() + '/gelato/prefetch/' + itemId, {
    method: 'POST',
    headers: getAuthHeaders(),
  })
    .then(function () {})
    .catch(function () {
      prefetchedItemIds.delete(itemId);
    });
}

// Syncs the stream lists of a few titles on the server, one after another;
// answers which were queued and which were already warm.
export function prefetchStreamsBatch(itemIds, probe) {
  return fetch(getServerAddress() + '/gelato/prefetch-batch', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, getAuthHeaders()),
    body: JSON.stringify({ ItemIds: itemIds, Probe: !!probe }),
  })
    .then(function (response) {
      if (!response.ok) return null;
      return response.json().catch(function () {
        return null;
      });
    })
    .catch(function () {
      return null;
    });
}

const warmCache = new Map();
const WARM_CACHE_MS = 30 * 1000;

// { sourceId: warmedAtUtc } for the sources that will start fast now; null
// when the server can't say.
export function getWarmSources(itemId, options) {
  const hit = warmCache.get(itemId);
  if (hit && Date.now() - hit.at < WARM_CACHE_MS && !(options && options.forceFresh)) return hit.promise;
  const promise = fetch(getServerAddress() + '/gelato/warm/' + itemId, { headers: getAuthHeaders(), cache: 'no-store' })
    .then(function (response) {
      return response.ok ? response.json() : null;
    })
    .then(function (data) {
      return data && typeof data === 'object' ? data : null;
    })
    .catch(function () {
      return null;
    });
  warmCache.set(itemId, { at: Date.now(), promise: promise });
  return promise;
}

const tierCache = new Map();

// { sourceId: qualityTier }, e.g. "2160p-dv"; empty when the server can't say.
export function getQualityTiers(itemId) {
  if (tierCache.has(itemId)) return tierCache.get(itemId);
  const promise = fetch(getServerAddress() + '/gelato/tiers/' + itemId, { headers: getAuthHeaders() })
    .then(function (response) {
      return response.ok ? response.json() : {};
    })
    .then(function (data) {
      return data && typeof data === 'object' ? data : {};
    })
    .catch(function () {
      tierCache.delete(itemId);
      return {};
    });
  tierCache.set(itemId, promise);
  return promise;
}

const mediaSourcesCache = new Map();
// The last list loaded per title, kept past the cache's lifetime so a failed
// reload still leaves something to fail over to.
const lastMediaSources = new Map();

export function getLastMediaSources(itemId) {
  return lastMediaSources.get(String(itemId)) || null;
}
const mediaSourcesInFlight = new Map();
const MEDIA_SOURCES_TTL_MS = 5 * 60 * 1000;

export { filterPlayableSources };

// With no releases found, Gelato lists a single placeholder source with no
// quality, audio, video, or size info at all.
export function isPlaceholderSource(source) {
  if (!source) return false;
  return !hasStreamInfo(source);
}

export function getMediaSources(itemId, options) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const idStr = String(itemId);
  const now = Date.now();
  if (!options?.forceFresh && mediaSourcesCache.has(idStr)) {
    const entry = mediaSourcesCache.get(idStr);
    if (now - entry.time < MEDIA_SOURCES_TTL_MS) {
      return Promise.resolve(entry.sources);
    }
    mediaSourcesCache.delete(idStr);
  }
  // Callers asking while a lookup runs share it.
  if (!options?.forceFresh && mediaSourcesInFlight.has(idStr)) return mediaSourcesInFlight.get(idStr);
  const params = new URLSearchParams({ Fields: 'MediaSources,OriginalTitle,PremiereDate,ProductionYear' });
  const request = getJson('/Users/' + userId + '/Items/' + itemId + '?' + params.toString(), options && options.timeoutMs)
    .then(function (result) {
      const sources = filterPlayableSources(result && result.MediaSources);
      if (sources.length) {
        mediaSourcesCache.set(idStr, { time: Date.now(), sources: sources });
        lastMediaSources.set(idStr, { at: Date.now(), sources: sources });
      } else {
        mediaSourcesCache.delete(idStr);
      }
      return sources;
    })
    .finally(function () {
      if (mediaSourcesInFlight.get(idStr) === request) mediaSourcesInFlight.delete(idStr);
    });
  mediaSourcesInFlight.set(idStr, request);
  return request;
}

export const TICKS_PER_SECOND = 10000000;

const MATROSKA_CONTAINERS = new Set(['mkv', 'matroska']);
let matroskaContainerSupport;

function supportsMatroskaContainer() {
  if (matroskaContainerSupport !== undefined) return matroskaContainerSupport;
  if (typeof document === 'undefined') {
    matroskaContainerSupport = false;
    return matroskaContainerSupport;
  }
  const probe = document.createElement('video');
  if (typeof probe.canPlayType !== 'function') {
    matroskaContainerSupport = false;
    return matroskaContainerSupport;
  }
  const support = probe.canPlayType('video/x-matroska; codecs="avc1.640028, mp4a.40.2"');
  matroskaContainerSupport = support === 'probably' || support === 'maybe';
  return matroskaContainerSupport;
}

function normalizeStreamContainer(rawContainer) {
  const container = String(rawContainer || '').toLowerCase();
  if (container === 'mov') return 'mp4';
  return MATROSKA_CONTAINERS.has(container) ? 'mkv' : container;
}

export function supportsNativeHls() {
  if (typeof document === 'undefined') return false;
  const probe = document.createElement('video');
  if (typeof probe.canPlayType !== 'function') return false;
  const support = probe.canPlayType('application/vnd.apple.mpegurl');
  return support === 'probably' || support === 'maybe';
}

const LEGACY_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);
const LEGACY_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

const CONTAINER_MIME = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/mp4',
  webm: 'video/webm',
};

const H264_PROFILES = {
  baseline: '42',
  'constrained baseline': '42',
  extended: '58',
  main: '4d',
  high: '64',
  'high 10': '6e',
  'high 4:2:2': '7a',
  'high 4:4:4 predictive': 'f4',
};

function hex2(value) {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
}

// The codec string a canPlayType() query takes, or null for a codec no
// engine here plays.
function videoCodecString(stream) {
  const codec = String(stream.Codec || '').toLowerCase();
  const depth = Number(stream.BitDepth) || 8;
  const level = Number(stream.Level) || 0;
  const profile = String(stream.Profile || '').toLowerCase();
  if (codec === 'h264') return 'avc1.' + (H264_PROFILES[profile] || '64') + '00' + hex2(level || 40);
  if (codec === 'hevc') return 'hvc1.' + (depth > 8 || profile === 'main 10' ? '2.4' : '1.6') + '.L' + (level || 153) + '.B0';
  if (codec === 'vp9') return depth > 8 ? 'vp09.02.10.10' : 'vp09.00.10.08';
  if (codec === 'av1') return 'av01.0.13M.' + (depth > 8 ? '10' : '08');
  if (codec === 'vp8') return 'vp8';
  return null;
}

function audioCodecString(stream) {
  const codec = String(stream.Codec || '').toLowerCase();
  if (codec === 'aac') return /he-aac/i.test(String(stream.Profile || '')) ? 'mp4a.40.5' : 'mp4a.40.2';
  return { mp3: 'mp3', opus: 'opus', vorbis: 'vorbis', flac: 'flac', ac3: 'ac-3', eac3: 'ec-3', alac: 'alac' }[codec] || null;
}

const playTypeAnswers = new Map();

function enginePlays(mime, codecs) {
  const type = mime + '; codecs="' + codecs.join(', ') + '"';
  if (!playTypeAnswers.has(type)) {
    const probe = document.createElement('video');
    playTypeAnswers.set(type, probe.canPlayType(type) !== '');
  }
  return playTypeAnswers.get(type);
}

export function canBrowserDirectPlay(mediaSource) {
  if (!mediaSource) return false;
  if (mediaSource.SupportsDirectPlay === false && mediaSource.SupportsDirectStream === false) {
    return false;
  }
  const container = normalizeStreamContainer(mediaSource.Container);
  const streams = mediaSource.MediaStreams || [];
  const video = streams.filter(function (stream) {
    return stream.Type === 'Video';
  })[0];
  // The track that plays by default, not just the first one listed.
  const audio =
    streams.filter(function (stream) {
      return stream.Type === 'Audio' && stream.Index === mediaSource.DefaultAudioStreamIndex;
    })[0] ||
    streams.filter(function (stream) {
      return stream.Type === 'Audio';
    })[0];

  const canProbe = typeof document !== 'undefined' && typeof document.createElement('video').canPlayType === 'function';
  if (!canProbe) {
    const legacyMatroska = MATROSKA_CONTAINERS.has(container) && supportsMatroskaContainer();
    if (!['mp4', 'webm', 'm4v'].includes(container) && !legacyMatroska) return false;
    if (video && !LEGACY_VIDEO_CODECS.has(String(video.Codec || '').toLowerCase())) return false;
    if (audio && !LEGACY_AUDIO_CODECS.has(String(audio.Codec || '').toLowerCase())) return false;
    return true;
  }

  const mime = CONTAINER_MIME[container];
  if (!mime) return false;
  // Dolby Vision profile 5 has no HDR10 layer to fall back to, so it
  // shows with wrong colours anywhere but a player built for it.
  if (video && video.VideoRangeType === 'DOVI') return false;
  const codecs = [];
  if (video) {
    const codec = videoCodecString(video);
    if (!codec) return false;
    codecs.push(codec);
  }
  if (audio) {
    const codec = audioCodecString(audio);
    if (!codec) return false;
    codecs.push(codec);
  }
  if (!codecs.length) return false;
  // Each stream has to be playable on its own as well as together, so a
  // video the engine plays isn't held back by an audio track it can't.
  return enginePlays(mime, codecs) && codecs.every((codec) => enginePlays(mime, [codec]));
}

function directPlayReport() {
  const video = {
    h264: 'avc1.640028',
    'h264 high10': 'avc1.6e0028',
    hevc: 'hvc1.1.6.L153.B0',
    'hevc main10': 'hvc1.2.4.L153.B0',
    vp9: 'vp09.00.10.08',
    av1: 'av01.0.13M.08',
    vp8: 'vp8',
  };
  const audio = { aac: 'mp4a.40.2', mp3: 'mp3', opus: 'opus', vorbis: 'vorbis', flac: 'flac', ac3: 'ac-3', eac3: 'ec-3', alac: 'alac' };
  const report = { video: {}, audio: {} };
  Object.keys(video).forEach(function (name) {
    report.video[name] = ['video/mp4', 'video/webm', 'video/x-matroska'].filter((mime) => enginePlays(mime, [video[name]]));
  });
  Object.keys(audio).forEach(function (name) {
    report.audio[name] = ['video/mp4', 'video/webm', 'video/x-matroska'].filter((mime) => enginePlays(mime, [audio[name]]));
  });
  return report;
}

const FALLBACK_VIDEO_BITRATE = 20000000;

function estimateVideoBitrate(mediaSource) {
  const streams = (mediaSource && mediaSource.MediaStreams) || [];
  const video = streams.filter(function (stream) {
    return stream.Type === 'Video';
  })[0];
  if (video && video.BitRate) return video.BitRate;
  if (mediaSource && mediaSource.Bitrate) return mediaSource.Bitrate;
  return FALLBACK_VIDEO_BITRATE;
}

export function getAudioStreams(mediaSource) {
  return (mediaSource.MediaStreams || []).filter(function (stream) {
    return stream.Type === 'Audio';
  });
}

export function matchAudioStreamIndex(mediaSource, languagePreference) {
  if (!languagePreference) return null;
  const wanted = languageName(languagePreference);
  const streams = getAudioStreams(mediaSource);
  const match = streams.find(function (stream) {
    return stream.Language && languageName(stream.Language) === wanted;
  });
  return match ? match.Index : null;
}

export function matchSubtitleStream(mediaSource, languagePreference) {
  if (!languagePreference) return null;
  const wanted = languageName(languagePreference);
  const streams = getSubtitleStreams(mediaSource).filter(function (stream) {
    return stream.Language && languageName(stream.Language) === wanted;
  });
  if (!streams.length) return null;
  return streams.find(function (stream) {
    return stream.IsTextSubtitleStream;
  }) || null;
}

export function buildStreamUrl(itemId, mediaSource, startTimeTicks, options) {
  const opts = options || {};
  const token = getAccessToken();
  const mediaSourceId = (mediaSource && mediaSource.Id) || itemId;
  const forceTranscode =
    !!opts.forceTranscode ||
    opts.burnInSubtitleStreamIndex != null ||
    (opts.audioStreamIndex != null && opts.audioStreamIndex !== mediaSource.DefaultAudioStreamIndex);
  const directPlay = !forceTranscode && canBrowserDirectPlay(mediaSource);
  const useHls = !directPlay && supportsNativeHls();
  const container = directPlay ? normalizeStreamContainer(mediaSource && mediaSource.Container) || 'mp4' : 'mp4';

  const params = new URLSearchParams({
    MediaSourceId: mediaSourceId,
    DeviceId: getDeviceId(),
    ApiKey: token || '',
  });
  if (!useHls) {
    params.set('StartTimeTicks', String(startTimeTicks || 0));
  }
  if (opts.playSessionId) {
    params.set('PlaySessionId', opts.playSessionId);
  }
  if (directPlay) {
    params.set('Static', 'true');
  } else if (avoidingVideoTranscodes()) {
    const codecs = copyableVideoCodecs(browserCaps());
    params.set('VideoCodec', codecs.join(','));
    params.set('AudioCodec', 'aac');
    params.set('AudioBitRate', '192000');
    params.set('AllowVideoStreamCopy', 'true');
    params.set('AllowAudioStreamCopy', 'true');
    codecs.filter((codec) => codec !== 'h264').forEach(function (codec) {
      params.set(codec + '-videorangetype', 'SDR,HDR10,HDR10Plus,HLG,DOVIWithHDR10,DOVIWithHLG,DOVIWithSDR,DOVIWithHDR10Plus');
    });
    if (useHls) params.set('SegmentContainer', 'mp4');
  } else {
    params.set('VideoCodec', 'h264');
    params.set('AudioCodec', 'aac');
    params.set('VideoBitRate', String(estimateVideoBitrate(mediaSource)));
    params.set('AudioBitRate', '192000');
  }
  if (opts.audioStreamIndex != null) {
    params.set('AudioStreamIndex', String(opts.audioStreamIndex));
  }
  if (opts.burnInSubtitleStreamIndex != null) {
    params.set('SubtitleStreamIndex', String(opts.burnInSubtitleStreamIndex));
    params.set('SubtitleMethod', 'Encode');
  }
  const path = useHls ? '/Videos/' + itemId + '/master.m3u8' : '/Videos/' + itemId + '/stream.' + container;
  return getServerAddress() + path + '?' + params.toString();
}

export function buildCastStreamUrl(itemId, mediaSource, startTimeTicks, options) {
  const opts = options || {};
  const token = getAccessToken();
  const mediaSourceId = (mediaSource && mediaSource.Id) || itemId;

  const params = new URLSearchParams({
    MediaSourceId: mediaSourceId,
    DeviceId: getDeviceId(),
    ApiKey: token || '',
    Static: 'false',
    VideoCodec: 'h264',
    AudioCodec: 'aac',
    AudioBitRate: '192000',
    AllowVideoStreamCopy: 'true',
    AllowAudioStreamCopy: 'true',
    StartTimeTicks: String(startTimeTicks || 0),
  });

  if (opts.audioStreamIndex != null) {
    params.set('AudioStreamIndex', String(opts.audioStreamIndex));
  }
  if (opts.subtitleStreamIndex != null) {
    params.set('SubtitleStreamIndex', String(opts.subtitleStreamIndex));
    params.set('SubtitleMethod', 'Encode');
  }

  return getServerAddress() + '/Videos/' + itemId + '/stream.mp4?' + params.toString();
}

export function reportPlaybackStart(itemId, mediaSourceId, positionTicks) {
  markPlaybackStarted(itemId, mediaSourceId);
  if (isOffline()) return Promise.resolve();
  return postJson('/Sessions/Playing', {
    ItemId: itemId,
    MediaSourceId: mediaSourceId,
    PositionTicks: positionTicks || 0,
    CanSeek: true,
    PlayMethod: 'DirectStream',
  }).then(invalidateUserDataRows).catch(function (err) {
    console.warn('Jellio: reportPlaybackStart failed', err);
  });
}

export function reportPlaybackProgress(itemId, mediaSourceId, positionTicks, isPaused) {
  // A Progress after Stopped would recreate the session on the server.
  if (isOffline() || !canReportProgress(itemId, mediaSourceId)) return Promise.resolve();
  return postJson('/Sessions/Playing/Progress', {
    ItemId: itemId,
    MediaSourceId: mediaSourceId,
    PositionTicks: positionTicks || 0,
    IsPaused: !!isPaused,
    CanSeek: true,
    PlayMethod: 'DirectStream',
  }).then(function () {
    // A progress milestone, not every report.
    invalidateUserDataRowsThrottled(2 * 60000);
  }).catch(function (err) {
    console.warn('Jellio: reportPlaybackProgress failed', err);
  });
}

export function reportPlaybackStopped(itemId, mediaSourceId, positionTicks) {
  markPlaybackStopped(itemId, mediaSourceId);
  // Offline (a downloaded video or audiobook): the position is sent as
  // the item's user data once the server is back.
  if (isOffline()) {
    return queueSync('POST', '/UserItems/' + itemId + '/UserData', { PlaybackPositionTicks: positionTicks || 0 }).catch(() => {});
  }
  return postJson('/Sessions/Playing/Stopped', {
    ItemId: itemId,
    MediaSourceId: mediaSourceId,
    PositionTicks: positionTicks || 0,
  }).then(invalidateUserDataRows).catch(function (err) {
    console.warn('Jellio: reportPlaybackStopped failed', err);
  });
}

export function startSleepTimer(minutes) {
  return postJson('/Jellio/sleep-timer/start', { Minutes: minutes });
}

export async function cancelSleepTimer() {
  const response = await fetch(getServerAddress() + '/Jellio/sleep-timer/cancel', {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  return response.ok;
}

export function getSleepTimerStatus() {
  return getJson('/Jellio/sleep-timer/status');
}

export async function loadVideoTranscodePolicy() {
  const config = await getJellioConfig();
  setVideoTranscodePolicy(config && config.VideoTranscodePolicy);
  return getVideoTranscodePolicy();
}

function serverTranscodeReasons(mediaSource) {
  const url = (mediaSource && mediaSource.TranscodingUrl) || '';
  const match = /[?&]TranscodeReasons=([^&]*)/i.exec(url);
  return match ? decodeURIComponent(match[1]) : null;
}

export function logPlaybackDecision(itemId, mediaSource, classification, policy) {
  const body = {
    ItemId: itemId,
    MediaSourceId: (mediaSource && mediaSource.Id) || null,
    PlayMethod: classification.playMethod,
    Reasons: classification.reasons,
    ServerTranscodeReasons: serverTranscodeReasons(mediaSource),
    Guessed: !!classification.guessed,
    Policy: policy,
  };
  postJson('/Jellio/playback/decision', body).catch(function () {});
}

// One line per switch to another stream: counts and ids, no addresses.
export function logFailoverDecision(entry) {
  const c = entry.counts;
  postJson('/Jellio/playback/failover', {
    ItemId: entry.itemId,
    FailedSourceId: entry.failedSourceId || null,
    Reason: entry.reason,
    Total: c.total,
    Tried: c.tried,
    BadHard: c.badHard,
    BadSoft: c.badSoft,
    AfterLanguage: c.afterLanguage,
    AfterTranscode: c.afterTranscode,
    ListOrigin: entry.loaded.origin,
    ListError: entry.loaded.error ? entry.loaded.error.kind : null,
    ListMs: entry.loaded.error ? entry.loaded.error.ms : null,
    Outcome: entry.outcome.action,
    NextSourceId: entry.outcome.sourceId || null,
    Client: 'web',
  }).catch(function () {});
}

export function getJellioConfig() {
  return cached('jellio-config', function () {
    return getJson('/Jellio/config').then(applyRowCacheConfig);
  }, SHORT_CACHE_TTL_MS);
}

export function getImageUrl(itemId, type, options) {
  const opts = options || {};
  if (opts.tag && (opts.tag.startsWith('http://') || opts.tag.startsWith('https://'))) {
    return opts.tag;
  }
  if (typeof itemId === 'string' && (itemId.startsWith('http://') || itemId.startsWith('https://'))) {
    return itemId;
  }
  const params = new URLSearchParams();
  if (opts.tag) params.set('tag', opts.tag);
  if (opts.maxWidth) params.set('maxWidth', String(opts.maxWidth));
  if (opts.quality) params.set('quality', String(opts.quality));
  const query = params.toString();
  return (
    getServerAddress() +
    '/Items/' +
    itemId +
    '/Images/' +
    (type || 'Primary') +
    (query ? '?' + query : '')
  );
}

export function getUserImageUrl(userId, tag, options) {
  const opts = options || {};
  const params = new URLSearchParams();
  if (tag) params.set('tag', tag);
  if (opts.maxWidth) params.set('maxWidth', String(opts.maxWidth));
  const query = params.toString();
  return getServerAddress() + '/Users/' + userId + '/Images/Primary' + (query ? '?' + query : '');
}

export function getAvatarPresets() {
  return getJson('/Jellio/avatars');
}

export function getAvatarPresetUrl(id) {
  const encodedSegments = String(id).split('/').map(encodeURIComponent).join('/');
  const token = getAccessToken();
  const query = token ? '?ApiKey=' + encodeURIComponent(token) : '';
  return getServerAddress() + '/Jellio/avatars/' + encodedSegments + query;
}

async function uploadUserAvatarBlob(blob) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));

  const contentType = blob.type || 'image/png';

  const base64 = await new Promise(function (resolve, reject) {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = function () {
      resolve(String(reader.result).split(',')[1]);
    };
    reader.readAsDataURL(blob);
  });

  const response = await fetch(getServerAddress() + '/Users/' + userId + '/Images/Primary', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': contentType }, getAuthHeaders()),
    body: base64,
  });
  if (!response.ok) {
    const err = new Error('Could not set avatar');
    err.status = response.status;
    throw err;
  }
  invalidateCurrentUser();
}

export async function setUserAvatar(presetId) {
  const imageResponse = await fetch(getAvatarPresetUrl(presetId));
  if (!imageResponse.ok) {
    throw new Error('Could not load preset avatar');
  }
  const blob = await imageResponse.blob();
  return uploadUserAvatarBlob(blob);
}

export function setUserAvatarFromFile(file) {
  return uploadUserAvatarBlob(file);
}

export function getCalendarEntries() {
  return rowJson('/Jellio/calendar', 'watchlist');
}

// Remove from Upcoming (or put back): a series watched once is otherwise
// followed for years.
export async function setUpcomingHidden(itemId, hidden) {
  const response = await fetch(getServerAddress() + '/Jellio/calendar/hidden/' + encodeURIComponent(itemId), {
    method: hidden ? 'POST' : 'DELETE',
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error('Request failed: calendar/hidden');
  invalidateUserDataRows();
}

export function getNotifications() {
  return getJson('/Jellio/notifications');
}

export function getPendingOverlays(after) {
  return getJson('/Jellio/overlays/pending?after=' + encodeURIComponent(after), 8000);
}

export function getPendingSounds(after) {
  return getJson('/Jellio/sounds/pending?after=' + encodeURIComponent(after), 8000);
}

export function markNotificationsRead() {
  return postJson('/Jellio/notifications/read', {});
}

export function deleteNotification(id) {
  return deleteJson('/Jellio/notifications/' + encodeURIComponent(id));
}

export function clearAllNotifications() {
  return deleteJson('/Jellio/notifications');
}

export async function updateLanguagePreferences(audioLanguage, subtitleLanguage, subtitleMode) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const user = await getCurrentUser();
  const isOff = subtitleLanguage === 'off' || subtitleLanguage === 'none' || subtitleMode === 'None';
  const newConfig = {
    AudioLanguagePreference: audioLanguage || '',
    SubtitleLanguagePreference: isOff ? '' : (subtitleLanguage || ''),
  };
  if (subtitleMode !== undefined) {
    newConfig.SubtitleMode = subtitleMode;
  } else if (isOff) {
    newConfig.SubtitleMode = 'None';
  } else if (user && user.Configuration && user.Configuration.SubtitleMode === 'None') {
    newConfig.SubtitleMode = 'Default';
  }
  const configuration = Object.assign({}, user && user.Configuration, newConfig);
  const response = await fetch(getServerAddress() + '/Users/' + userId + '/Configuration', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json' }, getAuthHeaders()),
    body: JSON.stringify(configuration),
  });
  if (!response.ok) {
    const err = new Error('Request failed: Configuration');
    err.status = response.status;
    throw err;
  }
  invalidateCurrentUser();
}

export function isQuickConnectEnabled() {
  return getJson('/QuickConnect/Enabled').catch(function () {
    return false;
  });
}

export async function authorizeQuickConnect(code) {
  const response = await fetch(getServerAddress() + '/QuickConnect/Authorize?code=' + encodeURIComponent(code), {
    method: 'POST',
    headers: Object.assign({ Accept: 'application/json' }, getAuthHeaders()),
  });
  if (!response.ok) {
    const err = new Error('Request failed: QuickConnect/Authorize');
    err.status = response.status;
    throw err;
  }
  const text = await response.text();
  return text ? JSON.parse(text) : true;
}

function getAllCollections(userId) {
  const pageSize = 100;
  function fetchPage(startIndex) {
    const params = new URLSearchParams({
      IncludeItemTypes: 'BoxSet',
      Recursive: 'true',
      SortBy: 'SortName',
      Limit: String(pageSize),
      StartIndex: String(startIndex),
      Fields: 'ProviderIds,ChildCount',
    });
    return rowJson('/Users/' + userId + '/Items?' + params.toString(), 'collections');
  }

  return fetchPage(0).then(function (first) {
    const items = (first && first.Items) || [];
    const total = (first && first.TotalRecordCount) || items.length;
    if (items.length < pageSize || items.length >= total) return items;

    const laterPages = [];
    for (let startIndex = pageSize; startIndex < total; startIndex += pageSize) {
      laterPages.push(fetchPage(startIndex));
    }
    return Promise.all(laterPages).then(function (pages) {
      const all = items.slice();
      pages.forEach(function (page) {
        all.push.apply(all, (page && page.Items) || []);
      });
      return all;
    });
  });
}

export function getCollections() {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  return cached('collections:' + userId, function () {
    return getAllCollections(userId);
  });
}

export function invalidateNavCaches() {
  const userId = getCurrentUserId();
  if (!userId) return;
  invalidateCache('views:' + userId);
  invalidateCache('collections:' + userId);
}

export function isAnimeCollection(collection) {
  const ids = collection.ProviderIds || {};
  const stremio = ids.Stremio || ids.stremio;
  if (stremio) return String(stremio).split('.')[0].toLowerCase() === 'anime';
  return /anime|anilist|kitsu/i.test(collection.Name || '');
}

function normalizedId(id) {
  return String(id || '').replace(/-/g, '').toLowerCase();
}

export function getAnimeIds() {
  return cached('anime-ids', function () {
    return rowJson('/Jellio/anime/ids', 'collections', { timeout: 20000 }).then(function (result) {
      return new Set(((result && result.Ids) || []).map(normalizedId));
    });
  }).catch(function () {
    return new Set();
  });
}

function isAnimeItem(item, animeIds) {
  if (!item || !animeIds || !animeIds.size) return false;
  return animeIds.has(normalizedId(item.Id)) || (!!item.SeriesId && animeIds.has(normalizedId(item.SeriesId)));
}

export function withoutAnime(items, animeIds) {
  if (!animeIds || !animeIds.size) return items || [];
  return (items || []).filter(function (item) {
    return !isAnimeItem(item, animeIds);
  });
}

export function collectionKind(collection) {
  if (isAnimeCollection(collection)) return 'tvshows';
  const ids = collection.ProviderIds || {};
  const stremio = ids.Stremio || ids.stremio;
  if (stremio) {
    const type = String(stremio).split('.')[0].toLowerCase();
    return type === 'movie' ? 'movies' : 'tvshows';
  }
  return 'movies';
}

export function getCollectionItems(collectionId, kind, limit, startIndex) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const params = new URLSearchParams({
    ParentId: collectionId,
    IncludeItemTypes: itemTypesForKind(kind),
    Limit: String(limit || 24),
    Fields: 'ProductionYear,CommunityRating,Genres',
    SortBy: 'SortName',
  });
  if (startIndex) params.set('StartIndex', String(startIndex));
  const path = '/Users/' + userId + '/Items?' + params.toString();
  return cached(path, function () {
    return rowJson(path, 'rows');
  }).then(function (result) {
    return (result && result.Items) || [];
  });
}

export function updateUserPassword(currentPassword, newPassword) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  return postJson('/Users/' + userId + '/Password', {
    CurrentPw: currentPassword || '',
    NewPw: newPassword,
  });
}

export function getSubtitleStreams(mediaSource) {
  return (mediaSource.MediaStreams || []).filter(function (stream) {
    return stream.Type === 'Subtitle';
  });
}

export function buildSubtitleUrl(itemId, mediaSourceId, stream) {
  const token = getAccessToken();
  return (
    getServerAddress() +
    '/Videos/' + itemId + '/' + mediaSourceId + '/Subtitles/' + stream.Index + '/Stream.vtt' +
    (token ? '?ApiKey=' + encodeURIComponent(token) : '')
  );
}

export function getNowPlayingSessions() {
  return getJson('/Jellio/now-playing');
}

export function getOnlineUserIds() {
  return getJson('/Jellio/online-users');
}

export async function getNextEpisode(item) {
  if (!item || item.Type !== 'Episode' || !item.SeriesId) return null;

  if (item.SeasonId) {
    const episodes = await getEpisodes(item.SeriesId, item.SeasonId);
    const index = episodes.findIndex(function (episode) {
      return episode.Id === item.Id;
    });
    if (index !== -1 && index + 1 < episodes.length) {
      const candidate = episodes[index + 1];
      if (candidate) {
        const verified = await verifyTodayEpisodesHaveStreams([candidate]);
        if (!verified.length) return null;
        return candidate;
      }
    }
  }

  const seasons = await getSeasons(item.SeriesId);
  const seasonIndex = seasons.findIndex(function (season) {
    return season.Id === item.SeasonId;
  });
  const nextSeason = seasonIndex !== -1 ? seasons[seasonIndex + 1] : null;
  if (!nextSeason) return null;

  const nextEpisodes = await getEpisodes(item.SeriesId, nextSeason.Id);
  const candidate = nextEpisodes.length ? nextEpisodes[0] : null;
  if (candidate) {
    const verified = await verifyTodayEpisodesHaveStreams([candidate]);
    if (!verified.length) return null;
    return candidate;
  }
  return null;
}

export function getHeroCandidates(limit, options) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const opts = options || {};
  const itemTypes = opts.itemTypes || 'Movie,Series';
  const key = 'hero:' + userId + ':' + (opts.parentId || '') + ':' + itemTypes + ':' + (limit || 8);
  return cached(key, function () {
    // Asks for extra so there are still enough once anime and incomplete items are left out.
    const params = new URLSearchParams({
      SortBy: 'Random',
      Recursive: 'true',
      IncludeItemTypes: itemTypes,
      ImageTypes: 'Backdrop',
      EnableImageTypes: 'Backdrop,Logo,Primary',
      Limit: String((limit || 8) * 4),
      Fields: 'Overview,Genres,ProductionYear,RunTimeTicks,OfficialRating,ImageTags,BackdropImageTags,ParentBackdropItemId,ParentBackdropImageTags',
    });
    if (opts.parentId) params.set('ParentId', opts.parentId);
    return Promise.all([rowJson('/Users/' + userId + '/Items?' + params.toString(), 'hero'), getAnimeIds()]).then(function (results) {
      const candidates = withoutAnime((results[0] && results[0].Items) || [], results[1]);
      const highQuality = candidates.filter(function (item) {
        const hasBackdrop = Boolean(
          (item.BackdropImageTags && item.BackdropImageTags.length > 0) ||
          (item.ParentBackdropItemId && item.ParentBackdropImageTags && item.ParentBackdropImageTags.length > 0)
        );
        const hasTitle = Boolean(item.Name && item.Name.trim().length > 0);
        const hasOverview = Boolean(item.Overview && item.Overview.trim().length > 0);
        return hasBackdrop && hasTitle && hasOverview;
      });
      if (highQuality.length >= (limit || 8)) {
        return highQuality.slice(0, limit || 8);
      }
      const withBackdrop = candidates.filter(function (item) {
        const hasBackdrop = Boolean(
          (item.BackdropImageTags && item.BackdropImageTags.length > 0) ||
          (item.ParentBackdropItemId && item.ParentBackdropImageTags && item.ParentBackdropImageTags.length > 0)
        );
        const hasTitle = Boolean(item.Name && item.Name.trim().length > 0);
        return hasBackdrop && hasTitle;
      });
      return (withBackdrop.length ? withBackdrop : candidates).slice(0, limit || 8);
    });
  });
}

const COMMON_GENRES = [
  'Action',
  'Adventure',
  'Animation',
  'Comedy',
  'Crime',
  'Documentary',
  'Drama',
  'Family',
  'Fantasy',
  'Horror',
  'Mystery',
  'Romance',
  'Science Fiction',
  'Thriller',
  'War',
  'Western',
];

function scanGenres(parentId, itemType) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const params = new URLSearchParams({
    Recursive: 'true',
    IncludeItemTypes: itemType,
    Limit: '4000',
    Fields: 'Genres',
  });
  if (parentId) params.set('ParentId', parentId);
  const path = '/Users/' + userId + '/Items?' + params.toString();
  return cached(path, function () {
    return rowJson(path, 'genres');
  }).then(function (result) {
    return (result && result.Items) || [];
  });
}

function getGenreCounts(parentId, itemType) {
  const params = new URLSearchParams({ types: itemType });
  if (parentId) params.set('parentId', parentId);
  const path = '/Jellio/genres?' + params.toString();
  return cached(path, function () {
    return rowJson(path, 'genres', { timeout: 30000 });
  }).then(function (result) {
    return (result && result.Genres) || [];
  });
}

function genreCountsOrScan(parentId, itemType) {
  return getGenreCounts(parentId, itemType).catch(function () {
    return scanGenres(parentId, itemType).then(function (items) {
      const counts = {};
      items.forEach(function (item) {
        (item.Genres || []).forEach(function (genre) {
          counts[genre] = (counts[genre] || 0) + 1;
        });
      });
      return Object.keys(counts).map(function (name) {
        return { Name: name, Count: counts[name] };
      });
    });
  });
}

export function getAllGenres(parentId, itemType) {
  return genreCountsOrScan(parentId, itemType).then(function (counts) {
    return counts.map(function (entry) {
      return entry.Name;
    }).sort(function (a, b) {
      return a.localeCompare(b);
    });
  });
}

function discoverGenresByCount(parentId, itemType, limit) {
  return genreCountsOrScan(parentId, itemType)
    .then(function (counts) {
      return counts
        .filter(function (entry) {
          return entry.Count >= 8;
        })
        .sort(function (a, b) {
          return b.Count - a.Count;
        })
        .slice(0, limit || 6)
        .map(function (entry) {
          return entry.Name;
        });
    })
    .catch(function () {
      return [];
    });
}

export function discoverGenres(parentId, itemType, limit) {
  const max = limit || 6;
  return getAllGenres(parentId, itemType)
    .then(function (allGenres) {
      const byLower = {};
      allGenres.forEach(function (genre) {
        byLower[genre.toLowerCase()] = genre;
      });

      const picked = [];
      COMMON_GENRES.forEach(function (name) {
        const real = byLower[name.toLowerCase()];
        if (real && picked.indexOf(real) === -1) picked.push(real);
      });

      if (picked.length >= max) return picked;

      return discoverGenresByCount(parentId, itemType, max + picked.length)
        .then(function (byCount) {
          byCount.forEach(function (genre) {
            if (picked.length < max && picked.indexOf(genre) === -1) picked.push(genre);
          });
          return picked;
        })
        .catch(function () {
          return picked;
        });
    })
    .catch(function () {
      return discoverGenresByCount(parentId, itemType, max);
    });
}

// A genre row, from the server's few-minute cache of the same query
// (Controllers/GenresController.cs), else asked of Jellyfin directly.
export function getGenreItems(parentId, itemType, genre, limit) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const cachedParams = new URLSearchParams({
    genre: genre,
    types: itemType,
    limit: String(limit || 24),
    enableVirtual: 'true',
  });
  if (parentId) cachedParams.set('parentId', parentId);
  const cachedPath = '/Jellio/genres/items?' + cachedParams.toString();
  return cached(cachedPath, function () {
    return rowJson(cachedPath, 'genres');
  })
    .then(function (result) {
      return collapseAudiobookTracks((result && result.Items) || []);
    })
    .catch(function () {
      return getGenreItemsDirect(parentId, itemType, genre, limit);
    });
}

// One page of a genre, for list views that keep loading as they scroll.
export function getGenreItemsPage(parentId, itemType, genre, startIndex, limit) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const cachedParams = new URLSearchParams({
    genre: genre,
    types: itemType || 'Movie,Series',
    startIndex: String(startIndex || 0),
    limit: String(limit || 24),
    enableVirtual: 'true',
  });
  if (parentId) cachedParams.set('parentId', parentId);
  const cachedPath = '/Jellio/genres/items?' + cachedParams.toString();
  return rowJson(cachedPath, 'genres')
    .then(function (result) {
      return collapseAudiobookTracks((result && result.Items) || []);
    })
    .catch(function () {
      const params = new URLSearchParams({
        Recursive: 'true',
        IncludeItemTypes: itemType,
        Genres: genre,
        StartIndex: String(startIndex || 0),
        Limit: String(limit || 60),
        Fields: 'ProductionYear,CommunityRating,PrimaryImageAspectRatio,Genres,Overview,ImageTags,BackdropImageTags',
        SortBy: 'CommunityRating',
        SortOrder: 'Descending',
      });
      if (parentId) params.set('ParentId', parentId);
      return rowJson('/Users/' + userId + '/Items?' + params.toString(), 'genres').then(function (result) {
        return collapseAudiobookTracks((result && result.Items) || []);
      });
    });
}

function getGenreItemsDirect(parentId, itemType, genre, limit) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const params = new URLSearchParams({
    Recursive: 'true',
    IncludeItemTypes: itemType,
    Genres: genre,
    Limit: String(limit || 20),
    Fields: 'ProductionYear,CommunityRating,PrimaryImageAspectRatio,Genres,Overview,ImageTags,BackdropImageTags',
    SortBy: 'CommunityRating',
    SortOrder: 'Descending',
  });
  if (parentId) params.set('ParentId', parentId);
  const path = '/Users/' + userId + '/Items?' + params.toString();
  return cached(path, function () {
    return rowJson(path, 'genres');
  }).then(function (result) {
    return collapseAudiobookTracks((result && result.Items) || []);
  });
}

export function getSeasonalItems(genres, searchTerms, limit) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const jobs = [];

  if (genres && genres.length) {
    const params = new URLSearchParams({
      Recursive: 'true',
      IncludeItemTypes: 'Movie,Series',
      Genres: genres.join('|'),
      Limit: String(limit || 50),
      Fields: 'Genres,ProductionYear,CommunityRating',
      SortBy: 'CommunityRating',
      SortOrder: 'Descending',
    });
    const path = '/Users/' + userId + '/Items?' + params.toString();
    jobs.push(
      cached(path, function () {
        return rowJson(path, 'rows');
      }).then(function (result) {
        return (result && result.Items) || [];
      }).catch(function () {
        return [];
      }),
    );
  }

  if (searchTerms && searchTerms.length) {
    searchTerms.slice(0, 2).forEach(function (term) {
      const params = new URLSearchParams({
        Recursive: 'true',
        IncludeItemTypes: 'Movie,Series',
        searchTerm: term,
        Limit: '25',
        Fields: 'Genres,ProductionYear,CommunityRating',
      });
      const path = '/Users/' + userId + '/Items?' + params.toString();
      jobs.push(
        cached(path, function () {
          return rowJson(path, 'rows');
        }).then(function (result) {
          return (result && result.Items) || [];
        }).catch(function () {
          return [];
        }),
      );
    });
  }

  return Promise.all(jobs).then(function (results) {
    const combined = [];
    const seen = new Set();
    results.forEach(function (list) {
      list.forEach(function (item) {
        if (!seen.has(item.Id)) {
          seen.add(item.Id);
          combined.push(item);
        }
      });
    });
    return collapseAudiobookTracks(combined);
  });
}

async function getNativeMediaSegments(itemId) {
  const result = await getJson('/MediaSegments/' + itemId);
  const items = Array.isArray(result) ? result : (result && result.Items) || [];
  if (!items.length) {
    console.warn('Jellio: native Media Segments came back with nothing for', itemId, result);
  }
  function bySeconds(type) {
    const segment = items.find(function (s) {
      return s.Type === type;
    });
    return segment
      ? { Start: segment.StartTicks / TICKS_PER_SECOND, End: segment.EndTicks / TICKS_PER_SECOND }
      : null;
  }
  const introduction = bySeconds('Intro');
  const credits = bySeconds('Outro');
  if (!introduction && !credits) return null;
  return {
    Introduction: introduction || { Start: 0, End: 0 },
    Credits: credits || { Start: 0, End: 0 },
  };
}

export async function getCommunitySkipSegments(itemId) {
  try {
    const result = await getJson('/Jellio/introcredits/community/' + itemId);
    if (!result) return null;
    const introduction = result.Introduction ? { Start: result.Introduction.Start, End: result.Introduction.End } : null;
    const credits = result.Credits ? { Start: result.Credits.Start, End: result.Credits.End } : null;
    if (!introduction && !credits) return null;
    return {
      Introduction: introduction || { Start: 0, End: 0 },
      Credits: credits || { Start: 0, End: 0 },
    };
  } catch (err) {
    console.warn('Jellio: community skip data lookup failed for', itemId, err);
    return null;
  }
}

export async function getIntroSkipperSegments(itemId) {
  try {
    const native = await getNativeMediaSegments(itemId);
    if (native) return native;
  } catch (err) {
    console.warn('Jellio: native Media Segments lookup failed for', itemId, err && err.status, err);
  }

  try {
    const result = await getJson('/Episode/' + itemId + '/Timestamps');
    return result || {};
  } catch (err) {
    console.warn('Jellio: Intro Skipper segment lookup failed for', itemId, err && err.status, err);
    return {};
  }
}

export async function getJellioIntroCredits(itemId) {
  try {
    const result = await getJson('/Jellio/introcredits/' + itemId);
    if (!result) return null;
    const introduction = result.Introduction ? { Start: result.Introduction.Start, End: result.Introduction.End } : null;
    const credits = result.Credits ? { Start: result.Credits.Start, End: result.Credits.End } : null;
    if (!introduction && !credits) return null;
    return {
      Introduction: introduction || { Start: 0, End: 0 },
      Credits: credits || { Start: 0, End: 0 },
    };
  } catch (err) {
    console.warn('Jellio: could not load Jellio-analyzed intro/credits for', itemId, err);
    return null;
  }
}

export function scanIntroCreditsForItem(itemId, useAnalyzerFallback) {
  if (!itemId) return Promise.reject(new Error('Missing item id'));
  const query = '?useAnalyzerFallback=' + (useAnalyzerFallback ? 'true' : 'false');
  return postJson('/Jellio/introcredits/scan/' + itemId + query, {}, 600000);
}

export function getPerson(personId) {
  return getItem(personId);
}

export function creditRealWatch(itemId) {
  return postJson('/Jellio/achievements/real-watch', { ItemId: itemId }).then(function (result) {
    invalidateUserDataRows();
    return result;
  });
}

export function probeRealDuration(itemId) {
  return postJson('/Jellio/real-duration/probe', { ItemId: itemId }, 40000).then(function (answer) {
    return (answer && answer.DurationTicks) || null;
  });
}

// exact: the length itself; otherwise only a lower bound on it.
export function reportRealDuration(itemId, durationTicks, exact) {
  return postJson('/Jellio/real-duration', { ItemId: itemId, DurationTicks: Math.round(durationTicks), Exact: !!exact }).then(function (result) {
    invalidateUserDataRows();
    return result;
  });
}

function getRealDurationOverrides(itemIds) {
  if (!itemIds.length) return Promise.resolve({});
  return rowJson('/Jellio/real-duration?ids=' + itemIds.join(','), 'personal', { priority: true, rank: 0 }).catch(function () {
    return {};
  });
}

function applyRealDurationOverrides(items) {
  const withIds = items.filter(function (item) {
    return item && item.Id;
  });
  if (!withIds.length) return Promise.resolve(items);
  return getRealDurationOverrides(
    withIds.map(function (item) {
      return item.Id;
    }),
  ).then(function (overrides) {
    withIds.forEach(function (item) {
      const key = item.Id.replace(/-/g, '');
      const realTicks = overrides[key];
      if (!realTicks) return;
      item.RunTimeTicks = realTicks;
      const posTicks = item.UserData && item.UserData.PlaybackPositionTicks;
      if (item.UserData && posTicks) {
        item.UserData.PlayedPercentage = Math.min(100, (posTicks / realTicks) * 100);
      }
    });
    return items;
  });
}

export function getUserById(userId) {
  return getJson('/Users/' + userId);
}

export function getPersonFilmography(personId, limit) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const params = new URLSearchParams({
    personIds: personId,
    Recursive: 'true',
    IncludeItemTypes: 'Movie,Series,Book,AudioBook',
    SortBy: 'PremiereDate,SortName',
    SortOrder: 'Descending',
    Fields: 'PrimaryImageAspectRatio,ProductionYear,Album,Artists,SeriesName',
    Limit: String(limit || 100),
  });
  const path = '/Users/' + userId + '/Items?' + params.toString();
  return cached(path, function () {
    return getJson(path);
  }).then(function (result) {
    return (result && result.Items) || [];
  });
}

// === Remote Playback & Smart TV Sessions API ===
// Discovers all active Jellyfin client sessions (Smart TVs, mobile apps, desktop players).
export async function getRemoteSessions(controllableOnly) {
  const userId = getCurrentUserId();
  const results = [];
  const seenIds = new Set();

  function addSessions(sessions) {
    if (Array.isArray(sessions)) {
      sessions.forEach(function (s) {
        if (s && s.Id && !seenIds.has(s.Id)) {
          seenIds.add(s.Id);
          results.push(s);
        }
      });
    }
  }

  if (userId) {
    try {
      const userSessions = await getJson('/Sessions?ControllableByUserId=' + encodeURIComponent(userId));
      addSessions(userSessions);
    } catch (_) {}
  }

  try {
    const allSessions = await getJson('/Sessions');
    addSessions(allSessions);
  } catch (_) {}

  return results;
}

// Instructs a remote Jellyfin session (e.g. Smart TV app) to play an item.
export function sendPlayCommand(sessionId, itemId, options) {
  const opts = options || {};
  const params = new URLSearchParams({
    playCommand: opts.playCommand || 'PlayNow',
    itemIds: String(itemId),
  });
  if (opts.startPositionTicks != null) params.set('startPositionTicks', String(opts.startPositionTicks));
  if (opts.mediaSourceId) params.set('mediaSourceId', String(opts.mediaSourceId));
  if (opts.audioStreamIndex != null) params.set('audioStreamIndex', String(opts.audioStreamIndex));
  if (opts.subtitleStreamIndex != null) params.set('subtitleStreamIndex', String(opts.subtitleStreamIndex));
  if (opts.startIndex != null) params.set('startIndex', String(opts.startIndex));

  const body = {
    PlayCommand: opts.playCommand || 'PlayNow',
    ItemIds: Array.isArray(itemId) ? itemId : [itemId],
    StartPositionTicks: opts.startPositionTicks != null ? opts.startPositionTicks : 0,
    MediaSourceId: opts.mediaSourceId || null,
    AudioStreamIndex: opts.audioStreamIndex != null ? opts.audioStreamIndex : null,
    SubtitleStreamIndex: opts.subtitleStreamIndex != null ? opts.subtitleStreamIndex : null,
    StartIndex: opts.startIndex != null ? opts.startIndex : 0,
  };

  return postJson('/Sessions/' + encodeURIComponent(sessionId) + '/Playing?' + params.toString(), body);
}

// Sends playstate commands to an active remote session (PlayPause, Pause, Unpause, Stop, Seek).
export function sendPlaystateCommand(sessionId, command, seekPositionTicks) {
  let path = '/Sessions/' + encodeURIComponent(sessionId) + '/Playing/' + encodeURIComponent(command);
  if (seekPositionTicks != null) {
    path += '?seekPositionTicks=' + encodeURIComponent(String(seekPositionTicks));
  }
  return postJson(path, {});
}

// Sends general commands (e.g. SetVolume, Mute) to an active remote session.
export function sendSessionGeneralCommand(sessionId, name, args) {
  const body = {
    Name: name,
    Arguments: args || {},
  };
  return postJson('/Sessions/' + encodeURIComponent(sessionId) + '/Command/' + encodeURIComponent(name), body).catch(function () {
    return postJson('/Sessions/' + encodeURIComponent(sessionId) + '/Command', body);
  });
}

let cachedDisplayPreferences = null;

export function getCachedServerDisplayPreferences() {
  return cachedDisplayPreferences;
}

export async function getServerDisplayPreferences() {
  const userId = getCurrentUserId();
  if (!userId) return null;
  if (cachedDisplayPreferences && cachedDisplayPreferences.UserId === userId) {
    return cachedDisplayPreferences;
  }
  try {
    const res = await fetch(getServerAddress() + '/DisplayPreferences/usersettings?userId=' + encodeURIComponent(userId) + '&client=Jellio', {
      headers: Object.assign({ Accept: 'application/json' }, getAuthHeaders()),
    });
    if (res.ok) {
      cachedDisplayPreferences = await res.json();
      if (cachedDisplayPreferences) cachedDisplayPreferences.UserId = userId;
      return cachedDisplayPreferences;
    }
  } catch (err) {
    // Network or server error
  }
  return null;
}

export async function saveServerDisplayPreferences(customPrefs) {
  const userId = getCurrentUserId();
  if (!userId || !customPrefs) return;
  try {
    const existing = await getServerDisplayPreferences();
    const existingCustom = (existing && existing.CustomPrefs) || {};
    const merged = Object.assign({}, existingCustom, customPrefs);
    const body = {
      Id: 'usersettings',
      Client: 'Jellio',
      CustomPrefs: merged,
    };
    cachedDisplayPreferences = Object.assign({}, existing, body, { UserId: userId });
    await fetch(getServerAddress() + '/DisplayPreferences/usersettings?userId=' + encodeURIComponent(userId) + '&client=Jellio', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json' }, getAuthHeaders()),
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Best effort only
  }
}

// Sync display language preference to Jellyfin server DisplayPreferences
export async function saveServerDisplayLanguage(lang) {
  return saveServerDisplayPreferences({ language: lang || 'en' });
}

export async function loadServerPreferences() {
  const userId = getCurrentUserId();
  if (!userId) return null;
  const prefs = await getServerDisplayPreferences();
  if (prefs && prefs.CustomPrefs) {
    if (prefs.CustomPrefs.onboarding_done === 'true') {
      try {
        window.localStorage.setItem('jellio_onboarding_done_' + userId, 'true');
      } catch (_) {}
    }
    if (prefs.CustomPrefs.language) {
      try {
        const localLang = window.localStorage.getItem('jellio_display_language');
        if (!localLang && prefs.CustomPrefs.language) {
          setDisplayLanguage(prefs.CustomPrefs.language);
        }
      } catch (_) {}
    }
  }
  return prefs;
}

export function getSearchSuggestions(query) {
  return getJson('/Jellio/search/suggestions?query=' + encodeURIComponent(query)).then(function (result) {
    return result || { MatchedTitle: null, Rows: [] };
  });
}
