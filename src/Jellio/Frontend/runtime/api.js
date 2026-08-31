// Every server call Jellio's own screens need, built directly on fetch and
// auth.js's own headers. Nothing here touches window.ApiClient: the whole
// point of this runtime is that a screen's data never depends on native
// jellyfin-web's own request/cache state, only on a real HTTP response.
import { getServerAddress, getAuthHeaders, getCurrentUserId, getAccessToken, getDeviceId, clearSession } from './auth.js';
import { languageName } from './languages.js';

// Nuvio's own real AddonPlatform HTTP clients (OkHttp on Android, Ktor's
// own HttpTimeout plugin on iOS, both confirmed against real source
// before writing this) cap every addon call at 60s rather than leaving
// it open ended: a request this runtime cannot get an answer to inside
// a real, generous window is a request worth surfacing as failed
// rather than one left hanging forever with nothing telling the reader
// it is even still trying.
//
// Real bug, found live after shipping one flat 30s timeout for every
// call here: a browser caps concurrent connections per origin (6 on
// plain HTTP/1.1, still a real limit under a lot of self hosted
// reverse proxies), and library/home screens fire a real handful of
// these in parallel (catalog rows, genre rows, coverflow, ...). On a
// slow connection every one of those used to just sit there for the
// full 30s before failing, holding that many connection slots hostage
// the whole time, so image tags for the very same rows, and any other
// screen's own next real navigation, had nowhere left to open a
// connection at all: reported live as rows and titles loading but
// never their real images, and the whole app going unresponsive to
// further navigation right behind it, worse than the silent hang this
// was meant to fix in the first place. DEFAULT_TIMEOUT_MS is short
// enough now that one slow request frees its own slot back up quickly;
// getPlaybackInfo below is the one real exception, a single real call,
// never running alongside a pile of others the way every list screen's
// own calls do, and Gelato resolving a real debrid/usenet source
// behind it can legitimately take longer than a plain metadata list
// ever should.
const DEFAULT_TIMEOUT_MS = 10000;
const NEGOTIATION_TIMEOUT_MS = 30000;
// Same real exception as getPlaybackInfo above and for the same real
// reason: search.js only ever has one of these in flight at a time
// (its own requestId guard, never fired alongside a pile of list
// screen calls), and Gelato resolving a live search across Stremio
// addons behind it can legitimately take longer than DEFAULT_TIMEOUT_MS
// gives it, reported live as search always timing out.
const SEARCH_TIMEOUT_MS = 30000;
// Same real exception, same real reason: screens/detail.js's own header
// already documents that a search result's own item id can be Gelato's
// synthetic placeholder, and the very request getItemDetails below makes
// is what triggers its real metadata insert the first time a title is
// ever opened, a real Stremio/TMDb round trip DEFAULT_TIMEOUT_MS was
// never sized for. An already-imported title (every subsequent open)
// still answers in well under this, this only ever matters once per
// title.
const ITEM_DETAILS_TIMEOUT_MS = 30000;

// Real regression, found live off today's own earlier fixes: this
// file's own header just above already names the exact failure mode
// (the browser's hard per-origin connection cap, 6 on plain HTTP/1.1)
// and the exact symptom (rows and images stuck, further navigation
// unresponsive) that shortening DEFAULT_TIMEOUT_MS only ever recovered
// from faster, never actually prevented. Parallelizing catalog rows,
// genre rows, and every recommendation candidate/genre/person fetch
// (today's own earlier commits, each individually correct) stacked
// together into exactly that: home's own initial load now opens
// twenty-plus of these at once on a server with a full catalog,
// several times the browser's own real ceiling, so most of them just
// queue behind each other until DEFAULT_TIMEOUT_MS kills them, the
// rows-not-appearing symptom reported live. A small global slot queue
// here, the one real choke point every one of these calls already
// funnels through, caps how many are ever actually in flight at once
// instead of leaving that entirely up to the browser's own queue and
// this runtime's own timeout to sort out after the fact. Below the
// browser's own 6-connection ceiling rather than at it, leaving real
// headroom for whatever image tags the same screen is also loading
// through that same shared per-origin pool.
const MAX_CONCURRENT_REQUESTS = 5;
let activeRequestCount = 0;
const queuedRequestStarts = [];

function acquireRequestSlot() {
  return new Promise(function (resolve) {
    function start() {
      activeRequestCount++;
      resolve(function releaseRequestSlot() {
        activeRequestCount--;
        if (queuedRequestStarts.length && activeRequestCount < MAX_CONCURRENT_REQUESTS) {
          queuedRequestStarts.shift()();
        }
      });
    }
    if (activeRequestCount < MAX_CONCURRENT_REQUESTS) start();
    else queuedRequestStarts.push(start);
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

async function requestJson(url, options, path, timeoutMs, externalSignal) {
  const releaseRequestSlot = await acquireRequestSlot();
  try {
    // A request cancelled while still queued for a slot (search.js's own
    // superseded-query case) has no real fetch to abort yet: skip
    // dispatching it at all rather than opening a connection this
    // runtime already knows nobody wants the answer to anymore.
    if (externalSignal && externalSignal.aborted) {
      const abortedErr = new Error('Request timed out: ' + path);
      abortedErr.timedOut = true;
      throw abortedErr;
    }

    let response;
    try {
      response = await fetchWithTimeout(url, options, timeoutMs, externalSignal);
    } catch (err) {
      if (err && err.name === 'AbortError') {
        // A caller-driven abort (search.js cancelling a superseded query) is
        // not a real timeout, but nothing downstream tells the two apart
        // today: every current caller either ignores a stale request's own
        // rejection outright (search.js's own requestId guard) or has no
        // caller-driven abort path to begin with, so folding both into the
        // same timedOut shape is not yet a real bug, only a latent one.
        const timeoutErr = new Error('Request timed out: ' + path);
        timeoutErr.timedOut = true;
        throw timeoutErr;
      }
      throw err;
    }
    if (!response.ok) {
      // Real bug, found live: a caller further up (app.js's own
      // preloadInitialData(), most of all: runTrackedTasks() there
      // catches every one of its own tasks' real rejections internally,
      // console.warn only, never re-throwing) can and does swallow this
      // exact error long before it ever reaches anything that might
      // treat a 401 as "this session is dead", so a token revoked
      // server side (deleting its device from the Dashboard, or any
      // other real revocation) left every screen quietly failing to
      // load real data forever, never actually routing back to a real
      // login screen. This file is the one real choke point every
      // authenticated call in this whole runtime already goes through,
      // so handling a real 401 right here, unconditionally, reaches
      // every one of those callers regardless of whether any of them
      // individually re-throw.
      if (response.status === 401) {
        notifySessionExpired();
      }
      const err = new Error('Request failed: ' + path);
      err.status = response.status;
      throw err;
    }
    return response;
  } finally {
    releaseRequestSlot();
  }
}

// Guards against a burst of concurrent requests (preloadInitialData()'s
// own real task list, most of all) each independently 401ing and each
// separately clearing an already cleared session: real, harmless on its
// own, just real wasted work repeated for nothing once the first one
// has already done it. Reset on the next real fresh login (the same
// jellio:session-captured event app.js's own header already explains),
// or this would only ever fire once for the entire life of this page.
let sessionExpiredNotified = false;
document.addEventListener('jellio:session-captured', function () {
  sessionExpiredNotified = false;
});

function notifySessionExpired() {
  if (sessionExpiredNotified) return;
  sessionExpiredNotified = true;
  clearSession();
  // app.js's own jellio:session-captured listener (screens/login.js's
  // own header explains that real pattern first) is the same real
  // mechanism this reuses in reverse: a fresh sync() call, this exact
  // module's own header explains why importing app.js's sync() directly
  // is not an option here (app.js already imports from this file), so a
  // real DOM event is the one real way back without a circular import.
  document.dispatchEvent(new CustomEvent('jellio:session-expired'));
}

async function getJson(path, timeoutMs, signal) {
  const response = await requestJson(
    getServerAddress() + path,
    // Real bug, found live: a library missing from a fresh boot's own
    // /Users/{id}/Views answer (the server itself still mounting it,
    // Anime reported specifically) got served right back on a plain
    // reload with no cache option here telling the browser not to,
    // only a real hard reload bypassing HTTP cache ever picked up the
    // now-complete list. This runtime's own cached() below already
    // owns intentional short-lived reuse; the browser caching the same
    // response underneath it on top only ever adds staleness no caller
    // here asked for.
    { headers: Object.assign({ Accept: 'application/json' }, getAuthHeaders()), cache: 'no-store' },
    path,
    timeoutMs || DEFAULT_TIMEOUT_MS,
    signal,
  );
  return response.json();
}

// Fire and forget by design: a session report failing should never break
// playback itself, only leave resume position slightly stale, the same
// tradeoff every other real Jellyfin client already makes for these calls.
async function postJson(path, body, timeoutMs) {
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

// Same real requestJson() funnel getJson/postJson already go through,
// runtime/notifications.js's own delete/clear calls the one real reason
// this exists: neither needs the concurrency slot queue above skipped
// the way cancelSleepTimer's own bare fetch() still does.
async function deleteJson(path, timeoutMs) {
  await requestJson(
    getServerAddress() + path,
    { method: 'DELETE', headers: getAuthHeaders() },
    path,
    timeoutMs || DEFAULT_TIMEOUT_MS,
  );
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
// A shorter shelf life for anything that changes on the reader's own
// action within a session (watchlist, next up) or that gets asked for
// by more than one screen in close succession (a series' own seasons/
// episodes: detail screen, player and the player's own episode panel
// each ask independently, real duplication reported live within one
// title, not across a whole session). Long enough to actually collapse
// those real near-simultaneous requests into one, short enough that a
// mark watched/unwatched or a watchlist toggle reads correctly again
// well within the time it takes to navigate back and look.
const SHORT_CACHE_TTL_MS = 8000;
// Every distinct key (item id, library page, genre, ...) an unbounded
// session of browsing can produce its own entry here, and only a
// handful of actions (invalidateCache/invalidateUser/clearCache below)
// ever remove one, so this needs its own real cap rather than trusting
// callers to expire it for us. Map preserves insertion order, and a
// delete-then-set on a refreshed key moves it to the end, so eviction
// below is a real LRU: the entry nobody has touched in the longest real
// time goes first.
const cache = new Map();
const CACHE_MAX_ENTRIES = 500;

function cached(key, fetcher, ttlMs) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < (ttlMs || CACHE_TTL_MS)) return hit.promise;
  if (hit) cache.delete(key);
  if (cache.size >= CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
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

// Every real cache entry keyed off the previously signed in user
// (views, collections, item lookups, ...) is still real, still fresh
// data for that user, just the wrong one the moment
// components/accountSwitcher.js switches to a different real account
// without a real page reload. Called once, right after that switch
// actually lands, so the next screen this runtime renders asks the
// network again under the new real session instead of quietly
// serving the previous reader's own cached answers.
export function clearCache() {
  cache.clear();
}

export function getSystemInfo() {
  return getJson('/System/Info');
}

export function getItem(itemId) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  return cached('item:' + itemId, function () {
    return getJson('/Users/' + userId + '/Items/' + itemId);
  });
}

// A library grid's own getItem call gets whatever fields Jellyfin returns
// by default, enough for a heading. A detail screen needs real metadata
// (overview, genres, cast) that only comes back when explicitly asked for,
// real Jellyfin API behaviour, not this runtime's own choice.
export function getItemDetails(itemId) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const params = new URLSearchParams({
    // RunTimeTicks/PremiereDate/RemoteTrailers alongside the fields
    // already asked for: an Episode's own real detail page had nothing
    // but a bare year/rating/genre line without these, real feedback
    // live, and RemoteTrailers is screens/detail.js's own real Trailers
    // row's one data source (TMDb's own metadata provider, already
    // installed, populates it server side with no extra work here).
    Fields: 'Overview,Genres,People,Studios,ProductionYear,RunTimeTicks,PremiereDate,RemoteTrailers,Trickplay',
  });
  return getJson('/Users/' + userId + '/Items/' + itemId + '?' + params.toString(), ITEM_DETAILS_TIMEOUT_MS);
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
  // RunTimeTicks alongside the field already asked for: components/
  // card.js's own landscape Continue Watching card computes a real
  // "X left" label from this and UserData.PlaybackPositionTicks
  // (already a default real field), not something this query fetched
  // before.
  const query =
    '/Users/' +
    userId +
    '/Items/Resume?Limit=' +
    (limit || 20) +
    '&Fields=PrimaryImageAspectRatio,RunTimeTicks&EnableImageTypes=Primary,Backdrop,Thumb';
  return getJson(query).then(function (result) {
    return (result && result.Items) || [];
  });
}

// Real endpoint, GET /Shows/NextUp (Jellyfin.Api's own TvShowsController,
// route "Shows", confirmed against real source before writing this): the
// next unwatched episode for every series the reader is partway through,
// distinct from getResumeItems above (an episode or movie actually
// stopped mid playback). Based on watch state, not DateCreated, so it
// does not have the same "means nothing on a Gelato server" problem the
// rest of this file's own header documents for a plain recency sort.
export function getNextUp(limit) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const params = new URLSearchParams({
    userId: userId,
    Limit: String(limit || 20),
    // Genres/People beyond the default PrimaryImageAspectRatio: this
    // same real list already backs a "Because you're watching" row
    // (runtime/recommend.js), the exact fields its own scorer needs,
    // no second query added just to get them.
    Fields: 'PrimaryImageAspectRatio,Genres,People,RunTimeTicks',
    // TvShowsController's own real default for this param is true: an
    // episode already sitting mid playback (real PositionTicks > 0)
    // still counts as that series' own "next" episode server side
    // unless this is turned off, so it landed in both this row and
    // getResumeItems above at once, real feedback live. Continue
    // Watching already owns any title with real progress on it; Up Next
    // should only ever be the genuinely un-started next episode.
    enableResumable: 'false',
  });
  const path = '/Shows/NextUp?' + params.toString();
  return Promise.all([
    cached(path, function () {
      return getJson(path);
    }, SHORT_CACHE_TTL_MS),
    getHiddenNextUpSeries(),
  ]).then(function (results) {
    const items = (results[0] && results[0].Items) || [];
    const hidden = results[1];
    if (!hidden.length) return items;
    return items.filter(function (item) {
      return hidden.indexOf(item.SeriesId) === -1;
    });
  });
}

// Real gap in stock Jellyfin: no endpoint hides one series from
// GET /Shows/NextUp on its own, only ever the side effect of marking its
// current episode played, which just advances that same series to its
// own next episode instead of actually leaving the row (real bug
// reported live). Backed by Controllers/NextUpHiddenController.cs's own
// per user JSON file, a plain array of series ids, same short cache
// getNextUp itself already leans on so a hide reads as gone on this
// row's own very next fetch rather than up to a minute later.
function getHiddenNextUpSeries() {
  return cached('next-up-hidden', function () {
    return getJson('/Jellio/next-up-hidden');
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
  });
}

// Same real endpoint as getNextUp above, scoped to one series for the
// detail screen's own series-level Play button: enableResumable stays
// at its own real server default here (true), unlike the home row
// above, that button's whole real point is surfacing a title actually
// in progress, not only a genuinely unstarted one.
export function getSeriesNextUp(seriesId) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const params = new URLSearchParams({
    userId: userId,
    seriesId: seriesId,
    Limit: '1',
    Fields: 'PrimaryImageAspectRatio,RunTimeTicks',
  });
  const path = '/Shows/NextUp?' + params.toString();
  return cached(path, function () {
    return getJson(path);
  }, SHORT_CACHE_TTL_MS).then(function (result) {
    return (result && result.Items && result.Items[0]) || null;
  });
}

// Seeds for "Because you watched": the reader's own most recently
// completed titles. IsPlayed is Jellyfin's own definition of finished
// (every episode, for a series), ported from the original codebase's
// own recommend.js, real endpoint and real filter, not re-derived.
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
  return getJson('/Users/' + userId + '/Items?' + params.toString()).then(function (result) {
    return (result && result.Items) || [];
  });
}

// One seed's own candidate pool for runtime/recommend.js's own scorer:
// its own genres and its own top billed cast/director, each a
// separate query narrowed server side rather than scoring the whole
// library client side to fill one row, same reasoning the original
// codebase's own candidatePool() documents. Entries carrying a
// PersonIds hit are tagged viaPerson so the scorer can weight a shared
// actor without a second People fetch per candidate.
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
    // RunTimeTicks alongside the fields already asked for: runtime/
    // recommend.js's own score() weighs how close a candidate's own
    // length sits to the seed's, the same kind of real signal era
    // already scores, not something this query fetched before.
    '&Fields=Genres,ProductionYear,CommunityRating,RunTimeTicks&SortBy=Random';

  const jobs = [];
  if (genres.length) {
    jobs.push(
      getJson(base + '&Genres=' + encodeURIComponent(genres.join('|')))
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
      getJson(base + '&PersonIds=' + personIds)
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
  return Object.keys(byId).map(function (id) {
    return byId[id];
  });
}

// Every real item crediting one specific person as Actor or Director,
// the same real query shape getRecommendationCandidates above already
// uses per seed's own People field, exposed on its own here: runtime/
// recommend.js's own "More with [actor]" row aggregates a person's own
// real appearance count across the reader's whole watch history rather
// than one seed at a time, so it needs this by itself, not tied to a
// single seed's own candidate pool.
export function getPersonItems(personId, limit) {
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
  return getJson('/Users/' + userId + '/Items?' + params.toString()).then(function (result) {
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
  if (opts.genre) params.set('Genres', opts.genre);
  const path = '/Users/' + userId + '/Items?' + params.toString();
  return cached(path, function () {
    return getJson(path);
  });
}

// Real endpoints, GET /Shows/{id}/Seasons and GET /Shows/{id}/Episodes,
// the dedicated show hierarchy API rather than a plain /Items query: a
// season/episode listing needs real ordering and season scoping that
// endpoint provides directly.
// Short lived cache, same SHORT_CACHE_TTL_MS reasoning as getNextUp
// above: the detail screen, the player and the player's own episode
// side panel each ask for the same series' own seasons/episodes
// independently within one real viewing session, reported live as
// real duplicate requests landing within milliseconds of each other
// for the exact same data.
export function getSeasons(seriesId) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const path = '/Shows/' + seriesId + '/Seasons?userId=' + userId;
  return cached(path, function () {
    return getJson(path);
  }, SHORT_CACHE_TTL_MS).then(function (result) {
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
  const path = '/Shows/' + seriesId + '/Episodes?' + params.toString();
  return cached(path, function () {
    return getJson(path);
  }, SHORT_CACHE_TTL_MS).then(function (result) {
    return (result && result.Items) || [];
  });
}

// Real Jellyfin search pattern, the same /Items endpoint everything else
// in this file already uses with a searchTerm added, not the older
// /Search/Hints endpoint: keeps every item query in this runtime going
// through one shape rather than two.
export function searchItems(term, limit, signal) {
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
  return getJson('/Users/' + userId + '/Items?' + params.toString(), SEARCH_TIMEOUT_MS, signal).then(function (result) {
    return (result && result.Items) || [];
  });
}

// Every watchlisted item, real endpoint (GET /Users/{id}/Items with
// Filters=IsFavorite, Jellyfin's own real favorites concept underneath
// this app's own Watchlist wording), the same #/home?tab=1 route the
// sidebar's own Watchlist link and the original Jellio codebase's own
// NAV_LINKS both already point at.
export function getWatchlistItems(limit) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const params = new URLSearchParams({
    Filters: 'IsFavorite',
    Recursive: 'true',
    IncludeItemTypes: 'Movie,Series',
    Fields: 'PrimaryImageAspectRatio',
    Limit: String(limit || 100),
  });
  const path = '/Users/' + userId + '/Items?' + params.toString();
  return cached(path, function () {
    return getJson(path);
  }, SHORT_CACHE_TTL_MS).then(function (result) {
    return (result && result.Items) || [];
  });
}

// Real GrouplistController.cs's own item id list, self only: no native
// Jellyfin concept to piggyback on the way Watchlist piggybacks on
// Favorites (that controller's own header explains why), so this
// plugin owns the storage instead. Membership alone, short cached same
// as every other list shaped read in this file; getGrouplistItems()
// below resolves real display detail for the Grouplist tab itself, a
// separate real cost only paid when that tab is actually open.
export function getGrouplistIds() {
  return cached('grouplist:ids', function () {
    return getJson('/Jellio/grouplist');
  }, SHORT_CACHE_TTL_MS).then(function (result) {
    return (result && result.ItemIds) || [];
  });
}

// Every real grouplisted item's own display detail, one real batched
// /Items?Ids= call rather than one getItem() per entry: same real
// endpoint family getWatchlistItems above already uses, just filtered
// by an explicit id list instead of Filters=IsFavorite since nothing
// server side already knows which ids these are.
export function getGrouplistItems() {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  return getGrouplistIds().then(function (ids) {
    if (!ids.length) return [];
    const params = new URLSearchParams({
      Ids: ids.join(','),
      Fields: 'PrimaryImageAspectRatio',
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

// Real endpoint pair, POST/DELETE /Users/{id}/PlayedItems/{itemId}
// (PlaystateController.cs), the same call the stock UI's own "mark
// watched" toggle makes. Returns the item's own updated
// UserItemDataDto, same shape setWatchlist below already returns.
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
  return response.json();
}

// Real endpoint pair, POST/DELETE /Users/{id}/FavoriteItems/{itemId}
// (this app's own Watchlist is Jellyfin's own real favorites concept
// under a different label, not a separate state), returns the item's
// own updated UserItemDataDto (IsFavorite reflects what actually
// happened server side rather than this runtime assuming the request
// succeeded).
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
  return response.json();
}

// Real endpoint pair, POST/DELETE /Users/{id}/Items/{itemId}/Rating
// (UserLibraryController.cs's own real UpdateItemRating/DeleteItemRating):
// a plain real like/dislike, UserData.Likes (true/false/absent), not a
// 1-10 star scale, same real shape the stock UI's own thumbs already
// use. Clearing sends the DELETE with no real likes query param at
// all, the one way this endpoint returns UserData.Likes to real
// undefined rather than toggling it to the opposite real value.
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

// Real mechanism, confirmed against JMSFusion's own source
// (RuntimeModules/api.js's own getVideoStreamUrl) before writing any of
// this, not guessed at: POST /Items/{id}/PlaybackInfo negotiates a real
// MediaSource, then a plain /Videos/{id}/stream URL carrying that source's
// own id plus an api_key query param is something a bare <video> element
// can just set as its src, no playbackManager involved at all. That
// module export only orchestrates native's own OSD/queue UI on top of
// exactly this same real HTTP flow.
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
  // Real field on PlaybackInfoDto (Jellyfin.Api's own
  // Models/MediaInfoDtos/PlaybackInfoDto.cs): omitted, the negotiation
  // picks whichever source GetPlaybackMediaSources defaults to; passed,
  // it re-negotiates that exact one instead, the same call a source
  // switch in the player makes with the id the reader just picked.
  if (mediaSourceId) body.MediaSourceId = mediaSourceId;
  // Also a real field on the same DTO. Real feedback, chased through a
  // real server log all the way down: a bare GET against the existing
  // /Videos/stream endpoint with a different AudioStreamIndex query
  // param, reusing the same PlaySessionId the title already opened on,
  // never once produced a genuinely new transcode job server side, no
  // matter how correctly that URL was built or how long a real gap sat
  // between it and the old session's own stop report. A source switch
  // right below never had that problem, and the one real thing it does
  // differently is exactly this: a fresh PlaybackInfo negotiation,
  // handing back a fresh PlaySessionId of its own, the same real
  // mechanism jellyfin-web's own playbackmanager.js uses for a track
  // switch too (confirmed against its source before writing this), not
  // a query param bolted onto whichever stream URL was already live.
  if (audioStreamIndex != null) body.AudioStreamIndex = audioStreamIndex;
  // Same real field, same real reason: a burned in subtitle switch is
  // the exact same kind of same MediaSourceId, different stream index
  // request an audio track switch already needed this real
  // renegotiation for, real feedback already traced all the way down
  // to a real server log why a bare GET alone was never enough.
  if (subtitleStreamIndex != null) body.SubtitleStreamIndex = subtitleStreamIndex;
  return postJson('/Items/' + itemId + '/PlaybackInfo', body, NEGOTIATION_TIMEOUT_MS);
}

// The item's own full list of real alternate sources (every stream
// Gelato resolved for it, not just the one PlaybackInfo negotiates),
// confirmed against DtoService.cs before writing this: MediaSources on
// a fetched item DTO only populates when ItemFields.MediaSources is
// explicitly requested, backed by the same GetStaticMediaSources() a
// stream switcher needs to list from, distinct from
// GetPlaybackMediaSources (what getPlaybackInfo above negotiates),
// which always narrows to one.
export function getMediaSources(itemId) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const params = new URLSearchParams({ Fields: 'MediaSources' });
  return getJson('/Users/' + userId + '/Items/' + itemId + '?' + params.toString()).then(
    function (result) {
      return (result && result.MediaSources) || [];
    },
  );
}

// 1 second = 10,000,000 ticks, real .NET TimeSpan tick length every
// Jellyfin position field (PositionTicks, StartTimeTicks, RunTimeTicks)
// already uses.
export const TICKS_PER_SECOND = 10000000;

// getPlaybackInfo() above sends no real DeviceProfile at all, so its
// own real MediaSourceInfo.SupportsDirectPlay is not a real answer
// about whether this browser specifically can decode the source: with
// nothing telling the server what a bare <video> element here can
// actually play, real Jellyfin negotiation has nothing to evaluate
// compatibility against, confirmed live as still landing on a dead
// player after trusting that same flag first. TranscodingUrl carries
// the same real blind spot, and even a correctly populated one is
// routinely an HLS master playlist (MediaSourceInfo's own
// TranscodingSubProtocol, "hls" far more often than "http" on a real
// negotiation with no profile guiding it toward progressive output),
// which a bare <video> element cannot parse at all outside Safari, no
// different a dead end than the Static bug this already replaced.
// Deciding this client side instead, against the source's own real
// Container and MediaStreams codecs, is the one answer that does not
// depend on any of that: a browser's own real decode support is fixed
// and well known, not something any server side negotiation is needed
// to discover. Not direct playable, the fallback is a real forced
// progressive transcode (VideoCodec=h264&AudioCodec=aac, Static
// omitted so the server actually transcodes rather than serving the
// source's own real bytes as is), so this always stays something a
// bare <video> element can play with no shim of its own. supportsNativeHls()'s
// own header below is the one real exception to "never HLS": a native
// HLS engine is the one target here that already parses an HLS master
// playlist with no shim of its own either.
const DIRECT_PLAY_CONTAINERS = new Set(['mp4', 'webm', 'm4v']);
const DIRECT_PLAY_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);
const DIRECT_PLAY_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

// Real bug found live: the exact same forced transcode fallback below
// (a server side remux/re-encode to a fragmented stream.mp4, no static
// file to just serve as is) played fine in Chrome and failed outright
// in Safari and the official Jellyfin Desktop app on macOS, both
// riding on WebKit/AVPlayer underneath (the Desktop app is a Tauri
// shell, WKWebView on macOS, not Electron/Chromium). AVPlayer's own
// progressive <video src> pipeline wants either a real non-fragmented
// file or a proper HLS manifest, not a live fragmented mp4
// (frag_keyframe+empty_moov+delay_moov, Jellyfin's own real output
// shape for this fallback); Chrome's MSE backed <video> tolerates that
// shape fine, real reason nothing here ever surfaced this before now.
//
// A plain isSafariClient() UA sniff (/Safari/.test(ua) &&
// !/Chrome|Chromium/.test(ua)) was tried here first, real feedback
// live confirmed it fixed Safari itself but not the Desktop app: a
// Tauri shell's own WKWebView is under no obligation to keep "Safari"
// in its own real navigator.userAgent the way a plain WKWebView
// embedded in a first party Apple app defaults to, and evidently does
// not here. Real feature detection instead: video.canPlayType()
// against HLS's own real MIME type is the one direct answer to "can
// this exact engine parse an HLS master playlist with no shim of its
// own" that does not depend on guessing another WebKit wrapper's own
// UA string right the next time one shows up, Chromium (Electron
// included) and Firefox both real "" on it, every WebKit engine
// (Safari, and any WKWebView that has not gone out of its way to
// disable this) real "probably" or "maybe".
//
// HLS itself was ruled out everywhere else on this exact same page's
// own header comment (a bare <video> element cannot parse an HLS
// master playlist at all outside Safari), but that same sentence is
// also exactly why every native-HLS engine is the one real exception:
// its own native <video> already parses HLS with no shim of its own,
// unlike every other browser this runtime targets.
// Exported for screens/player.js's own real seek/resume handling: a
// native HLS engine's own master playlist always spans a title's real
// position 0 onward regardless of anything asked for building it
// (confirmed directly against DynamicHlsController.cs, its own dynamic
// segment endpoint throws outright the instant StartTimeTicks reaches
// it at all), so that screen needs to know ahead of building a stream
// URL whether this same real check below is about to route it there,
// to seek with a real native video.currentTime assignment afterward
// instead of asking this file's own buildStreamUrl for a StartTimeTicks
// it can no longer honour for that one real case.
export function supportsNativeHls() {
  if (typeof document === 'undefined') return false;
  const probe = document.createElement('video');
  if (typeof probe.canPlayType !== 'function') return false;
  const support = probe.canPlayType('application/vnd.apple.mpegurl');
  return support === 'probably' || support === 'maybe';
}

export function canBrowserDirectPlay(mediaSource) {
  if (!mediaSource) return false;
  if (mediaSource.SupportsDirectPlay === false && mediaSource.SupportsDirectStream === false) {
    return false;
  }
  const container = String(mediaSource.Container || '').toLowerCase();
  if (!DIRECT_PLAY_CONTAINERS.has(container)) return false;

  const streams = mediaSource.MediaStreams || [];
  const video = streams.filter(function (stream) {
    return stream.Type === 'Video';
  })[0];
  const audio = streams.filter(function (stream) {
    return stream.Type === 'Audio';
  })[0];
  if (video && !DIRECT_PLAY_VIDEO_CODECS.has(String(video.Codec || '').toLowerCase())) return false;
  if (audio && !DIRECT_PLAY_AUDIO_CODECS.has(String(audio.Codec || '').toLowerCase())) return false;
  return true;
}

// Leaving VideoBitRate unset on the forced transcode fallback above
// let the server fall back to its own real default, reported live as
// every transcoded stream coming back noticeably, incorrectly low
// quality regardless of the source's own real resolution. The
// source's own real per-stream MediaStream.BitRate (or, absent that,
// MediaSourceInfo's own real overall Bitrate) is the one real number
// already describing what this exact title actually needs, a real
// floor under it only for a source with no real bitrate reported at
// all, not a guess replacing a real one that is there.
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

// Every real embedded audio track this source carries, the same
// MediaStreams array components/streamPicker.js's own quality badges
// and getSubtitleStreams above already read, just filtered to the
// other real Type value on it.
export function getAudioStreams(mediaSource) {
  return (mediaSource.MediaStreams || []).filter(function (stream) {
    return stream.Type === 'Audio';
  });
}

// Real feedback: the profile's own saved default audio language
// (screens/settings.js's own Language section, UserDto.Configuration.
// AudioLanguagePreference) only actually reaches a Gelato resolved
// MediaSource if the server's own PlaybackInfo negotiation already
// computed the right DefaultAudioStreamIndex for it, and there is no
// real guarantee a debrid scraped release's own embedded tracks give
// it enough to go on the way a real local file's own indexed
// MediaStreams already would. screens/player.js's own first real
// negotiation checks this directly instead of assuming: languageName()
// normalizes both sides (a stream's own real Language code and a
// saved preference can each land in either the bibliographic or
// terminology ISO 639-2 form, "ger" vs "deu", the same real mismatch
// screens/settings.js's own buildSelect already has to account for)
// rather than a raw code comparison that would silently miss a real
// match half the time.
export function matchAudioStreamIndex(mediaSource, languagePreference) {
  if (!languagePreference) return null;
  const wanted = languageName(languagePreference);
  const streams = getAudioStreams(mediaSource);
  const match = streams.find(function (stream) {
    return stream.Language && languageName(stream.Language) === wanted;
  });
  return match ? match.Index : null;
}

// audioStreamIndex, when given, asks for a specific embedded audio
// track by its own real MediaStreams index instead of whichever one
// Jellyfin defaults to. Static=true serves the whole file's bytes as
// is, every embedded track included, with no way to tell the server
// which one to hand the browser: real Jellyfin behaviour, confirmed
// against jellyfin-web's own playbackmanager.js before writing this,
// is that picking a non default audio track forces a real transcode
// even on an otherwise direct playable file, so a real
// AudioStreamIndex can actually take effect server side.
//
// options.forceTranscode exists for the same real reason a seek needs
// it: StartTimeTicks on a Static=true request is real Jellyfin syntax
// for a local file's own server side seek, but every source this
// runtime ever plays is a live Gelato proxy in front of a debrid or
// usenet host, never a local file (this whole plugin's own header says
// as much), and not every one of those honours an HTTP Range request
// against it. Real feedback found this live: seeking moved the
// reader's own displayed time and then quietly landed back at 0:00.
// A forced transcode's own StartTimeTicks is real ffmpeg -ss instead,
// seeking the source itself before a single byte is ever encoded,
// proven reliable here already (this is exactly what an audio track
// switch, or landing this screen already forced into a transcode by
// canBrowserDirectPlay's own veto, already relies on).
//
// options.playSessionId is the one PlaybackInfo negotiation actually
// hands back (real field on Jellyfin's own PlaybackInfoResponse) and
// real feedback traced an actual server log to prove out: without it
// on the stream URL, Jellyfin's own TranscodingJobHelper has no real
// way to tell a mid-playback audio track switch apart from the exact
// same request arriving twice, and real Jellyfin logs showed exactly
// that live, an audio switch's own new request never spinning up a
// new real ffmpeg process at all, only the old one winding down on its
// own, the switch itself silently never taking effect. Every real
// jellyfin-web session already keeps this same one real id for the
// whole time a title stays open, this runtime's own real session now
// does too.
export function buildStreamUrl(itemId, mediaSource, startTimeTicks, options) {
  const opts = options || {};
  const token = getAccessToken();
  const mediaSourceId = (mediaSource && mediaSource.Id) || itemId;
  // burnInSubtitleStreamIndex forces the same real transcode an
  // AudioStreamIndex switch already does, for the same real reason: an
  // image based subtitle (PGS, VobSub) has no WebVTT form to hand a
  // <track> element, nothing this runtime's own <video> can render on
  // its own, so the only way this runtime can show one at all is
  // asking Jellyfin's own real transcoder to draw it directly into the
  // video, real SubtitleStreamIndex/SubtitleMethod=Encode params
  // confirmed against MediaEncoding/EncodingHelper.cs's own real
  // subtitle burn in path before writing this, not guessed at.
  const forceTranscode =
    !!opts.forceTranscode ||
    opts.burnInSubtitleStreamIndex != null ||
    (opts.audioStreamIndex != null && opts.audioStreamIndex !== mediaSource.DefaultAudioStreamIndex);
  const directPlay = !forceTranscode && canBrowserDirectPlay(mediaSource);
  // Native HLS engines alone (see supportsNativeHls()'s own header)
  // get HLS instead of the fragmented stream.mp4 fallback every other
  // browser still gets below: they already play a real HLS master
  // playlist directly, no MSE shim needed, unlike everywhere else this
  // runtime targets.
  const useHls = !directPlay && supportsNativeHls();
  const container = directPlay ? (mediaSource && mediaSource.Container) || 'mp4' : 'mp4';

  const params = new URLSearchParams({
    MediaSourceId: mediaSourceId,
    DeviceId: getDeviceId(),
    api_key: token || '',
  });
  // Real bug, found live against a real server log: this runtime never
  // builds a segment URL itself, only this one master.m3u8 request,
  // every .ts fetch after that coming straight from Jellyfin's own
  // generated manifest. Real Jellyfin's own DynamicHlsController.
  // GetHlsVideoSegment throws System.ArgumentException("StartTimeTicks
  // is not allowed") outright on that endpoint, and StartTimeTicks on
  // this master request was baking into every segment URI the server
  // itself then wrote into that same manifest, killing playback partway
  // in on every native-HLS client (Safari, the macOS Desktop app's own
  // WKWebView) the instant a forced transcode's own -ss start position
  // was anything other than the default this runtime already asks for
  // over PlaybackInfo's own real negotiation, no separate restatement
  // needed here.
  if (!useHls) {
    params.set('StartTimeTicks', String(startTimeTicks || 0));
  }
  if (opts.playSessionId) {
    params.set('PlaySessionId', opts.playSessionId);
  }
  if (directPlay) {
    params.set('Static', 'true');
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

// Real endpoint, GET /Videos/{itemId}/Trickplay/{width}/{index}.jpg
// (TrickplayController.cs's own GetTrickplayTileImage), confirmed
// against that controller's own real route before writing this: index
// is a tile sheet's own position, not a single thumbnail's, several
// thumbnails packed into one real sheet per BaseItemDto.Trickplay's own
// TrickplayInfoDto (TileWidth/TileHeight thumbnails per sheet).
// screens/player.js's own pickTrickplayTile() below does the real
// thumbnail-index-to-sheet-and-cell math this only ever needs a URL for.
export function getTrickplayTileUrl(itemId, mediaSourceId, width, tileIndex) {
  const params = new URLSearchParams({
    api_key: getAccessToken() || '',
    mediaSourceId: mediaSourceId || itemId,
  });
  return getServerAddress() + '/Videos/' + itemId + '/Trickplay/' + width + '/' + tileIndex + '.jpg?' + params.toString();
}

// A real MediaSource can carry more than one real generated resolution
// (BaseItemDto.Trickplay is width keyed), screens/player.js's own seek
// bar preview wants exactly one to work from: the smallest available,
// same real reasoning Nuvio's own trickplay work already settled on, a
// scrub preview reads at a glance, not full detail, and a small real
// sheet is the cheaper real download on every single hover move.
export function pickTrickplayInfo(item, mediaSourceId) {
  const bySource = item && item.Trickplay && item.Trickplay[mediaSourceId];
  if (!bySource) return null;
  const widths = Object.keys(bySource)
    .map(Number)
    .filter(function (width) {
      return !Number.isNaN(width);
    })
    .sort(function (a, b) {
      return a - b;
    });
  if (!widths.length) return null;
  return Object.assign({ Width: widths[0] }, bySource[widths[0]]);
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

// Server side, admin controlled, applies to every user: Controllers/
// ConfigController.cs's own real GetConfig endpoint, components/
// seasons.js's own real client. Cached the same short lived
// way this file's own getUserViews/getCollections already are: a
// setting an admin just changed in the dashboard is worth a fresh
// fetch within a few minutes, not held stale for a whole session the
// way this runtime's own longer CACHE_TTL_MS would.
export function getJellioConfig() {
  return cached('jellio-config', function () {
    return getJson('/Jellio/config');
  }, SHORT_CACHE_TTL_MS);
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
// plugin's own data directory. Each entry is { Id, Category }: Category
// is null for a loose image sitting directly in the avatars folder, or
// the name of the one real subfolder an admin grouped it under ("Kids",
// "Adults", ...), Id carrying that subfolder's own name as part of the
// path ("Kids/panda.png") so getAvatarPresetUrl below can fetch it back.
export function getAvatarPresets() {
  return getJson('/Jellio/avatars');
}

// id can carry a real "/" (a grouped preset's own subfolder), left as a
// literal path separator rather than encoded whole: AvatarsController's
// own {**id} catch-all route reads real path segments the same way
// FrontendController's own {**path} already does, not a single encoded
// %2F segment. Each real segment is still encoded on its own, in case a
// filename itself carries a character that would otherwise break the URL.
// Token goes on as an api_key query param rather than an Authorization
// header: this URL is handed straight to a plain <img> tag, which never
// sends custom headers, the same reason getStreamUrl/getTrickplayUrl
// already do this for <video>/trickplay requests against the same
// [Authorize]-gated API surface.
export function getAvatarPresetUrl(id) {
  const encodedSegments = String(id).split('/').map(encodeURIComponent).join('/');
  const token = getAccessToken();
  const query = token ? '?api_key=' + encodeURIComponent(token) : '';
  return getServerAddress() + '/Jellio/avatars/' + encodedSegments + query;
}

// Shared real mechanism confirmed against jellyfin-apiclient-javascript's
// own uploadUserImage before writing this: base64 encode whatever real
// image bytes the caller already has (a preset's own fetched blob, or a
// real file the reader picked off their own device), POST to the same
// real POST /Users/{id}/Images/Primary endpoint the stock profile page's
// own file upload already uses, body is the base64 payload itself with
// Content-Type set to the image's real mime type, not JSON. Real
// Jellyfin accepts an animated gif here same as any other real image
// type, nothing this call needs to special case either way.
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

// Setting a chosen preset as a user's own avatar is not Jellio's job:
// fetch that preset's own bytes off Jellio's own AvatarsController and
// hand them to the same real upload path a real device file already
// goes through below.
export async function setUserAvatar(presetId) {
  const imageResponse = await fetch(getAvatarPresetUrl(presetId));
  if (!imageResponse.ok) {
    throw new Error('Could not load preset avatar');
  }
  const blob = await imageResponse.blob();
  return uploadUserAvatarBlob(blob);
}

// A real file the reader picked off their own device (components/
// avatarPicker.js's own upload tile): real Jellyfin already supports
// this natively (an animated gif included) for a user's own avatar,
// this runtime just never had a way to reach it, presets only, until
// real feedback asked directly for one.
export function setUserAvatarFromFile(file) {
  return uploadUserAvatarBlob(file);
}

// Real Jellyfin SyncPlay endpoints (SyncPlayController.cs), the same
// real group create/join/leave/list calls the stock web client's own
// SyncPlay menu already drives. components/groupWatch.js's own real
// modal calls these directly rather than forwarding a click at native
// jellyfin-web's own hidden header button the way this app's sidebar
// used to: real feedback was that native's own menu rendered tiny and
// off in a real corner once its own header was hidden, this app's own
// styled panel instead, same real backend underneath either way.
// Keeping playback itself in lockstep across a group is handled by
// runtime/syncPlay.js, which drives window.ApiClient's own already
// authenticated SyncPlay REST helpers (requestSyncPlayUnpause,
// requestSyncPlaySeek, etc, confirmed against the real
// jellyfin-apiclient-javascript source) and listens for the server's
// pushed SyncPlayCommand/SyncPlayGroupUpdate messages over that same
// client's own WebSocket, rather than this file hand rolling either.
export function getSyncPlayGroups() {
  return getJson('/SyncPlay/List');
}

export function createSyncPlayGroup(groupName) {
  return postJson('/SyncPlay/New', { GroupName: groupName });
}

// Joining/leaving go through runtime/syncPlay.js instead (its own
// window.ApiClient backed joinGroup/leaveGroup): that keeps the one
// real WebSocket connection's own group state in step with whichever
// tab actually issued the join, rather than this file's plain fetch()
// telling the server one thing while syncPlay.js's own listener still
// thinks it is in whatever group it last saw.

// Jellio's own GroupWatchChatController, a small in memory room per real
// SyncPlay GroupId: real SyncPlay carries no chat of its own (confirmed
// against SyncPlayController.cs before this was written), and this
// runtime opens no WebSocket of its own either, see this file's own
// header above for why. afterId lets components/groupWatch.js's own
// poll ask for only what it has not already seen.
export function getGroupWatchMessages(groupId, afterId) {
  const params = new URLSearchParams({ after: String(afterId || 0) });
  return getJson('/Jellio/groupwatch/' + groupId + '/messages?' + params.toString());
}

// itemId is optional: components/groupWatch.js's own plain messages never
// pass one, screens/player.js's own "started watching X" message (right
// alongside the same real toast components/groupWatchInvites.js already
// shows) does, so a reader who was not looking at the exact moment that
// toast appeared still has a real, permanent way to reach it: the chat
// message rendering it below reuses the same real navigateTo('#/play?...')
// that toast's own onClick already does.
export function sendGroupWatchMessage(groupId, text, itemId) {
  return postJson('/Jellio/groupwatch/' + groupId + '/messages', { Text: text, ItemId: itemId || null });
}

// Jellio's own GroupWatchRankingController: a real single elimination
// bracket over the group's own pooled Grouplists, polled the same way
// chat above already is. participantUserIds lets the server pool every
// current member's own Grouplist, not just the caller's; components/
// groupWatchRanking.js's own header explains where those ids actually
// come from, this file has no part in resolving them.
export function getRankingSession(groupId) {
  return getJson('/Jellio/groupwatch/' + groupId + '/ranking');
}

export function startRankingSession(groupId, participantUserIds) {
  return postJson('/Jellio/groupwatch/' + groupId + '/ranking/start', { ParticipantUserIds: participantUserIds });
}

export function voteRankingSession(groupId, itemId) {
  return postJson('/Jellio/groupwatch/' + groupId + '/ranking/vote', { ItemId: itemId });
}

export function cancelRankingSession(groupId) {
  return postJson('/Jellio/groupwatch/' + groupId + '/ranking/cancel');
}

// Jellio's own GroupWatchJoinSyncController: separate from real SyncPlay's
// own Buffering/Ready signal (still sent alongside this, screens/player.js's
// own header explains why), this is only the "who, and why paused" a reader
// forced to sit through someone else's slow stream negotiation can actually
// read, real SyncPlay carrying no reason of its own for a Pause it sends.
export function startJoinSync(groupId, playlistItemId) {
  return postJson('/Jellio/groupwatch/' + groupId + '/join-sync/start', { PlaylistItemId: playlistItemId });
}

export function clearJoinSync(groupId) {
  return postJson('/Jellio/groupwatch/' + groupId + '/join-sync/clear');
}

export function getJoinSync(groupId, playlistItemId) {
  const params = new URLSearchParams({ playlistItemId: playlistItemId });
  return getJson('/Jellio/groupwatch/' + groupId + '/join-sync?' + params.toString());
}

// Jellio's own SubtitlesController: an automatic SubDL fetch for
// whichever of the admin's own configured languages a title is
// missing (Controllers/SubtitlesController.cs's own header explains the
// real trust model, Services/Subtitles/SubtitleCacheStore.cs's own
// header explains why this has to be disk backed, not the ephemeral
// in memory shape most of this file's other Jellio owned endpoints
// already use). ensureSubtitles fires and forgets, real feedback asked
// for this to never add a single millisecond to actual playback start;
// getFetchedSubtitles is a plain poll of whatever has actually landed
// by now, screens/player.js's own header on where it calls this from
// explains why that can be "nothing yet" the first time a title is
// ever opened. buildFetchedSubtitleUrl needs the same real ?ApiKey=
// query string buildSubtitleUrl above already appends: a <track>
// element's own fetch carries no custom header of its own to send a
// real Bearer token on instead.
export function ensureSubtitles(itemId) {
  return postJson('/Jellio/subtitles/' + itemId + '/ensure');
}

export function getFetchedSubtitles(itemId) {
  return getJson('/Jellio/subtitles/' + itemId);
}

export function buildFetchedSubtitleUrl(itemId, language) {
  const token = getAccessToken();
  return (
    getServerAddress() +
    '/Jellio/subtitles/' + itemId + '/' + language + '.vtt' +
    (token ? '?ApiKey=' + encodeURIComponent(token) : '')
  );
}

// Jellio's own GroupWatchInviteController: a small in memory per user
// queue, polled the same way chat above is rather than pushed. Real
// SyncPlay's own WebSocket carries only SessionMessageType's own closed
// enum (confirmed against the real jellyfin/jellyfin source), no room in
// it for an arbitrary "so and so invited you" payload without either
// forking the server or piggybacking on a native command type readers
// would see a second, native styled toast for, so this stays a real
// Jellio owned endpoint instead, same real tradeoff chat already made.
export function getGroupWatchInvites(afterId) {
  const params = new URLSearchParams({ after: String(afterId || 0) });
  return getJson('/Jellio/groupwatch/invites?' + params.toString());
}

export function sendGroupWatchInvite(groupId, groupName, toUserId) {
  return postJson('/Jellio/groupwatch/' + groupId + '/invite', { ToUserId: toUserId, GroupName: groupName });
}

// Jellio's own CalendarController: real per user Watchlist scan server
// side, upcoming episode air dates and movie digital release dates from
// TMDB, keyed off every Gelato imported item's own real
// ProviderIds.Tmdb (confirmed live, no Imdb id ever present even on
// mainstream titles). Empty, not an error, on a server with no TMDB
// token configured yet or a Watchlist with nothing upcoming on it.
export function getCalendarEntries() {
  return getJson('/Jellio/calendar');
}

// Jellio's own NotificationsController: the same real Watchlist scan
// getCalendarEntries above already triggers server side, generating one
// real notification the first day an entry's own release date actually
// arrives. Polled on a real interval by components/notifications.js,
// same real convention components/nowPlaying.js already established for
// its own panel.
export function getNotifications() {
  return getJson('/Jellio/notifications');
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

// Real endpoint, POST /Users/{id}/Configuration (UserController.cs's
// own UpdateUserConfiguration): replaces the whole real
// UserConfiguration object rather than patching one field, so this
// starts from the signed in user's own current one (already sitting on
// the cached user object getCurrentUser above returns) and only
// overwrites the two real fields this screen actually exposes,
// AudioLanguagePreference and SubtitleLanguagePreference. Real ISO
// 639-2 codes Jellyfin's own PlaybackInfo negotiation already reads
// server side to pick a MediaSource's own real
// DefaultAudioStreamIndex/DefaultSubtitleStreamIndex automatically, no
// client side track selection logic needed here for this to take
// effect on the next real negotiated stream.
export async function updateLanguagePreferences(audioLanguage, subtitleLanguage) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const user = await getCurrentUser();
  const configuration = Object.assign({}, user.Configuration, {
    AudioLanguagePreference: audioLanguage || '',
    SubtitleLanguagePreference: subtitleLanguage || '',
  });
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

// Real endpoint, GET /QuickConnect/Enabled (QuickConnectController.cs):
// a server admin can turn the whole real feature off, checked before
// this screen bothers offering a code field nobody could ever actually
// use.
export function isQuickConnectEnabled() {
  return getJson('/QuickConnect/Enabled').catch(function () {
    return false;
  });
}

// Real endpoint, POST /QuickConnect/Authorize?code= (the signed in
// session's own token approving a real pending request another device
// started), returns a real bool for whether the code actually matched
// a pending request, not just whether the call itself succeeded.
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

// Streaming service hub: which catalog collections a server really has,
// the only thing that can be asked. Gelato writes no Studios/network
// field onto an imported item at all (GelatoManager.IntoBaseItem sets
// name, dates, overview, rating, genres, runtime, certification, country
// and provider ids, nothing about where a title streams), confirmed
// against the original Jellio codebase's own streamingHub.js before
// porting this.
// A real Gelato import server side runs one catalog per service per
// kind (movies/series/anime), several services deep: real count seen
// live comfortably clears 100 once genre and per-service catalogs are
// both counted. A single Limit: 100 page, sorted by SortName, silently
// dropped every collection alphabetically past the 100th, no error, no
// empty state, just that service's own catalog never in the array
// groupByService works from at all, real bug behind studio hubs and
// home tiles both missing entire services with nothing wrong on the
// server. Pages through the real total instead, same StartIndex
// pattern getLibraryItems already uses for its own paging.
//
// Real feedback: screens/library.js's own renderAnime() has nothing
// server side to ask for "just the anime catalogs", Jellyfin has no
// such library type, so it has to page through this exact same real
// list first and filter client side, real cost Movies/Shows never pay
// against their own real native library query. The first page here
// used to gate every later one, one full real round trip at a time; a
// server with several hundred real collections paid for that
// sequentially, the single biggest real contributor to Anime reading
// slower than Movies/Shows. Only the first page still has to run
// alone, nothing here yet knows the real total to page against before
// it resolves; every page after that already knows exactly how many
// more real requests are needed, so they all fire together instead of
// one at a time.
function getAllCollections(userId) {
  const pageSize = 100;
  function fetchPage(startIndex) {
    const params = new URLSearchParams({
      IncludeItemTypes: 'BoxSet',
      Recursive: 'true',
      SortBy: 'SortName',
      Limit: String(pageSize),
      StartIndex: String(startIndex),
      // ChildCount is not part of a BoxSet's default field set, and
      // screens/home.js's own catalog rows filter on it (a catalog
      // with fewer than three real items is not worth a row): without
      // asking for it explicitly every collection reads back as 0
      // children and buildCatalogRows drops all of them, silently.
      Fields: 'ProviderIds,ChildCount',
    });
    return getJson('/Users/' + userId + '/Items?' + params.toString());
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

// app.js's own boot-time recheck (see its own header for the real race
// this covers: Gelato's own catalog import, the Anime nav entry's real
// source, still running after the very first getCollections() call
// above already cached whatever existed at that exact moment) calls
// this once to force its retry past both this and getUserViews's own
// cache instead of getting the exact same stale answer back.
export function invalidateNavCaches() {
  const userId = getCurrentUserId();
  if (!userId) return;
  invalidateCache('views:' + userId);
  invalidateCache('collections:' + userId);
}

// Gelato's own GetOrCreateBoxSetAsync writes a collection's ProviderIds.Stremio
// as "{catalogType}.{catalogId}", catalogType being the literal type string
// configured on that catalog in AIOStreams: "movie", "series", or "anime".
// A real signal straight from Gelato, not a guess off a name a reader can
// rename freely: prefer it, and only fall back to matching the collection's
// own name for anything imported before Gelato wrote this (or created by
// hand) and so carries no Stremio provider id at all.
export function isAnimeCollection(collection) {
  const ids = collection.ProviderIds || {};
  const stremio = ids.Stremio || ids.stremio;
  if (stremio) return String(stremio).split('.')[0].toLowerCase() === 'anime';
  return /anime|anilist|kitsu/i.test(collection.Name || '');
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
  const path = '/Users/' + userId + '/Items?' + params.toString();
  return cached(path, function () {
    return getJson(path);
  }).then(function (result) {
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

// Every real subtitle stream, text and image based (PGS, VobSub) both:
// screens/player.js's own subtitle menu decides what to do with each
// one from its own real IsTextSubtitleStream field (confirmed against
// MediaStream.cs before writing this, only checked, never guessed at
// from Codec alone), a text stream getting the plain WebVTT <track>
// below, an image one needing a real burned in transcode instead,
// nothing this runtime's own <video> element can render on its own.
export function getSubtitleStreams(mediaSource) {
  return (mediaSource.MediaStreams || []).filter(function (stream) {
    return stream.Type === 'Subtitle';
  });
}

// Real endpoint confirmed against SubtitleController.cs's own registered
// route before writing this: GET /Videos/{itemId}/{mediaSourceId}/
// Subtitles/{streamIndex}/Stream.vtt converts any text subtitle format to
// WebVTT server side, so requesting .vtt always works for a text stream
// regardless of its real source codec.
//
// Used to trust stream.DeliveryUrl instead, whenever a stream's own
// DeliveryMethod already read 'External', jellyfin-web's own real
// playbackmanager.js convention. Real bug, found live: that field is
// itself computed server side from whatever DeviceProfile.SubtitleProfiles
// a client's own PlaybackInfo request declared (Jellyfin.Api's own
// MediaInfoHelper.cs, SetDeviceSpecificSubtitleInfo), and
// getPlaybackInfo() above sends no real DeviceProfile at all, the same
// real blind spot its own header already documents for direct play
// detection. With nothing telling the server this client can only ever
// render WebVTT, an externally delivered real SubRip file came back
// with a DeliveryUrl pointing at its own original .srt, not the
// conversion endpoint, silently failing the one real place a native
// <track> element has no error of its own to surface: a WebVTT parser
// fed a comma-decimal SubRip timestamp just finds no real cues in it,
// no console error, nothing visibly broken to trace back to this.
// selectSubtitle's own real caller (components/player.js's own subtitle
// menu) only ever reaches this function for a stream.IsTextSubtitleStream
// one to begin with, an image based track routed to
// selectBurnedInSubtitle entirely instead, so there is no real case left
// here DeliveryUrl was ever the only way to reach a working subtitle.
export function buildSubtitleUrl(itemId, mediaSourceId, stream) {
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

// Real endpoint, GET /Jellio/online-users (Controllers/OnlineUsersController.cs),
// the same ISessionManager.Sessions above reads, unfiltered by
// NowPlayingItem: every user id with a real session on the server right
// now, components/accountSwitcher.js's own online dot.
export function getOnlineUserIds() {
  return getJson('/Jellio/online-users');
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
// Cached the same way views/collections/the current user are: SortBy
// Random means an uncached second call inside the same TTL window
// returns a different set, which would defeat app.js's own splash
// preload (its whole point is warming the exact images the home
// screen's real heroCarousel.js call renders a moment later, not a
// different random eight). A minute of "random" staying put is not
// something a reader can notice on their own.
export function getHeroCandidates(limit, options) {
  const userId = getCurrentUserId();
  if (!userId) return Promise.reject(new Error('Not signed in'));
  const opts = options || {};
  const itemTypes = opts.itemTypes || 'Movie,Series';
  const key = 'hero:' + userId + ':' + (opts.parentId || '') + ':' + itemTypes + ':' + (limit || 8);
  return cached(key, function () {
    const params = new URLSearchParams({
      SortBy: 'Random',
      Recursive: 'true',
      IncludeItemTypes: itemTypes,
      Limit: String(limit || 8),
      Fields: 'Overview,Genres,ProductionYear,RunTimeTicks,OfficialRating',
    });
    if (opts.parentId) params.set('ParentId', opts.parentId);
    return getJson('/Users/' + userId + '/Items?' + params.toString()).then(function (result) {
      return (result && result.Items) || [];
    });
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
  const path = '/Users/' + userId + '/Items?' + params.toString();
  return cached(path, function () {
    return getJson(path);
  })
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
  const path = '/Users/' + userId + '/Items?' + params.toString();
  return cached(path, function () {
    return getJson(path);
  }).then(function (result) {
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
// Backed by Controllers/ProfileController.cs's own per user JSON file.
// Self only, no {userId} variant: a reader views someone else's own
// privacy state indirectly, through whether getAchievementsForUser
// below comes back with IsPrivate true, never through this endpoint.
export function getProfileSettings() {
  return getJson('/Jellio/profile/settings');
}

export function setProfilePrivacy(isPrivate) {
  return postJson('/Jellio/profile/privacy', { IsPrivate: isPrivate });
}

// Off by default, gates screens/home.js's own Grouplist tab, the
// watchlist button's own list picker popover, and Group Watch chat's
// own ranking session trigger alike, one flag for all three.
export function setGrouplistEnabled(enabled) {
  return postJson('/Jellio/profile/grouplist-enabled', { GrouplistEnabled: enabled });
}

// Own achievement badges, self only. Real Steam-style behaviour lives
// server side in AchievementsController.cs, not here: a private profile
// still answers this one with real stats, only getAchievementsForUser
// below goes dark for it.
export function getMyAchievements() {
  return getJson('/Jellio/achievements');
}

// Any user's own badges, the profile page's own real source: comes
// back as { IsPrivate: true } with nothing else when that user has
// Privacy turned on and the reader is not them, same real shape either
// branch on the server returns so this file does not need to guess
// which one it got beyond checking that one field.
export function getAchievementsForUser(userId) {
  return getJson('/Jellio/achievements/' + userId);
}

// Group Watch state (is this reader in a group right now, how many
// others are actually in it) only ever lives client side, this
// runtime's own real SyncPlay WebSocket state, the same real reason
// getGroupWatchInvites's own header already gives for that whole
// endpoint existing outside real SyncPlay's own wire protocol in the
// first place. components/groupWatch.js and screens/player.js call
// these directly at the two real moments each one actually happens
// (a group's own creation, a grouped session's own real completion)
// rather than AchievementService trying to infer either server side.
export function creditGroupWatchStarted() {
  return postJson('/Jellio/achievements/group-watch/started');
}

export function creditGroupWatchTogether() {
  return postJson('/Jellio/achievements/group-watch/together');
}

// Bio (like the profile picture and banner) always visible: only
// getAchievementsForUser above goes dark for a private profile.
export function getProfileForUser(userId) {
  return getJson('/Jellio/profile/' + userId);
}

// Real GET /Users/{userId} (UserController.cs), [Authorize(Policy =
// IgnoreParentalControl)] rather than an admin only policy, confirmed
// against real Jellyfin source before writing this: any signed in
// reader can look another real user's own name and avatar tag up by
// id, unlike GET /Users/{id}/Items below, which is why the profile
// page's own activity feed rides AchievementService's own persisted
// RecentActivity instead of asking for another user's own watch
// history directly.
export function getUserById(userId) {
  return getJson('/Users/' + userId);
}

export function setProfileBio(bio) {
  return postJson('/Jellio/profile/bio', { Bio: bio });
}

// Real bug, live-reported: ProfileBannerController.cs's GET is
// [Authorize]-gated same as every other endpoint here, but this URL is
// handed straight to a plain <img> tag (screens/profile.js), which never
// sends an Authorization header, so every real load 401'd. Token goes on
// as an api_key query param instead, same real fix getAvatarPresetUrl
// above already carries for the identical reason.
export function getBannerUrl(userId) {
  const token = getAccessToken();
  const query = token ? '?api_key=' + encodeURIComponent(token) : '';
  return getServerAddress() + '/Jellio/profile/banner/' + userId + query;
}

// Real feedback, live: "scrolling is painfully slow" on the profile
// page traced back to this endpoint, real ProfileBannerController.cs's
// own header explains why a byte cap is the fix rather than a real
// resize: an already oversized file caught here, before a real base64
// encode and upload round trip get spent on it, not just server side.
const MAX_BANNER_BYTES = 8 * 1024 * 1024;

// Same real base64-body-with-Content-Type convention
// uploadUserAvatarBlob already uses against real Jellyfin's own
// PostUserImage, ProfileBannerController.cs's own header explains why
// its endpoint matches it on purpose.
export async function setProfileBannerFromFile(file) {
  if (file.size > MAX_BANNER_BYTES) {
    throw new Error('Image too large. Please use a banner under 8 MB.');
  }

  const contentType = file.type || 'image/png';
  const base64 = await new Promise(function (resolve, reject) {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = function () {
      resolve(String(reader.result).split(',')[1]);
    };
    reader.readAsDataURL(file);
  });

  const response = await fetch(getServerAddress() + '/Jellio/profile/banner', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': contentType }, getAuthHeaders()),
    body: base64,
  });
  if (!response.ok) {
    const raw = await response.text().catch(function () {
      return '';
    });
    // ProfileBannerController.cs's own BadRequest(string) calls (real
    // Jellyfin/ASP.NET convention, confirmed by requestJson()'s own
    // identical JSON.parse(text) above for a plain success body) come
    // back as a JSON encoded string, quotes and all, not raw text.
    let message = raw;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'string') message = parsed;
    } catch (err) {
      // Not JSON: raw already is the real message to show.
    }
    throw new Error(message || 'Could not set banner');
  }
}

export function removeProfileBanner() {
  return fetch(getServerAddress() + '/Jellio/profile/banner', {
    method: 'DELETE',
    headers: getAuthHeaders(),
  }).then(function (response) {
    if (!response.ok) throw new Error('Could not remove banner');
  });
}

// Server wide feed, Controllers/FeedController.cs's own real merge of
// every non-private user's own RecentActivity. A private user's own
// entries never come back here at all, server side, not filtered out
// after the fact client side.
export function getActivityFeed() {
  return getJson('/Jellio/feed');
}

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
  const path = '/Users/' + userId + '/Items?' + params.toString();
  return cached(path, function () {
    return getJson(path);
  }).then(function (result) {
    return (result && result.Items) || [];
  });
}
