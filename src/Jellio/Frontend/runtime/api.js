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

// Small in-memory cache for the handful of calls every single screen
// touches through the sidebar (views, collections, the current user):
// renderSidebar re-runs on every navigation, real feedback was that
// switching between libraries did not feel smooth, and a fresh round
// trip for data that is the same as it was three seconds ago is
// exactly why. Caches the in-flight promise, not just the resolved
// value, so two calls that land while the first request is still out
// (a real case here: app.js's own preload and the sidebar's first
// render can both ask for the same thing within the same tick) share
// one request instead of firing two. Nothing here persists past a
// reload, same as the rest of this runtime's own state, and logout()
// already reloads the page, so there is no separate invalidation path
// to build for that case, only for the one real case where cached data
// can go stale sooner than the TTL: invalidateUser() below.
const CACHE_TTL_MS = 60000;
const cache = new Map();

function cached(key, fetcher) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.promise;
  const promise = fetcher().catch(function (err) {
    cache.delete(key);
    throw err;
  });
  cache.set(key, { promise: promise, ts: Date.now() });
  return promise;
}

function invalidateCache(key) {
  cache.delete(key);
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
  return cached('user:' + userId, function () {
    return getJson('/Users/' + userId);
  });
}

// The one place cached user data can go visibly stale sooner than the
// TTL: an avatar the reader just picked should show up in the sidebar
// on the very next render, not up to a minute later. setUserAvatar
// below calls this itself rather than leaving it to every caller to
// remember.
function invalidateCurrentUser() {
  const userId = getCurrentUserId();
  if (userId) invalidateCache('user:' + userId);
}

// A user's own libraries, the same list the native sidebar and home screen
// both read from, real endpoint (GET /Users/{id}/Views).
export function getUserViews() {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  return cached('views:' + userId, function () {
    return getJson('/Users/' + userId + '/Views').then(function (result) {
      return (result && result.Items) || [];
    });
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

export function getUserImageUrl(userId, tag, options) {
  const opts = options || {};
  const params = new URLSearchParams();
  if (tag) params.set('tag', tag);
  if (opts.maxWidth) params.set('maxWidth', String(opts.maxWidth));
  const query = params.toString();
  return getServerAddress() + '/Users/' + userId + '/Images/Primary' + (query ? '?' + query : '');
}

// Jellio's own real endpoint (Controllers/AvatarsController.cs, ported
// verbatim), lists whatever preset images an admin has dropped into the
// plugin's own data directory.
export function getAvatarPresets() {
  return getJson('/Jellio/avatars');
}

export function getAvatarPresetUrl(id) {
  return getServerAddress() + '/Jellio/avatars/' + encodeURIComponent(id);
}

// Setting the chosen preset as a user's own avatar is not Jellio's job,
// real mechanism confirmed against jellyfin-apiclient-javascript's own
// uploadUserImage before writing this: fetch the preset's own bytes,
// base64 encode them, POST to the same real POST /Users/{id}/Images/
// Primary endpoint the stock profile page's own file upload already
// uses, body is the base64 payload itself with Content-Type set to the
// image's real mime type, not JSON.
export async function setUserAvatar(presetId) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));

  const imageResponse = await fetch(getAvatarPresetUrl(presetId));
  if (!imageResponse.ok) {
    throw new Error('Could not load preset avatar');
  }
  const blob = await imageResponse.blob();
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

// Streaming service hub: which catalog collections a server really has,
// the only thing that can be asked. Gelato writes no Studios/network
// field onto an imported item at all (GelatoManager.IntoBaseItem sets
// name, dates, overview, rating, genres, runtime, certification, country
// and provider ids, nothing about where a title streams), confirmed
// against the original Jellio codebase's own streamingHub.js before
// porting this.
export function getCollections() {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  return cached('collections:' + userId, function () {
    const params = new URLSearchParams({
      IncludeItemTypes: 'BoxSet',
      Recursive: 'true',
      SortBy: 'SortName',
      Limit: '100',
      // ChildCount is not part of a BoxSet's default field set, and
      // screens/home.js's own catalog rows filter on it (a catalog
      // with fewer than three real items is not worth a row): without
      // asking for it explicitly every collection reads back as 0
      // children and buildCatalogRows drops all of them, silently.
      Fields: 'ProviderIds,ChildCount',
    });
    return getJson('/Users/' + userId + '/Items?' + params.toString()).then(function (result) {
      return (result && result.Items) || [];
    });
  });
}

// Anime checked first regardless of provider id: an AniList catalog's own
// ProviderIds.Stremio reads "Series.<id>", identical in shape to a real TV
// catalog's, so only the collection's own name (always named for it) can
// tell the two apart. Same ordering bug the original codebase's own
// kindOfCollection already found and fixed, ported rather than re-derived.
export function collectionKind(collection) {
  if (/anime|anilist/i.test(collection.Name || '')) return 'tvshows';
  const ids = collection.ProviderIds || {};
  const stremio = ids.Stremio || ids.stremio;
  if (stremio) {
    const type = String(stremio).split('.')[0].toLowerCase();
    return type === 'movie' ? 'movies' : 'tvshows';
  }
  return 'movies';
}

export function getCollectionItems(collectionId, kind, limit) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const params = new URLSearchParams({
    ParentId: collectionId,
    IncludeItemTypes: itemTypesForKind(kind),
    Limit: String(limit || 24),
    Fields: 'ProductionYear,CommunityRating,Genres',
    SortBy: 'SortName',
  });
  return getJson('/Users/' + userId + '/Items?' + params.toString()).then(function (result) {
    return (result && result.Items) || [];
  });
}

// Real endpoint, POST /Users/{id}/Password, body { CurrentPw, NewPw },
// confirmed against jellyfin-apiclient-javascript's own
// updateUserPassword before writing this rather than guessing field
// names, the same call the stock profile page's own password form uses.
export function updateUserPassword(currentPassword, newPassword) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  return postJson('/Users/' + userId + '/Password', {
    CurrentPw: currentPassword || '',
    NewPw: newPassword,
  });
}

// A subtitle stream not in text form (PGS, VobSub, any image based
// format) has no WebVTT representation to hand a <track> element, real
// distinction confirmed against MediaStream.cs's own IsTextSubtitleStream
// before writing this: only checked, never guessed at from Codec alone.
export function getSubtitleStreams(mediaSource) {
  return (mediaSource.MediaStreams || []).filter(function (stream) {
    return stream.Type === 'Subtitle' && stream.IsTextSubtitleStream;
  });
}

// Real endpoint confirmed against SubtitleController.cs's own registered
// route before writing this: GET /Videos/{itemId}/{mediaSourceId}/
// Subtitles/{streamIndex}/Stream.vtt converts any text subtitle format to
// WebVTT server side, so requesting .vtt always works for a text stream
// regardless of its real source codec. An already external stream
// (DeliveryMethod === 'External') carries its own DeliveryUrl instead,
// confirmed against jellyfin-web's own playbackmanager.js: absolute when
// IsExternalUrl is set, otherwise still relative to this same server.
export function buildSubtitleUrl(itemId, mediaSourceId, stream) {
  if (stream.DeliveryMethod === 'External' && stream.DeliveryUrl) {
    return stream.IsExternalUrl ? stream.DeliveryUrl : getServerAddress() + stream.DeliveryUrl;
  }
  const token = getAccessToken();
  return (
    getServerAddress() +
    '/Videos/' + itemId + '/' + mediaSourceId + '/Subtitles/' + stream.Index + '/Stream.vtt' +
    (token ? '?ApiKey=' + encodeURIComponent(token) : '')
  );
}

// Real endpoint, GET /Jellio/now-playing (Controllers/NowPlayingController.cs,
// ported verbatim), reads Jellyfin's own real ISessionManager server side,
// every active session with NowPlayingItem set, any signed in user, this
// is a shared "who is watching what" surface by design.
export function getNowPlayingSessions() {
  return getJson('/Jellio/now-playing');
}

// The next episode after this one, for the player's own up-next overlay.
// No native jellyfin-web up next dialog to reskin here (that only exists
// in jellyfin-web's own player bundle, unreachable from this runtime, see
// screens/player.js's own header), so this runtime finds it itself from
// data already fetched elsewhere: the current season's own episode list,
// falling back to the next season's first episode at a season boundary.
export async function getNextEpisode(item) {
  if (!item || item.Type !== 'Episode' || !item.SeriesId) return null;

  if (item.SeasonId) {
    const episodes = await getEpisodes(item.SeriesId, item.SeasonId);
    const index = episodes.findIndex(function (episode) {
      return episode.Id === item.Id;
    });
    if (index !== -1 && index + 1 < episodes.length) {
      return episodes[index + 1];
    }
  }

  const seasons = await getSeasons(item.SeriesId);
  const seasonIndex = seasons.findIndex(function (season) {
    return season.Id === item.SeasonId;
  });
  const nextSeason = seasonIndex !== -1 ? seasons[seasonIndex + 1] : null;
  if (!nextSeason) return null;

  const nextEpisodes = await getEpisodes(item.SeriesId, nextSeason.Id);
  return nextEpisodes.length ? nextEpisodes[0] : null;
}

// Random, not DateCreated: Gelato stamps DateCreated as the import
// instant (Services/CatalogImportService.cs), the same for every title a
// catalog import brought in at once, so sorting by it means "whichever
// page happened to sort first among several hundred titles stamped the
// same second", not "newest". Confirmed against the original Jellio
// codebase's own heroCarousel.js before porting the same choice here.
export function getHeroCandidates(limit, options) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const opts = options || {};
  const params = new URLSearchParams({
    SortBy: 'Random',
    Recursive: 'true',
    IncludeItemTypes: opts.itemTypes || 'Movie,Series',
    Limit: String(limit || 8),
    Fields: 'Overview,Genres,ProductionYear,RunTimeTicks,OfficialRating',
  });
  if (opts.parentId) params.set('ParentId', opts.parentId);
  return getJson('/Users/' + userId + '/Items?' + params.toString()).then(function (result) {
    return (result && result.Items) || [];
  });
}

// Which genres a library actually has enough of to be worth a row,
// ported from the original codebase's own libraryBrowse.js
// discoverGenres(): counted from a random sample rather than asked of
// /Genres, since that endpoint answers which genre names exist, not
// which carry enough titles for a row worth scrolling. A genre with
// fewer than 8 titles in the sample is dropped, same threshold, same
// reasoning, not re-derived. parentId is optional: the home screen's
// own genre rows sample the whole server the same way the original
// codebase's own homeRows.js discoverGenres() does, not one library.
export function discoverGenres(parentId, itemType, limit) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const params = new URLSearchParams({
    Recursive: 'true',
    IncludeItemTypes: itemType,
    Limit: '300',
    Fields: 'Genres',
    SortBy: 'Random',
  });
  if (parentId) params.set('ParentId', parentId);
  return getJson('/Users/' + userId + '/Items?' + params.toString())
    .then(function (result) {
      const items = (result && result.Items) || [];
      const counts = {};
      items.forEach(function (item) {
        (item.Genres || []).forEach(function (genre) {
          counts[genre] = (counts[genre] || 0) + 1;
        });
      });
      return Object.keys(counts)
        .filter(function (genre) {
          return counts[genre] >= 8;
        })
        .sort(function (a, b) {
          return counts[b] - counts[a];
        })
        .slice(0, limit || 6);
    })
    .catch(function () {
      return [];
    });
}

export function getGenreItems(parentId, itemType, genre, limit) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const params = new URLSearchParams({
    Recursive: 'true',
    IncludeItemTypes: itemType,
    Genres: genre,
    Limit: String(limit || 20),
    Fields: 'ProductionYear,CommunityRating',
    SortBy: 'CommunityRating',
    SortOrder: 'Descending',
  });
  if (parentId) params.set('ParentId', parentId);
  return getJson('/Users/' + userId + '/Items?' + params.toString()).then(function (result) {
    return (result && result.Items) || [];
  });
}

// Soft dependency on the community Intro Skipper plugin
// (github.com/intro-skipper/intro-skipper). Real endpoint confirmed
// against its own SkipIntroController.cs before writing this: GET
// /Episode/{id}/Timestamps, despite the route name it works for both
// Episode and Movie items. A segment with no real detection comes back
// as Start: 0, End: 0, the server's own Segment.Valid rule is End > 0,
// not something this runtime invents. Any failure (plugin not
// installed, unknown item) resolves to an empty object rather than
// throwing, since this is a soft dependency: no segments is a normal
// outcome, not an error worth surfacing.
export async function getIntroSkipperSegments(itemId) {
  try {
    const result = await getJson('/Episode/' + itemId + '/Timestamps');
    return result || {};
  } catch (err) {
    return {};
  }
}

// A person's own real item DTO (name, overview, image tag), the same
// generic GET /Users/{id}/Items/{itemId} every other item detail lookup
// in this file already uses, works for a Person item exactly like it
// does for a Movie or Series.
export function getPerson(personId) {
  return getItem(personId);
}

// A person's filmography, real endpoint confirmed against
// Jellyfin.Api.Controllers.ItemsController.cs before writing this:
// GET /Items?personIds=X, a real, documented query param (comma
// delimited, lowercase in the query string despite PascalCase
// everywhere else in this file, confirmed from the controller's own
// parameter binding), not guessed from the Filters pattern this file
// uses elsewhere.
export function getPersonFilmography(personId, limit) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const params = new URLSearchParams({
    personIds: personId,
    Recursive: 'true',
    IncludeItemTypes: 'Movie,Series',
    SortBy: 'PremiereDate',
    SortOrder: 'Descending',
    Fields: 'PrimaryImageAspectRatio,ProductionYear',
    Limit: String(limit || 50),
  });
  return getJson('/Users/' + userId + '/Items?' + params.toString()).then(function (result) {
    return (result && result.Items) || [];
  });
}
