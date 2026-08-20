// Every server call Jellio's own screens need, built directly on fetch and
// auth.js's own headers. Nothing here touches window.ApiClient: the whole
// point of this runtime is that a screen's data never depends on native
// jellyfin-web's own request/cache state, only on a real HTTP response.
import { getServerAddress, getAuthHeaders, getCurrentUserId, getAccessToken, getDeviceId } from './auth.js';

async function getJson(path) {
  const response = await fetch(getServerAddress() + path, {
    headers: Object.assign({ Accept: 'application/json' }, getAuthHeaders()),
  });
  if (!response.ok) {
    const err = new Error('Request failed: ' + path);
    err.status = response.status;
    throw err;
  }
  return response.json();
}

// Fire and forget by design: a session report failing should never break
// playback itself, only leave resume position slightly stale, the same
// tradeoff every other real Jellyfin client already makes for these calls.
async function postJson(path, body) {
  const response = await fetch(getServerAddress() + path, {
    method: 'POST',
    headers: Object.assign(
      { 'Content-Type': 'application/json', Accept: 'application/json' },
      getAuthHeaders(),
    ),
    body: JSON.stringify(body || {}),
  });
  if (!response.ok) {
    const err = new Error('Request failed: ' + path);
    err.status = response.status;
    throw err;
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

export function getSystemInfo() {
  return getJson('/System/Info');
}

export function getItem(itemId) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  return getJson('/Users/' + userId + '/Items/' + itemId);
}

// A library grid's own getItem call gets whatever fields Jellyfin returns
// by default, enough for a heading. A detail screen needs real metadata
// (overview, genres, cast) that only comes back when explicitly asked for,
// real Jellyfin API behaviour, not this runtime's own choice.
export function getItemDetails(itemId) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const params = new URLSearchParams({
    Fields: 'Overview,Genres,People,Studios,ProductionYear',
  });
  return getJson('/Users/' + userId + '/Items/' + itemId + '?' + params.toString());
}

export function getCurrentUser() {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  return getJson('/Users/' + userId);
}

// A user's own libraries, the same list the native sidebar and home screen
// both read from, real endpoint (GET /Users/{id}/Views).
export function getUserViews() {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  return getJson('/Users/' + userId + '/Views').then(function (result) {
    return (result && result.Items) || [];
  });
}

// Real endpoint, the same one the native Resume/Continue Watching row
// reads: GET /Users/{id}/Items/Resume.
export function getResumeItems(limit) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const query =
    '/Users/' +
    userId +
    '/Items/Resume?Limit=' +
    (limit || 20) +
    '&Fields=PrimaryImageAspectRatio&EnableImageTypes=Primary,Backdrop,Thumb';
  return getJson(query).then(function (result) {
    return (result && result.Items) || [];
  });
}

// Latest items for one library, the same data the native home screen's own
// per-library "Latest in X" row reads (GET /Users/{id}/Items/Latest).
export function getLatestItems(parentId, limit) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const query =
    '/Users/' +
    userId +
    '/Items/Latest?ParentId=' +
    encodeURIComponent(parentId) +
    '&Limit=' +
    (limit || 16) +
    '&Fields=PrimaryImageAspectRatio';
  return getJson(query);
}

// Real, confirmed against the original Jellio codebase's own
// libraryBrowse.js: a BoxSet mixed into a movie/series catalog by an addon
// import has no stream of its own and should never render as a browsable
// card in a movie or show grid.
export function itemTypesForKind(collectionType) {
  return collectionType === 'movies' ? 'Movie' : 'Series';
}

// The full grid for one library, real endpoint (GET /Users/{id}/Items),
// the same query shape libraryBrowse.js's own row builders already use:
// Recursive so a show's own seasons/episodes never surface as top level
// cards, IncludeItemTypes scoped to the library's real kind.
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
    Fields: 'PrimaryImageAspectRatio,ProductionYear',
    Limit: String(opts.limit || 100),
    StartIndex: String(opts.startIndex || 0),
  });
  return getJson('/Users/' + userId + '/Items?' + params.toString());
}

// Real endpoints, GET /Shows/{id}/Seasons and GET /Shows/{id}/Episodes,
// the dedicated show hierarchy API rather than a plain /Items query: a
// season/episode listing needs real ordering and season scoping that
// endpoint provides directly.
export function getSeasons(seriesId) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  return getJson('/Shows/' + seriesId + '/Seasons?userId=' + userId).then(function (result) {
    return (result && result.Items) || [];
  });
}

export function getEpisodes(seriesId, seasonId) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const params = new URLSearchParams({
    userId: userId,
    seasonId: seasonId,
    Fields: 'Overview,PrimaryImageAspectRatio',
  });
  return getJson('/Shows/' + seriesId + '/Episodes?' + params.toString()).then(function (result) {
    return (result && result.Items) || [];
  });
}

// Real Jellyfin search pattern, the same /Items endpoint everything else
// in this file already uses with a searchTerm added, not the older
// /Search/Hints endpoint: keeps every item query in this runtime going
// through one shape rather than two.
export function searchItems(term, limit) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  if (!term) return Promise.resolve([]);
  const params = new URLSearchParams({
    searchTerm: term,
    Recursive: 'true',
    IncludeItemTypes: 'Movie,Series',
    Fields: 'PrimaryImageAspectRatio',
    Limit: String(limit || 50),
  });
  return getJson('/Users/' + userId + '/Items?' + params.toString()).then(function (result) {
    return (result && result.Items) || [];
  });
}

// Every favorited item, real endpoint (GET /Users/{id}/Items with
// Filters=IsFavorite), the same #/home?tab=1 route the sidebar's own
// Favorites link and the original Jellio codebase's own NAV_LINKS both
// already point at.
export function getFavoriteItems(limit) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const params = new URLSearchParams({
    Filters: 'IsFavorite',
    Recursive: 'true',
    IncludeItemTypes: 'Movie,Series',
    Fields: 'PrimaryImageAspectRatio',
    Limit: String(limit || 100),
  });
  return getJson('/Users/' + userId + '/Items?' + params.toString()).then(function (result) {
    return (result && result.Items) || [];
  });
}

// Real endpoint pair, POST/DELETE /Users/{id}/FavoriteItems/{itemId},
// returns the item's own updated UserItemDataDto (IsFavorite reflects
// what actually happened server side rather than this runtime assuming
// the request succeeded).
export async function setFavorite(itemId, isFavorite) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const response = await fetch(
    getServerAddress() + '/Users/' + userId + '/FavoriteItems/' + itemId,
    {
      method: isFavorite ? 'POST' : 'DELETE',
      headers: Object.assign({ Accept: 'application/json' }, getAuthHeaders()),
    },
  );
  if (!response.ok) {
    const err = new Error('Request failed: FavoriteItems');
    err.status = response.status;
    throw err;
  }
  return response.json();
}

// Real mechanism, confirmed against JMSFusion's own source
// (RuntimeModules/api.js's own getVideoStreamUrl) before writing any of
// this, not guessed at: POST /Items/{id}/PlaybackInfo negotiates a real
// MediaSource, then a plain /Videos/{id}/stream URL carrying that source's
// own id plus an api_key query param is something a bare <video> element
// can just set as its src, no playbackManager involved at all. That
// module export only orchestrates native's own OSD/queue UI on top of
// exactly this same real HTTP flow.
export function getPlaybackInfo(itemId, startTimeTicks) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  return postJson('/Items/' + itemId + '/PlaybackInfo', {
    UserId: userId,
    StartTimeTicks: startTimeTicks || 0,
    EnableDirectPlay: true,
    EnableDirectStream: true,
    EnableTranscoding: true,
    AutoOpenLiveStream: true,
  });
}

// 1 second = 10,000,000 ticks, real .NET TimeSpan tick length every
// Jellyfin position field (PositionTicks, StartTimeTicks, RunTimeTicks)
// already uses.
export const TICKS_PER_SECOND = 10000000;

export function buildStreamUrl(itemId, mediaSource, startTimeTicks) {
  const token = getAccessToken();
  const container = (mediaSource && mediaSource.Container) || 'mp4';
  const params = new URLSearchParams({
    Static: 'true',
    MediaSourceId: (mediaSource && mediaSource.Id) || itemId,
    DeviceId: getDeviceId(),
    api_key: token || '',
    StartTimeTicks: String(startTimeTicks || 0),
  });
  return getServerAddress() + '/Videos/' + itemId + '/stream.' + container + '?' + params.toString();
}

// Real endpoints, POST /Sessions/Playing, /Sessions/Playing/Progress and
// /Sessions/Playing/Stopped, the same three every real Jellyfin client
// reports through, confirmed against jellyfin-apiclient-javascript's own
// apiClient.js. Resume position and watched state (the Continue Watching
// row, a card's own progress bar, both already built) come from exactly
// these reports, not from this runtime inventing its own tracking.
export function reportPlaybackStart(itemId, mediaSourceId, positionTicks) {
  return postJson('/Sessions/Playing', {
    ItemId: itemId,
    MediaSourceId: mediaSourceId,
    PositionTicks: positionTicks || 0,
    CanSeek: true,
    PlayMethod: 'DirectStream',
  }).catch(function (err) {
    console.warn('Jellio: reportPlaybackStart failed', err);
  });
}

export function reportPlaybackProgress(itemId, mediaSourceId, positionTicks, isPaused) {
  return postJson('/Sessions/Playing/Progress', {
    ItemId: itemId,
    MediaSourceId: mediaSourceId,
    PositionTicks: positionTicks || 0,
    IsPaused: !!isPaused,
    CanSeek: true,
    PlayMethod: 'DirectStream',
  }).catch(function (err) {
    console.warn('Jellio: reportPlaybackProgress failed', err);
  });
}

export function reportPlaybackStopped(itemId, mediaSourceId, positionTicks) {
  return postJson('/Sessions/Playing/Stopped', {
    ItemId: itemId,
    MediaSourceId: mediaSourceId,
    PositionTicks: positionTicks || 0,
  }).catch(function (err) {
    console.warn('Jellio: reportPlaybackStopped failed', err);
  });
}

// Jellio's own real endpoints (Controllers/SleepTimerController.cs), not
// a Jellyfin API. Server side, backed by SleepTimerService's own
// background loop and a real ISessionManager.SendPlaystateCommand(Stop),
// so this works with no client side player hooking at all, unlike
// anything that would have needed jellyfin-web's own playbackManager.
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

export function getImageUrl(itemId, type, options) {
  const opts = options || {};
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
