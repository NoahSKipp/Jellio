import { getAccessToken, getAuthHeaders, getCurrentUserId, getDeviceId, getServerAddress } from './auth.js';
import { getDisplayCulture } from './i18n.js';
import { findDownload, getDownload, getLocalProgress, getOfflineBlob, isOffline, queueSync, setLocalProgress, updateDownload } from './offline.js';
import { DEFAULT_TIMEOUT_MS, SHORT_CACHE_TTL_MS, audiobookGroupKey, cache, cached, collapseAudiobookTracks, deleteJson, getJson, invalidateCache, invalidateUserDataRows, invalidateUserDataRowsThrottled, isUnreachable, postJson, requestJson, rowJson } from './api.js';

// The home screen's personal rows: small, fast, and what a reader is
// waiting for, so they skip ahead of background lookups.
function getPriorityJson(path, timeoutMs) {
  return getJson(path, timeoutMs, undefined, true);
}

// Jellyfin tracks audiobook resume natively, same Resume endpoint video
// uses. One entry per book, not per half-played track file.
export function getContinueListening(limit) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const params = new URLSearchParams({
    Limit: String(limit || 20),
    MediaTypes: 'Audio',
    IncludeItemTypes: 'AudioBook',
    Fields: 'PrimaryImageAspectRatio,RunTimeTicks',
  });
  return rowJson('/Users/' + userId + '/Items/Resume?' + params.toString(), 'personal', { priority: true, rank: 2 }).then(function (result) {
    return collapseAudiobookTracks((result && result.Items) || []);
  });
}

function getItemsByIds(ids, rowClass) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  if (!ids || !ids.length) return Promise.resolve([]);
  const culture = getDisplayCulture();
  const params = new URLSearchParams({ Ids: ids.join(','), Fields: 'PrimaryImageAspectRatio' });
  if (culture) params.set('Culture', culture);
  const path = '/Users/' + userId + '/Items?' + params.toString();
  return (rowClass ? rowJson(path, rowClass, { priority: true, rank: 2 }) : getPriorityJson(path)).then(function (result) {
    const byId = new Map();
    ((result && result.Items) || []).forEach(function (item) {
      byId.set(String(item.Id).replace(/-/g, ''), item);
    });
    return ids
      .map(function (id) {
        return byId.get(String(id).replace(/-/g, ''));
      })
      .filter(Boolean);
  });
}

export async function getReadingProgress(itemId) {
  const local = await getLocalProgress(itemId);
  try {
    const remote = await getJson('/Jellio/reading/progress/' + itemId);
    if (local && local.Locator && (!remote || !remote.Locator || Date.parse(local.UpdatedAt) > Date.parse(remote.UpdatedAt || 0))) {
      return local;
    }
    return remote;
  } catch (err) {
    if (!isUnreachable(err)) throw err;
    return local || {};
  }
}

// Every item this reader has progress on: { itemId (no dashes):
// { Locator, Progress, TotalPages, UpdatedAt } }.
export function getAllReadingProgress() {
  return getJson('/Jellio/reading/progress', 20000).then(function (all) {
    return all || {};
  });
}

// A downloaded video's position (and whether it's been watched), as the
// item's user data: sent now, or once the server is back.
export function saveUserItemPosition(itemId, positionTicks, played) {
  const body = { PlaybackPositionTicks: Math.max(0, Math.round(positionTicks || 0)) };
  if (played) {
    body.Played = true;
    body.PlaybackPositionTicks = 0;
  }
  return sendOrQueue('POST', '/UserItems/' + itemId + '/UserData', body).catch(function (err) {
    console.warn('Jellio: could not save the position', err);
  });
}

// Kept on this device too; when the server can't be reached, sent once
// it can.
export function saveReadingProgress(itemId, locator, progress, totalPages) {
  const body = {
    Locator: locator,
    Progress: progress,
    TotalPages: totalPages || null,
  };
  setLocalProgress(itemId, body);
  return sendOrQueue('POST', '/Jellio/reading/progress/' + itemId, body).then(function (result) {
    if (progress >= 0.98) invalidateUserDataRows();
    else invalidateUserDataRowsThrottled(2 * 60000);
    return result;
  });
}

// Marks books or chapters (saved or streamed ids) read or unread.
export function markReadingItems(itemIds, read) {
  invalidateStreamLibrary();
  return postJson('/Jellio/reading/progress/mark', { ItemIds: itemIds, Read: !!read }).then(function (result) {
    invalidateUserDataRows();
    return result;
  });
}

// Sends now, or queues the request for when the server is back (the
// queued case resolves to null).
function sendOrQueue(method, path, body) {
  if (isOffline()) return queueSync(method, path, body).then(() => null);
  const request = method === 'PUT' ? putJson(path, body) : method === 'DELETE' ? deleteJson(path) : postJson(path, body);
  return request.catch(function (err) {
    if (isUnreachable(err)) return queueSync(method, path, body).then(() => null);
    throw err;
  });
}

// Books started but not finished, most recently read first, with their
// reading progress folded into UserData so cards paint a progress bar.
export function getContinueReading(limit) {
  return rowJson('/Jellio/reading/in-progress?limit=' + (limit || 20), 'personal', { priority: true, rank: 2 }).then(function (entries) {
    const list = entries || [];
    const progressById = new Map();
    const pagesById = new Map();
    list.forEach(function (entry) {
      progressById.set(entry.ItemId, entry.Progress);
      if (entry.TotalPages) pagesById.set(entry.ItemId, entry.TotalPages);
    });
    return getItemsByIds(
      list.map(function (entry) {
        return entry.ItemId;
      }),
      'personal',
    ).then(function (items) {
      return items.map(function (item) {
        const key = String(item.Id).replace(/-/g, '');
        const progress = progressById.get(key) || 0;
        const pages = pagesById.get(key);
        return Object.assign({}, item, {
          UserData: Object.assign({}, item.UserData, { PlayedPercentage: progress * 100 }),
          // Pages still to read, for the card's "Xp left" badge.
          JellioPagesLeft: pages ? Math.max(1, Math.round(pages * (1 - progress))) : null,
        });
      });
    });
  });
}

export function getAudiobookTracks(item) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  if (!item.ParentId) return Promise.resolve([item]);
  const params = new URLSearchParams({
    ParentId: item.ParentId,
    IncludeItemTypes: 'AudioBook',
    SortBy: 'ParentIndexNumber,IndexNumber,SortName',
    SortOrder: 'Ascending',
    Fields: 'RunTimeTicks,Chapters,Path',
  });
  return getJson('/Users/' + userId + '/Items?' + params.toString()).catch(async function (err) {
    if (!isUnreachable(err)) throw err;
    const record = await findDownload(item.Id);
    if (!record || !record.Tracks) throw err;
    return { Items: record.Tracks };
  }).then(function (result) {
    const key = audiobookGroupKey(item);
    const tracks = ((result && result.Items) || []).filter(function (track) {
      return audiobookGroupKey(track) === key;
    });
    return tracks.length ? tracks : [item];
  });
}

// The audiobook file itself, served as is. transcode asks Jellyfin for
// MP3 instead, the fallback when a browser cannot decode the original.
export function buildAudioStreamUrl(itemId, transcode) {
  const params = new URLSearchParams({ ApiKey: getAccessToken() || '', DeviceId: getDeviceId() });
  if (transcode) {
    params.set('AudioCodec', 'mp3');
    params.set('AudioBitRate', '128000');
    return getServerAddress() + '/Audio/' + itemId + '/stream.mp3?' + params.toString();
  }
  params.set('static', 'true');
  return getServerAddress() + '/Audio/' + itemId + '/stream?' + params.toString();
}

const COMIC_FILE = /\.(cbz|cbr|cb7|cbt)$/i;

function isComicItem(item) {
  return !!(item && item.Path && COMIC_FILE.test(item.Path));
}

export function getBookshelfItems(parentId, kind, mangaLibrary) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const params = new URLSearchParams({
    ParentId: parentId,
    Recursive: 'true',
    // Manga volumes are Book items too, in their own library.
    IncludeItemTypes: kind === 'audiobook' ? 'AudioBook' : 'Book',
    SortBy: 'SortName',
    SortOrder: 'Ascending',
    Fields: 'PrimaryImageAspectRatio,ProductionYear,DateCreated,Genres,RunTimeTicks,Path',
    Limit: '2000',
  });
  const path = '/Users/' + userId + '/Items?' + params.toString();
  return cached(
    path,
    function () {
      return getJson(path, 30000);
    },
    SHORT_CACHE_TTL_MS,
  ).then(function (result) {
    let items = (result && result.Items) || [];
    if (kind === 'manga' && !mangaLibrary) items = items.filter(isComicItem);
    else if (kind === 'ebook') items = items.filter((item) => !isComicItem(item));
    return collapseAudiobookTracks(items);
  });
}

export function getBookShelfInfo(parentId) {
  const path = '/Jellio/books/shelf-info?parentId=' + encodeURIComponent(parentId);
  return cached(
    path,
    function () {
      return getJson(path, 30000);
    },
    SHORT_CACHE_TTL_MS,
  ).catch(function (err) {
    console.warn('Jellio: book shelf info failed', err);
    return {};
  });
}

export function getMangaCoverUrl(url) {
  return (
    getServerAddress() +
    '/Jellio/books/manga-cover?url=' +
    encodeURIComponent(url) +
    '&ApiKey=' +
    encodeURIComponent(getAccessToken() || '')
  );
}

export function getMangaSeriesCoverUrl(itemId, seriesTitle) {
  return (
    getServerAddress() +
    '/Jellio/manga/series-cover/' +
    encodeURIComponent(itemId) +
    '?ApiKey=' +
    encodeURIComponent(getAccessToken() || '') +
    (seriesTitle ? '&title=' + encodeURIComponent(seriesTitle) : '')
  );
}

export function getStreamLibrary() {
  return cached('manga-stream-library', function () {
    return getJson('/Jellio/manga/stream/library', 60000);
  }, SHORT_CACHE_TTL_MS).catch(function (err) {
    console.warn('Jellio: could not load streamed manga', err);
    const none = [];
    none.failed = true;
    return none;
  });
}

// AniList tracking (Controllers/TrackerController.cs). The reader's token
// lives on the server; these only ever see the account name and entry.
export function getTrackerStatus() {
  return getJson('/Jellio/tracker/anilist', 15000);
}

export function connectTracker(token) {
  return postJson('/Jellio/tracker/anilist/connect', { Token: token });
}

export function disconnectTracker() {
  return deleteJson('/Jellio/tracker/anilist');
}

export function searchTracker(query, type) {
  const t = type ? '&type=' + encodeURIComponent(type) : '';
  return getJson('/Jellio/tracker/anilist/search?q=' + encodeURIComponent(query) + t, 20000);
}

export function getTrackerLink(key) {
  return getJson('/Jellio/tracker/anilist/link?key=' + encodeURIComponent(key), 20000);
}

export function setTrackerLink(key, media) {
  return putJson('/Jellio/tracker/anilist/link', { Key: key, MediaId: media.Id, Title: media.Title, CoverUrl: media.CoverUrl || null });
}

export function removeTrackerLink(key) {
  return deleteJson('/Jellio/tracker/anilist/link?key=' + encodeURIComponent(key));
}

export function setTrackerEntry(key, patch) {
  return putJson('/Jellio/tracker/anilist/entry', Object.assign({ Key: key }, patch));
}

export function syncTracker(key, mangaId, episode) {
  return postJson('/Jellio/tracker/anilist/sync', { Key: key, MangaId: mangaId, Episode: episode }).catch(function () {
    return null;
  });
}

// New chapters from the latest library refreshes (MangaStreamController
// updates); refresh asks the sources now.
export function getMangaUpdates() {
  return getJson('/Jellio/manga/stream/updates', 60000);
}

export function refreshMangaUpdates() {
  invalidateStreamLibrary();
  return postJson('/Jellio/manga/stream/updates/refresh', {}, 300000);
}

export function invalidateStreamLibrary() {
  invalidateCache('manga-stream-library');
}

export function findStreamSeries(key) {
  return getJson('/Jellio/manga/stream/by-key?key=' + encodeURIComponent(key), 30000);
}

export function getStreamSeries(mangaId) {
  return getJson('/Jellio/manga/stream/series/' + mangaId, 60000);
}

export function getStreamChapter(id, mangaId) {
  return getJson('/Jellio/manga/stream/chapter/' + encodeURIComponent(id) + (mangaId ? '?manga=' + mangaId : ''), 30000);
}

export function getStreamPageCount(chapterId) {
  return getJson('/Jellio/manga/stream/chapter/' + chapterId + '/pages', 60000).then((answer) => (answer && answer.Count) || 0);
}

export function getStreamPageUrl(chapterId, index) {
  return (
    getServerAddress() +
    '/Jellio/manga/stream/chapter/' +
    chapterId +
    '/page/' +
    index +
    '?ApiKey=' +
    encodeURIComponent(getAccessToken() || '')
  );
}

// title: the series' name, so the server can use AniList's cover when the
// source's own thumbnail can't be fetched.
export function getStreamCoverUrl(mangaId, title) {
  return (
    getServerAddress() +
    '/Jellio/manga/thumbnail/' +
    mangaId +
    '?ApiKey=' +
    encodeURIComponent(getAccessToken() || '') +
    (title ? '&title=' + encodeURIComponent(title) : '')
  );
}

export function getBookCoverUrl(itemId) {
  return (
    getServerAddress() +
    '/Jellio/books/item/' +
    encodeURIComponent(itemId) +
    '/cover?ApiKey=' +
    encodeURIComponent(getAccessToken() || '')
  );
}

// Resolves to null (204) when Chaptarr has nothing for this book.
export function getBookMetadata(itemId) {
  const path = '/Jellio/books/item/' + encodeURIComponent(itemId) + '/metadata';
  return cached('book-metadata:' + itemId, function () {
    return requestJson(
      getServerAddress() + path,
      { headers: Object.assign({ Accept: 'application/json' }, getAuthHeaders()), cache: 'no-store' },
      path,
      30000,
    ).then(function (response) {
      return response.status === 204 ? null : response.json();
    });
  }).catch(function (err) {
    console.warn('Jellio: book metadata lookup failed', err);
    return null;
  });
}

export function searchBooksToRequest(query, mediaType) {
  const scope = mediaType ? '&mediaType=' + encodeURIComponent(mediaType) : '';
  return getJson('/Jellio/books/search?q=' + encodeURIComponent(query) + scope, 30000).then(function (results) {
    return results || [];
  });
}

// bookType is "ebook" or "audiobook". Resolves to { Status, Message } with
// Status one of added, pending, exists or error.
export function requestBook(result, bookType) {
  return postJson(
    '/Jellio/books/request',
    { WorkId: result.WorkId, BookType: bookType, Title: result.Title || null, Author: result.Author || null },
    30000,
  );
}

export function getBookRequests(mediaType) {
  return getJson('/Jellio/books/requests?mediaType=' + encodeURIComponent(mediaType), 30000);
}

export function searchBookAgain(chaptarrBookId) {
  return postJson('/Jellio/books/requests/' + encodeURIComponent(chaptarrBookId) + '/search', {}, 30000);
}

export function removeBookFromLibrary(mediaType, target) {
  return postJson(
    '/Jellio/books/library/remove',
    {
      MediaType: mediaType,
      ItemId: target.ItemId || null,
      ChaptarrBookId: target.ChaptarrBookId || 0,
      Title: target.Title || null,
    },
    60000,
  ).then(function (result) {
    Array.from(cache.keys()).forEach(function (key) {
      if (key.indexOf('IncludeItemTypes=') !== -1 || key.indexOf('shelf-info') !== -1) invalidateCache(key);
    });
    return result;
  });
}

export function getMangaRequestStatus() {
  return cached('manga-request-status', function () {
    return getJson('/Jellio/manga/status', 20000);
  }, SHORT_CACHE_TTL_MS);
}

// Resolves to { Searched, Failed, Languages, InstalledLanguages,
// TotalSources, NsfwSources, Sources }.
function searchMangaSources(query) {
  return getJson('/Jellio/manga/search?q=' + encodeURIComponent(query), 45000).then(function (response) {
    const result = response || {};
    return {
      Searched: result.Searched || 0,
      Failed: result.Failed || 0,
      Languages: result.Languages || [],
      InstalledLanguages: result.InstalledLanguages || [],
      TotalSources: result.TotalSources || 0,
      NsfwSources: result.NsfwSources || 0,
      Sources: result.Sources || [],
    };
  });
}

export async function streamMangaSources(query, onProgress, signal) {
  const summary = {
    Searched: 0,
    Failed: 0,
    Languages: [],
    InstalledLanguages: [],
    TotalSources: 0,
    NsfwSources: 0,
    Sources: [],
    Unavailable: [],
    Pending: 0,
  };
  const notify = function (type, source) {
    if (onProgress) onProgress({ type: type, source: source || null, summary: summary });
  };
  let response;
  try {
    response = await fetch(getServerAddress() + '/Jellio/manga/search/stream?q=' + encodeURIComponent(query), {
      headers: Object.assign({ Accept: 'application/x-ndjson' }, getAuthHeaders()),
      cache: 'no-store',
      signal: signal,
    });
  } catch (err) {
    if (err && err.name !== 'AbortError') err.isNetworkError = true;
    throw err;
  }
  if (response.status === 404 || !response.body) {
    const whole = await searchMangaSources(query);
    Object.assign(summary, whole, { Unavailable: [], Pending: 0 });
    notify('done');
    return summary;
  }
  if (!response.ok) {
    const err = new Error('Request failed: manga search');
    err.status = response.status;
    throw err;
  }

  function handle(line) {
    if (line.Type === 'start') {
      summary.Searched = line.Searched || 0;
      summary.Languages = line.Languages || [];
      summary.InstalledLanguages = line.InstalledLanguages || [];
      summary.TotalSources = line.TotalSources || 0;
      summary.NsfwSources = line.NsfwSources || 0;
      summary.Pending = summary.Searched;
      notify('start');
    } else if (line.Type === 'source') {
      summary.Pending = Math.max(0, summary.Pending - 1);
      const source = { SourceId: line.SourceId, SourceName: line.SourceName, Lang: line.Lang, Status: line.Status, Results: line.Results || [] };
      if (line.Status === 'Unavailable') {
        summary.Unavailable.push(line.SourceName);
        summary.Failed++;
      } else if (line.Status === 'Failed' || line.Status === 'Timeout') {
        summary.Failed++;
      } else if (source.Results.length) {
        summary.Sources.push(source);
      }
      notify('source', source);
    } else if (line.Type === 'done') {
      summary.Pending = 0;
    }
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const text = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (text) handle(JSON.parse(text));
    }
  }
  if (buffer.trim()) handle(JSON.parse(buffer));
  summary.Pending = 0;
  summary.Sources.sort(function (a, b) {
    return (b.Results[0] ? b.Results[0].Match : 0) - (a.Results[0] ? a.Results[0].Match : 0) || String(a.SourceName).localeCompare(String(b.SourceName));
  });
  notify('done');
  return summary;
}

// Where a source's group goes among those already shown: best match first.
export function bestMangaMatch(source) {
  return source && source.Results && source.Results[0] ? source.Results[0].Match || 0 : 0;
}

export async function startMangaImport(file) {
  const response = await fetch(getServerAddress() + '/Jellio/manga/import', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/octet-stream', Accept: 'application/json' }, getAuthHeaders()),
    body: file,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text && text.length < 300 ? text.replace(/^"|"$/g, '') : 'Import failed');
  return text ? JSON.parse(text) : null;
}

export function getMangaImportStatus() {
  return getJson('/Jellio/manga/import', 15000);
}

// Adds a series to Suwayomi so it can be read (streamed from its source).
// addToLibrary false leaves the reader's shelf alone until they read it.
export function requestMangaSeries(mangaId, title, addToLibrary, force) {
  return postJson(
    '/Jellio/manga/request',
    { MangaId: mangaId, Title: title || null, AddToLibrary: addToLibrary !== false, Force: !!force },
    60000,
  );
}

// Moves the reader's copy of a series to another source, keeping their
// progress (Mihon's migrate).
export function migrateMangaSeries(fromMangaId, toMangaId) {
  invalidateStreamLibrary();
  return postJson('/Jellio/manga/migrate', { FromMangaId: fromMangaId, ToMangaId: toMangaId }, 120000);
}

export function discoverManga(options) {
  const opts = options || {};
  const params = new URLSearchParams({ sort: opts.sort || 'trending', page: String(opts.page || 0) });
  if (opts.genre) params.set('genre', opts.genre);
  if (opts.country) params.set('country', opts.country);
  if (opts.q) params.set('q', opts.q);
  const path = '/Jellio/books/discover-manga?' + params.toString();
  return cached(path, function () {
    return getJson(path, 30000);
  }).then(function (results) {
    return results || [];
  });
}

export function discoverBooks(source, value, page) {
  const params = new URLSearchParams({ source: source, page: String(page || 0) });
  if (value) params.set('value', value);
  const path = '/Jellio/books/discover?' + params.toString();
  return cached(path, function () {
    return getJson(path, 30000);
  }).then(function (results) {
    return results || [];
  });
}

export async function fetchBookFile(itemId) {
  // A downloaded copy opens from this device, online or not.
  const local = await getOfflineBlob(itemId, 'file');
  if (local) return { contentType: local.type || '', buffer: await local.arrayBuffer() };
  if (isOffline()) {
    const offlineErr = new TypeError('Not downloaded');
    offlineErr.isNetworkError = true;
    throw offlineErr;
  }
  const response = await fetch(getServerAddress() + '/Jellio/reading/file/' + itemId, {
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    const err = new Error('Could not load book file');
    err.status = response.status;
    throw err;
  }
  return {
    contentType: response.headers.get('Content-Type') || '',
    buffer: await response.arrayBuffer(),
  };
}

async function putJson(path, body, timeoutMs) {
  const response = await requestJson(
    getServerAddress() + path,
    {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json' }, getAuthHeaders()),
      body: JSON.stringify(body || {}),
    },
    path,
    timeoutMs || DEFAULT_TIMEOUT_MS,
  );
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

// Controllers/ReadingActivityController.cs: one reading or listening
// session, for the Feed and reading achievements. Fire and forget.
export function reportReadingSession(session) {
  return sendOrQueue('POST', '/Jellio/reading/session', session).catch(function (err) {
    console.warn('Jellio: could not report reading session', err);
  });
}

export function getAnnotations(itemId) {
  return getJson('/Jellio/reading/annotations/' + itemId)
    .then(function (list) {
      updateDownload(itemId, { Annotations: list || [] }).catch(() => {});
      return list || [];
    })
    .catch(async function (err) {
      if (!isUnreachable(err)) throw err;
      const record = await getDownload(itemId);
      return (record && record.Annotations) || [];
    });
}

async function changeOfflineAnnotations(itemId, change) {
  const record = await getDownload(itemId);
  if (record) await updateDownload(itemId, { Annotations: change(record.Annotations || []) });
}

export function addAnnotation(itemId, annotation) {
  return sendOrQueue('POST', '/Jellio/reading/annotations/' + itemId, annotation).then(function (created) {
    if (created) return created;
    const local = Object.assign({ Id: 'offline-' + Date.now(), CreatedAt: new Date().toISOString() }, annotation);
    return changeOfflineAnnotations(itemId, (list) => list.concat([local])).then(() => local);
  });
}

export function updateAnnotation(itemId, id, changes) {
  return sendOrQueue('PUT', '/Jellio/reading/annotations/' + itemId + '/' + encodeURIComponent(id), changes).then(function (updated) {
    if (updated) return updated;
    return changeOfflineAnnotations(itemId, (list) => list.map((entry) => (entry.Id === id ? Object.assign({}, entry, changes) : entry))).then(
      () => Object.assign({ Id: id }, changes),
    );
  });
}

export function deleteAnnotation(itemId, id) {
  return sendOrQueue('DELETE', '/Jellio/reading/annotations/' + itemId + '/' + encodeURIComponent(id)).then(function (result) {
    return changeOfflineAnnotations(itemId, (list) => list.filter((entry) => entry.Id !== id)).then(() => result);
  });
}

// Controllers/LanguageController.cs. Both resolve rather than reject on
// a lookup that found nothing, so the popup can say so in place.
export function translateText(text, targetLang, sourceLang, context) {
  return postJson(
    '/Jellio/language/translate',
    { Text: text, TargetLang: targetLang, SourceLang: sourceLang || null, Context: context || null },
    20000,
  );
}

export function defineWord(word, lang) {
  const query = '?word=' + encodeURIComponent(word) + (lang && lang !== 'auto' ? '&lang=' + encodeURIComponent(lang) : '');
  return cached('define:' + word + ':' + (lang || ''), function () {
    return getJson('/Jellio/language/define' + query, 20000);
  });
}

// Controllers/VocabularyController.cs: the reader's vocabulary deck.
export function getVocabulary() {
  return getJson('/Jellio/vocab').then(function (list) {
    return list || [];
  });
}

export function addVocabulary(entry) {
  return sendOrQueue('POST', '/Jellio/vocab', entry).then(function (created) {
    return created || Object.assign({ Id: 'offline-' + Date.now() }, entry);
  });
}

export function updateVocabulary(id, changes) {
  return putJson('/Jellio/vocab/' + encodeURIComponent(id), changes);
}

export function reviewVocabulary(id, grade) {
  return postJson('/Jellio/vocab/' + encodeURIComponent(id) + '/review', { Grade: grade });
}

export function deleteVocabulary(id) {
  return deleteJson('/Jellio/vocab/' + encodeURIComponent(id));
}

// A file download that needs the auth header, so it can't be a plain link.
export async function downloadVocabularyExport(format) {
  const response = await fetch(getServerAddress() + '/Jellio/vocab/export?format=' + encodeURIComponent(format), {
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error('Export failed');
  const disposition = response.headers.get('Content-Disposition') || '';
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  return { blob: await response.blob(), filename: match ? decodeURIComponent(match[1]) : 'jellio-vocabulary.' + (format === 'anki' ? 'txt' : 'csv') };
}

// The reader checking in for Now Playing (reading has no Jellyfin
// session). Best effort: a missed check-in just drops out of the list.
export function reportNowReading(entry) {
  if (isOffline()) return Promise.resolve();
  return postJson('/Jellio/now-playing/reading', entry, 10000).catch(() => {});
}

export function clearNowReading(itemId) {
  if (isOffline()) return Promise.resolve();
  return deleteJson('/Jellio/now-playing/reading/' + encodeURIComponent(itemId), 10000).catch(() => {});
}
