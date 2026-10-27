import { t, translateGenre } from '../runtime/i18n.js';
// First real screen, proof of the whole architecture end to end: its own
// markup, fed entirely by runtime/api.js's own fetch calls, no native DOM
// read or waited on.
import { withoutStaleEpisodes } from '../runtime/continueWatching.js';
import { createRowGate } from '../runtime/rowGate.js';
import {
  getCurrentUser,
  getResumeItems,
  getContinueReading,
  getContinueListening,
  getNextUp,
  getWatchlistItems,
  getGrouplistItems,
  getCollections,
  collectionKind,
  getCollectionItems,
  discoverGenres,
  getGenreItems,
  getGenreItemsPage,
  isAnimeCollection,
  getCalendarEntries,
  getImageUrl,
  getAnimeIds,
  withoutAnime,
  isHomeRowCacheEnabled,
  markHomeRowPainted,
  getCommunityWatching,
  invalidateCommunityWatchingCache,
} from '../runtime/api.js';
import {
  isCommunityRowEnabled,
  getCommunityExcludedUsers,
  getSelectedGenres,
} from '../runtime/recommendationSettings.js';
import { streamRecommendationRows, titleKey } from '../runtime/recommend.js';
import { buildCard } from '../components/card.js';
import { appendCardsLazily } from '../components/lazyGrid.js';
import { buildRow } from '../components/row.js';
import { attachScrollArrows } from '../components/scrollArrows.js';
import { groupByService, logoUrl, serviceOf } from '../components/services.js';
import { buildHeroCarousel } from '../components/heroCarousel.js';
import { buildHomeSkeleton } from '../components/homeSkeleton.js';
import {
  wrapRowForCustomization,
  applyHomeCustomization,
  buildHomeCustomizeBar,
  updateHomeCustomizeBar,
  resetHomeCustomization,
} from '../components/homeCustomizer.js';
import { navigateTo } from '../runtime/router.js';
import { isGrouplistEnabled } from '../runtime/grouplistSettings.js';
import { onUserDataChange } from '../runtime/syncPlay.js';
import { el } from '../runtime/dom.js';

// Real Gelato catalog collections (Trending, Popular, Top Rated, a
// service's own row, ...) plus genres counted from a sample, ported
// from the original codebase's own homeRows.js: native's home stops at
// Continue Watching and one Recently added row per library, which on a
// Gelato server says nothing (DateCreated is the import instant, the
// same for every title in a batch), so this puts the rows that
// actually mean something (what's trending, what's popular, real
// genres) on the front page instead. Nothing here invents a row out of
// a sort order and calls it Trending.
const CATALOG_ROW_LIMIT = 24;
const MAX_CATALOG_ROWS = 8;
const MIN_CATALOG_ITEMS = 3;
// The anime library has a page of its own carrying every AniList
// catalog (screens/library.js's own renderAnime). One of them here is
// a taste of it, more than one is that page again in the wrong place.
// Anime stays in the Anime library (Controllers/AnimeController.cs), so
// none of its catalogs get a row here.
const MAX_ANIME_CATALOG_ROWS = 0;
const GENRE_ROWS = 4;
const GENRE_ROW_LIMIT = 24;
// components/rowListModal.js's own "browse everything": real full
// depth for whichever row a reader actually opened, not the same
// CATALOG_ROW_LIMIT/GENRE_ROW_LIMIT-capped array the row itself
// already rendered from.

// Catalogs worth leading with, in this order. Anything unlisted keeps
// its own alphabetical order behind them.
const LEAD = ['trending', 'popular', 'top rated', 'new releases'];
const GENERIC_NAME = /^(trending|popular|top rated)$/i;

function leadIndex(name) {
  const index = LEAD.indexOf(String(name || '').toLowerCase());
  return index === -1 ? LEAD.length : index;
}

// Shared with runtime/recommend.js's own exclude object (same shape,
// same titleKey), so a title a "Because you watched" row already
// picked does not also turn up in a catalog or genre row further down
// the same page. Catalog and genre rows only ever add to it, never
// read it back the way pick() reads and writes in the same pass, so
// there is no ordering constraint here the way there is between
// recommendation rows.
function dedupe(items, seen) {
  const kept = [];
  items.forEach(function (item) {
    if (seen[item.Id] || seen[titleKey(item)]) return;
    seen[item.Id] = true;
    seen[titleKey(item)] = true;
    kept.push(item);
  });
  return kept;
}

// "Trending" alone on a page that can carry a movie one and a series
// one of the same name says nothing about which is which, real
// feedback the original codebase's own titleFor() already answered:
// only these three generic names get a kind suffix, everything else
// already has a real name (a catalog's own configured title).
function titleFor(name, kind) {
  if (!GENERIC_NAME.test(name)) return name;
  if (kind === 'tvshows') return name + ' Series';
  if (kind === 'movies') return name + ' Movies';
  return name;
}

// Split into a fetch phase (no dependency on seen/exclude at all) and
// a build phase (the dedupe() call that reads and writes it) so
// buildExpensiveSections() below can run every row source's own real
// network fetch together, catalog, genre and recommendation alike,
// and only sequence the synchronous dedupe step afterward, in the
// priority order real feedback actually cares about.
function chooseCatalogs(collections) {
  let usable = collections.filter(function (collection) {
    // A service catalog already has a tile in the hub strip and a page
    // behind it (buildHubStrip below, screens/service.js), so a
    // Netflix row directly under the Netflix tile would be the same
    // content twice.
    if (serviceOf(collection.Name)) return false;
    return (collection.ChildCount || 0) >= MIN_CATALOG_ITEMS;
  });

  usable.sort(function (a, b) {
    const diff = leadIndex(a.Name) - leadIndex(b.Name);
    if (diff) return diff;
    return (b.ChildCount || 0) - (a.ChildCount || 0);
  });

  let animeSeen = 0;
  usable = usable.filter(function (collection) {
    if (!isAnimeCollection(collection)) return true;
    animeSeen++;
    return animeSeen <= MAX_ANIME_CATALOG_ROWS;
  });

  return usable.slice(0, MAX_CATALOG_ROWS);
}

function buildCatalogRow(entry, seen) {
  const row = buildRow(entry.title, dedupe(entry.items, seen), null, {
    fetchPage: function (start, size) {
      return Promise.all([getCollectionItems(entry.id, entry.kind, size, start), getAnimeIds()]).then(function (results) {
        return withoutAnime(results[0], results[1]);
      });
    },
  });
  return row ? wrapRowForCustomization(row, 'catalog:' + entry.id) : null;
}

// The genres for the home rows: the reader's own pick, else the last
// discovered set kept in this browser (refreshed quietly behind it), else
// discovered now. A cold tab doesn't have to work them out again.
const HOME_GENRES_KEY = 'jellioHomeGenres';
const HOME_GENRES_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function storedHomeGenres() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(HOME_GENRES_KEY) || 'null');
    if (stored && Array.isArray(stored.genres) && stored.genres.length && Date.now() - stored.at < HOME_GENRES_MAX_AGE_MS) {
      return stored.genres;
    }
  } catch (err) {
    // Unreadable or blocked storage: discover them instead.
  }
  return null;
}

function chooseHomeGenres() {
  const selected = getSelectedGenres();
  if (Array.isArray(selected) && selected.length > 0) return Promise.resolve(selected);
  const discovered = discoverGenres(null, 'Movie,Series', GENRE_ROWS).then(function (genres) {
    if (genres.length) {
      try {
        window.localStorage.setItem(HOME_GENRES_KEY, JSON.stringify({ at: Date.now(), genres: genres }));
      } catch (err) {
        // Not kept; discovered again next time.
      }
    }
    return genres;
  });
  const stored = storedHomeGenres();
  if (stored) {
    discovered.catch(function () {});
    return Promise.resolve(stored);
  }
  return discovered;
}

function buildGenreRow(entry, seen) {
  const row = buildRow(translateGenre(entry.title), dedupe(entry.items, seen), null, {
    fetchPage: function (start, size) {
      return Promise.all([getGenreItemsPage(null, 'Movie,Series', entry.title, start, size), getAnimeIds()]).then(function (results) {
        return withoutAnime(results[0], results[1]);
      });
    },
  });
  return row ? wrapRowForCustomization(row, 'genre:' + entry.title) : null;
}

// The logo is requested optimistically and the name sits behind it in
// CSS: onerror is the only way to know a file does not exist, and a
// service with no icon shows its name immediately rather than an empty
// tile flashing first. Same technique the original codebase's own
// streamingHub.js uses.
function buildHubTile(name) {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'jellio-hub-tile';
  tile.title = name;

  const label = document.createElement('span');
  label.className = 'jellio-hub-tile-name';
  label.textContent = name;
  tile.appendChild(label);

  const logo = document.createElement('img');
  logo.className = 'jellio-hub-tile-logo';
  logo.alt = name;
  logo.loading = 'lazy';
  logo.src = logoUrl(name);
  logo.addEventListener('load', function () {
    tile.classList.add('jellio-has-logo');
  });
  logo.addEventListener('error', function () {
    logo.remove();
  });
  tile.appendChild(logo);

  tile.addEventListener('click', function () {
    navigateTo('#/service?name=' + encodeURIComponent(name));
  });
  return tile;
}

function buildHubStrip(collections) {
  const groups = groupByService(collections);
  const names = Object.keys(groups).sort();
  if (!names.length) return null;

  const section = el('section', 'jellio-hub');
  section.appendChild(el('h2', 'jellio-row-title', t('home_studio_hubs')));
  // Real feedback live: this strip had no visible way to reach a tile
  // scrolled past the edge on a smaller monitor except a mouse drag or
  // a trackpad swipe, the exact real gap components/scrollArrows.js's
  // own header already solved once for every other row on this screen
  // (components/row.js's own buildRow(), screens/detail.js's own
  // season tabs/episode track). jellio-hub-tiles itself used to be both
  // the real wrap and the real scrolling track in one element;
  // attachScrollArrows() needs them split (its own header explains
  // why, a real position: relative anchor point for the absolutely
  // positioned arrows themselves), so a plain wrap div takes over
  // jellio-hub-tiles' own real position: relative job and this row's
  // own scrolling/padding stays on the track underneath it, unchanged.
  const tilesWrap = el('div', 'jellio-row-track-wrap');
  const tiles = el('div', 'jellio-hub-tiles');
  names.forEach(function (name) {
    tiles.appendChild(buildHubTile(name));
  });
  tilesWrap.appendChild(tiles);
  section.appendChild(tilesWrap);
  attachScrollArrows(tilesWrap, tiles);
  return section;
}

// Everything the Calendar screen used to list lives in this row now.
const COMING_SOON_LIMIT = 60;

// What's coming for the reader's Watchlist (new episodes and digital
// releases), from CalendarController. This row replaced the Calendar screen.
//
// A dedicated card here rather than components/card.js's own buildCard:
// that real card assumes a real playable item (progress bar, watchlist/
// watched actions, a play affordance on click), every one of them wrong
// for a title that has not actually released yet. CalendarController's
// own real response already carries everything this needs (Id, Name,
// Kind, Detail) with no second per-item fetch to fill a real BaseItemDto's
// worth of fields this never needed anyway.
function comingSoonKindLabel(entry) {
  if (entry.Kind === 'episode') {
    return entry.Detail ? t('calendar_new_episode') + ' · ' + entry.Detail : t('calendar_new_episode');
  }
  return t('calendar_digital_release');
}

function comingSoonDateLabel(entry) {
  const date = new Date(entry.Date);
  const diffDays = Math.round((date - new Date()) / (24 * 60 * 60 * 1000));
  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays < 7) return 'In ' + diffDays + ' days';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function buildComingSoonCard(entry) {
  const card = document.createElement('div');
  card.className = 'jellio-card jellio-coming-soon-card';
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', entry.Name);
  card.addEventListener('click', function () {
    navigateTo('#/item?id=' + entry.ItemId);
  });
  card.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      navigateTo('#/item?id=' + entry.ItemId);
    }
  });

  const imageWrap = el('div', 'jellio-card-image-wrap');
  const img = document.createElement('img');
  img.className = 'jellio-card-image';
  img.src = getImageUrl(entry.ItemId, 'Primary', { maxWidth: 400, quality: 85 });
  img.alt = '';
  img.loading = 'lazy';
  imageWrap.appendChild(img);
  imageWrap.appendChild(el('div', 'jellio-coming-soon-date', comingSoonDateLabel(entry)));
  card.appendChild(imageWrap);

  card.appendChild(el('div', 'jellio-card-title', entry.Name));
  card.appendChild(el('div', 'jellio-card-subtitle', comingSoonKindLabel(entry)));

  return card;
}

async function buildComingSoonRow() {
  let entries = [];
  try {
    const [all, animeIds] = await Promise.all([getCalendarEntries(), getAnimeIds()]);
    entries = (all || []).filter(function (entry) {
      return !animeIds.has(String(entry.ItemId || '').replace(/-/g, '').toLowerCase());
    });
  } catch (err) {
    console.warn('Jellio: could not load Coming Soon', err);
    return null;
  }
  if (!entries.length) return null;

  const section = el('section', 'jellio-row');
  section.appendChild(el('h2', 'jellio-row-title', t('home_coming_soon')));
  const trackWrap = el('div', 'jellio-row-track-wrap');
  const track = el('div', 'jellio-row-track');
  entries.slice(0, COMING_SOON_LIMIT).forEach(function (entry) {
    track.appendChild(buildComingSoonCard(entry));
  });
  trackWrap.appendChild(track);
  section.appendChild(trackWrap);
  attachScrollArrows(trackWrap, track);
  return section;
}

// #/home?tab=1, the same hash the sidebar's own Watchlist link and the
// original Jellio codebase's own NAV_LINKS both already point at, rather
// than a separate #/watchlist route.
// Real feedback: one flat grid mixed movies and series together with
// nothing telling the two apart at a glance, on a real watchlist with
// enough of both a real title could sit anywhere in it. Split into its
// own section per real kind instead, movies first (the same lead order
// this app's own sidebar library links already use), each section
// skipped outright rather than rendered empty when this reader's own
// watchlist simply has none of that kind on it.
function buildWatchlistSection(title, items) {
  if (!items.length) return null;
  const section = el('section', 'jellio-row');
  section.appendChild(el('h2', 'jellio-row-title', title));
  const grid = el('div', 'jellio-library-grid');
  section.appendChild(grid);
  appendCardsLazily(grid, items, buildCard);
  return section;
}

// components/navShared.js's own Watchlist link still points at the
// exact same #/home?tab=1 route it always has; a &list=group query
// param on top of that (this header's own Grouplist tab sets it) is
// the only thing that picks Grouplist instead, so an old link or a
// bookmark with no list param at all still lands on Watchlist exactly
// as before. The toggle itself only ever renders once runtime/
// grouplistSettings.js's own isGrouplistEnabled() is on; off, this
// reads exactly as it always has, a plain "Watchlist" title, real
// feedback's own explicit ask for a reader who never turns it on to
// see nothing different at all.
function buildListsHeader(activeList) {
  const header = el('header', 'jellio-home-header');
  if (!isGrouplistEnabled()) {
    header.appendChild(el('h1', 'jellio-home-greeting', t('home_watchlist')));
    return header;
  }

  const toggle = el('div', 'jellio-lists-toggle');
  const watchlistTab = el('button', 'jellio-lists-toggle-tab', t('home_watchlist'));
  watchlistTab.type = 'button';
  watchlistTab.classList.toggle('jellio-lists-toggle-tab-active', activeList !== 'group');
  watchlistTab.addEventListener('click', function () {
    navigateTo('#/home?tab=1');
  });
  const grouplistTab = el('button', 'jellio-lists-toggle-tab', t('settings_grouplist_label'));
  grouplistTab.type = 'button';
  grouplistTab.classList.toggle('jellio-lists-toggle-tab-active', activeList === 'group');
  grouplistTab.addEventListener('click', function () {
    navigateTo('#/home?tab=1&list=group');
  });
  toggle.appendChild(watchlistTab);
  toggle.appendChild(grouplistTab);
  header.appendChild(toggle);
  return header;
}

async function renderWatchlist(root, activeList) {
  root.appendChild(buildListsHeader(activeList));

  const isGroup = activeList === 'group' && isGrouplistEnabled();
  const emptyMessage = isGroup ? 'Nothing on your Grouplist yet.' : 'Nothing on your watchlist yet.';

  const skeleton = buildHomeSkeleton(3);
  root.appendChild(skeleton);

  try {
    const items = await (isGroup ? getGrouplistItems() : getWatchlistItems());
    skeleton.remove();
    const movies = items.filter(function (item) {
      return item.Type === 'Movie';
    });
    const series = items.filter(function (item) {
      return item.Type === 'Series';
    });

    const movieSection = buildWatchlistSection('Movies', movies);
    if (movieSection) root.appendChild(movieSection);
    const seriesSection = buildWatchlistSection('Series', series);
    if (seriesSection) root.appendChild(seriesSection);

    if (!movieSection && !seriesSection) {
      root.appendChild(el('p', 'jellio-service-empty', emptyMessage));
    }
  } catch (err) {
    skeleton.remove();
    console.warn('Jellio: could not load ' + (isGroup ? 'grouplist' : 'watchlist'), err);
  }
}

// Every row this screen needs, real DOM elements (buildRow's own
// output) rather than plain data: an <img> already has its own src set
// the instant it exists, loading regardless of whether it is actually
// attached to the document yet, so building these while the splash is
// still up (app.js's own preloadHomeSections() call) means the browser
// is already fetching every thumbnail this screen needs before the
// reader ever sees the page, not after. Memoized so the real render
// below reuses these same elements instead of building (and
// re-fetching) a second set: real feedback was that rows kept loading
// in slowly one at a time after the splash had already stepped aside,
// traced to this screen firing every one of these calls fresh on its
// own right as it rendered, on top of whatever the splash had already
// asked for separately.
// Two separate caches, not one: real feedback was that every row,
// "Top Picks"/catalog/genre rows included, took as long to reload as a
// genuinely cold first visit, every single time a playback session
// ended, since invalidateHomeSections() below used to null one combined
// promise covering all of it. Only Continue Watching and Up Next
// actually change when a playback session ends; the recommendation,
// catalog and genre rows below them depend on none of that (Gelato's
// own addon resolution, not a reader's own watch progress), so they get
// their own cache here that survives invalidateHomeSections() and only
// ever gets rebuilt on a genuine cold load (a fresh page load, or this
// promise's own catch() clearing itself after a real failure).
let cheapSectionsPromise = null;
let expensiveSectionsPromise = null;
// Every section each build has produced so far, in the order produced,
// so a home screen mounting mid-build (or after it) gets them straight
// away instead of only once the slowest row has finished.
let cheapBuilt = [];
let expensiveBuilt = [];

// Where each section sits on the page: personal rows first in their own
// order, then recommendation/catalog/genre rows in theirs, whichever
// order their requests happen to finish in.
const EXPENSIVE_ORDER_BASE = 1000;

// Reset on leaving playback (screens/player.js's own cleanup calls
// this) rather than left to rot for the rest of the session: Up
// Next and Continue Watching are exactly the two rows a real playback
// session changes, so the next visit to home has to re-derive them,
// not keep serving what was true before that session started. Deliberately
// leaves expensiveSectionsPromise alone, see its own header above.
export function invalidateHomeSections() {
  cheapSectionsPromise = null;
  cheapBuilt = [];
}

export function invalidateAllHomeSections() {
  invalidateHomeSections();
  invalidateCommunityWatchingCache();
  expensiveSectionsPromise = null;
  expensiveBuilt = [];
}

// runtime/api.js's row cache refreshed an answer that differs from what
// is showing (or dropped rows after something was watched): rebuild the
// rows concerned, once per burst. Rows keyed the same replace the old
// ones, so unchanged rows don't flicker out.
const PERSONAL_ROW_CLASSES = ['personal', 'user', 'latest', 'watchlist'];
const rowCacheRefreshers = new Set();
let rowCacheRefreshTimer = null;
let rowCacheRefreshAll = false;

if (typeof document !== 'undefined') {
  document.addEventListener('jellio:rowcache-change', function (event) {
    const detail = (event && event.detail) || {};
    const classes = detail.classes || [];
    if (
      detail.type === 'wipe' ||
      classes.some(function (cls) {
        return PERSONAL_ROW_CLASSES.indexOf(cls) === -1;
      })
    ) {
      rowCacheRefreshAll = true;
    }
    window.clearTimeout(rowCacheRefreshTimer);
    rowCacheRefreshTimer = window.setTimeout(function () {
      const all = rowCacheRefreshAll;
      rowCacheRefreshAll = false;
      if (all) invalidateAllHomeSections();
      else invalidateHomeSections();
      rowCacheRefreshers.forEach(function (refresh) {
        refresh(all);
      });
    }, 400);
  });
}

// Nuvio's own real incremental-channel pattern (search's per-addon fan
// out, StreamsRepository's own stream aggregation, both confirmed
// against real source): a reader never waits on the slowest phase to
// see the fastest one. Up Next/Continue Watching are one fast real
// Jellyfin call each; the catalog and genre rows behind them depend on
// Gelato resolving whatever addon backs each collection, real work
// that can take real time on a slow connection. Subscribers attached
// while buildHomeSections() below is still running get each phase's
// own real sections the moment that phase resolves, not after the
// whole chain does; the ordering itself stays exactly what it always
// was (recommendation rows get first pick of `seen`, then catalog
// rows, then genre rows, each phase still genuinely depends on the
// last for that dedupe, not something safe to run in parallel).
let sectionListeners = [];

function notifySections(newSections) {
  sectionListeners.forEach(function (listener) {
    try {
      newSections.forEach(listener);
    } catch (err) {
      console.warn('Jellio: home section listener failed', err);
    }
  });
}

function settle(promise) {
  return promise.then(
    function (value) {
      return { status: 'fulfilled', value: value };
    },
    function (reason) {
      return { status: 'rejected', reason: reason };
    },
  );
}

async function buildCheapSections() {
  const built = [];
  cheapBuilt = built;

  const ORDER = {
    'continue-watching': 0,
    'continue-reading': 1,
    'continue-listening': 2,
    'up-next': 3,
    'coming-soon': 4,
    'studio-hubs': 5,
  };

  function push(section, key) {
    if (!section) return;
    section.dataset.jellioHomeOrder = String(ORDER[key] !== undefined ? ORDER[key] : built.length);
    built.push(section);
    notifySections([section]);
  }

  // Every request starts now, together, and renders to its predetermined slot
  // the exact millisecond it arrives: Up Next and Continue Watching never wait
  // on slower book scans or Coming Soon calendar lookups.
  // Next Up starts with the resume list; Continue Watching waits for it to
  // drop episodes the show has already moved past.
  const nextUpResult = settle(getNextUp(20));
  const resume = Promise.all([settle(getResumeItems(20)), nextUpResult]).then(function (results) {
    const result = results[0];
    if (result.status === 'fulfilled') {
      const nextUpItems = results[1].status === 'fulfilled' ? results[1].value : [];
      const items = withoutStaleEpisodes(result.value, nextUpItems);
      const row = buildRow(t('home_continue_watching'), items, { continueWatching: true });
      if (row) push(wrapRowForCustomization(row, 'continue-watching'), 'continue-watching');
    }
  });

  const reading = settle(getContinueReading(20)).then(function (result) {
    if (result.status === 'fulfilled') {
      const row = buildRow(t('home_continue_reading'), result.value, { openReader: true });
      if (row) push(wrapRowForCustomization(row, 'continue-reading'), 'continue-reading');
    }
  });

  const listening = settle(getContinueListening(20)).then(function (result) {
    if (result.status === 'fulfilled') {
      const row = buildRow(t('home_continue_listening'), result.value, { openReader: true });
      if (row) push(wrapRowForCustomization(row, 'continue-listening'), 'continue-listening');
    }
  });

  const nextUp = nextUpResult.then(function (result) {
    if (result.status === 'fulfilled') {
      const row = buildRow(t('home_next_up'), result.value, { upNext: true });
      if (row) push(wrapRowForCustomization(row, 'up-next'), 'up-next');
    }
  });

  const comingSoon = settle(buildComingSoonRow()).then(function (result) {
    if (result.status === 'fulfilled' && result.value) {
      push(wrapRowForCustomization(result.value, 'coming-soon'), 'coming-soon');
    }
  });

  let collections = null;
  const collectionsJob = settle(getCollections()).then(function (result) {
    collections = result.status === 'fulfilled' ? result.value : null;
    if (collections) {
      const hub = buildHubStrip(collections);
      if (hub) push(wrapRowForCustomization(hub, 'studio-hubs'), 'studio-hubs');
    }
  });

  await Promise.all([resume, reading, listening, nextUp, comingSoon, collectionsJob]);

  built.sort(function (a, b) {
    return Number(a.dataset.jellioHomeOrder || 0) - Number(b.dataset.jellioHomeOrder || 0);
  });

  return { sections: built.slice(), collections: collections };
}

// Split out of what used to be one combined buildHomeSections(): the
// expensive half (recommendation/catalog/genre rows), cached separately
// via expensiveSectionsPromise above so a playback session ending only
// ever forces buildCheapSections() above to run again, not this.
// Every row below the personal ones goes on screen the moment its own
// data arrives. Each kind has a fixed range of order keys (recommendations,
// with What Others Are Watching after Top Picks and the seasonal row but
// ahead of the "Because you..." rows, then catalogs, then genres), so a row that
// lands late still slots into its place. A title already shown in a row
// that went up earlier isn't repeated further down.
const EXPENSIVE_SLOTS = { recommendations: 0, community: 15, catalogs: 200, genres: 300 };

async function buildExpensiveSections() {
  const built = [];
  expensiveBuilt = built;
  const seen = {};
  const animeIdsPromise = getAnimeIds();
  const rowGate = createRowGate(2);

  function place(section, slot) {
    if (!section) return;
    section.dataset.jellioHomeOrder = String(EXPENSIVE_ORDER_BASE + slot);
    built.push(section);
    notifySections([section]);
  }

  // Never awaited: a slow community lookup can't hold the other rows up.
  if (isCommunityRowEnabled()) {
    Promise.all([getCommunityWatching(getCommunityExcludedUsers()), animeIdsPromise])
      .then(function (results) {
        // Not deduped against the other rows: it lands after them and would
        // usually come out empty, and the watchers make it a different row.
        const valid = dedupe(withoutAnime(results[0] || [], results[1]), {});
        if (!valid.length) return;
        const row = buildRow(t('home_community_watching'), valid);
        if (row) place(wrapRowForCustomization(row, 'rec:What Others Are Watching'), EXPENSIVE_SLOTS.community);
      })
      .catch(function (err) {
        console.warn('Jellio: could not load community watching row', err);
      });
  }

  // Each recommendation row goes up as soon as its own data arrives.
  const recommendations = animeIdsPromise
    .then(function (animeIds) {
      return streamRecommendationRows(seen, function (spec, slot) {
        const row = buildRow(spec.title, withoutAnime(spec.items, animeIds));
        if (row) place(wrapRowForCustomization(row, 'rec:' + spec.title), EXPENSIVE_SLOTS.recommendations + slot);
      });
    })
    .catch(function (err) {
      console.warn('Jellio: could not load recommendation rows', err);
    })
    .finally(function () {
      rowGate.open();
    });

  const catalogs = getCollections()
    .then(function (collections) {
      return Promise.all(
        chooseCatalogs(collections).map(function (collection, index) {
          const kind = collectionKind(collection);
          const slot = EXPENSIVE_SLOTS.catalogs + index;
          return Promise.all([rowGate(slot, () => getCollectionItems(collection.Id, kind, CATALOG_ROW_LIMIT)), animeIdsPromise])
            .then(function (results) {
              const entry = { id: collection.Id, kind: kind, title: titleFor(collection.Name, kind), items: withoutAnime(results[0], results[1]) };
              place(buildCatalogRow(entry, seen), slot);
            })
            .catch(function () {});
        }),
      );
    })
    .catch(function (err) {
      console.warn('Jellio: could not load catalog rows', err);
    });

  const genres = chooseHomeGenres()
    .then(function (list) {
      return Promise.all(
        list.map(function (genre, index) {
          const slot = EXPENSIVE_SLOTS.genres + index;
          return Promise.all([rowGate(slot, () => getGenreItems(null, 'Movie,Series', genre, GENRE_ROW_LIMIT)), animeIdsPromise])
            .then(function (results) {
              place(buildGenreRow({ title: genre, items: withoutAnime(results[0], results[1]) }, seen), slot);
            })
            .catch(function () {});
        }),
      );
    })
    .catch(function (err) {
      console.warn('Jellio: could not load home genre rows', err);
    });

  await Promise.all([recommendations, catalogs, genres]);
  // The live list: a community row that turns up later is in it too.
  return built;
}

// app.js's own preloadInitialData() calls this directly while the
// splash is still up; renderHome() below calls it again and gets the
// same in-flight or already-resolved promise back, never a second
// fetch. Real bug caught here: a rejected promise is exactly as
// memoizable as a resolved one, so one real failure (a flaky request
// buildHomeSections() above did not itself guard) used to cache that
// same rejection forever, and every future call, this one included,
// re-threw it straight out of renderHome() with nothing there to catch
// it either, which app.js's own runSync() then read as the whole
// screen render failing and fell all the way back to native for the
// rest of the session. Catching here means this promise itself can
// never reject, and clearing the cache on that same path means the
// very next visit to home gets a real, fresh attempt instead of the
// same dead promise served forever.
export function preloadHomeSections() {
  // Personal rows' requests start first so they are first in line for
  // runtime/api.js's request slots; the slower rows start right after
  // rather than waiting on them to finish.
  if (!cheapSectionsPromise) {
    cheapSectionsPromise = buildCheapSections().catch(function (err) {
      console.warn('Jellio: could not build home sections', err);
      cheapSectionsPromise = null;
      return { sections: [], collections: null };
    });
    // Pre-warm the community watching cache in the background so it is ready when the reader scrolls down
    if (isCommunityRowEnabled()) {
      getCommunityWatching(getCommunityExcludedUsers()).catch(function () {});
    }
  }
  // With the row cache on, the rows below the fold (recommendation,
  // catalog and genre rows) wait until the screen scrolls near them:
  // renderHome's sentinel calls preloadExpensiveHomeSections().
  if (isHomeRowCacheEnabled()) {
    return cheapSectionsPromise.then(function (result) {
      return result.sections.concat(expensiveBuilt);
    });
  }
  startExpensiveSections();
  return Promise.all([cheapSectionsPromise, expensiveSectionsPromise]).then(function (results) {
    return results[0].sections.concat(results[1]);
  });
}

function startExpensiveSections() {
  if (!expensiveSectionsPromise) {
    expensiveSectionsPromise = buildExpensiveSections().catch(function (err) {
      console.warn('Jellio: could not build home sections', err);
      expensiveSectionsPromise = null;
      return [];
    });
  }
  return expensiveSectionsPromise;
}

export function preloadExpensiveHomeSections() {
  return startExpensiveSections().then(function (expensive) {
    return cheapBuilt.concat(expensive);
  });
}

// renderHome's own real progressive-render path: subscribes onSection
// to whichever phases of the shared build above still resolve after
// this call (nothing, on the common path where app.js's own splash
// preload already finished the whole thing before this screen ever
// mounted; the real remaining phases, on the first-ever visit or right
// after invalidateHomeSections() reset the cache following a playback
// session). Sections a phase already delivered before this subscribed
// never reach onSection, so renderHome still has to reconcile the
// final full array itself for those, the same way notifySections()
// above already only reaches listeners actually attached when it fires.
export function preloadHomeSectionsWithProgress(onSection) {
  const promise = preloadHomeSections();
  // Whatever is already built goes to the screen now; the rest arrives
  // through the listener as it is built.
  // The listener stays until the screen unsubscribes, so rows from a
  // rebuild started while it is showing (see renderHome's user data
  // refresh) reach it too.
  cheapBuilt.concat(expensiveBuilt).forEach(onSection);
  sectionListeners.push(onSection);
  return {
    promise: promise,
    unsubscribe: function () {
      sectionListeners = sectionListeners.filter(function (listener) {
        return listener !== onSection;
      });
    },
  };
}

// Real feedback: "Welcome back" regardless of what time it actually is
// read as a placeholder that never got filled in. Local browser clock,
// not the server's own: a real greeting is about the reader's own real
// time of day, not wherever the Jellyfin server itself happens to run.
// 0-4 gets its own real late night text rather than folding into
// "evening", the one bucket real feedback specifically called out.
function greetingFor(hour) {
  if (hour >= 5 && hour < 12) return t('home_greeting_morning');
  if (hour >= 12 && hour < 17) return t('home_greeting_afternoon');
  if (hour >= 17 && hour < 22) return t('home_greeting_evening');
  return t('home_greeting_night');
}

export async function renderHome(root, params) {
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-home';

  if (params && params.get('tab') === '1') {
    await renderWatchlist(root, params.get('list'));
    return undefined;
  }

  const hero = buildHeroCarousel();
  root.appendChild(hero.element);

  const header = el('header', 'jellio-home-header');
  // "Still up" reads as a statement next to a plain name; real feedback
  // wanted the late night bucket specifically to read as the direct
  // address it actually is, a question rather than a flat greeting.
  const greeting = greetingFor(new Date().getHours());
  const greetingEl = el('h1', 'jellio-home-greeting', greeting);
  header.appendChild(greetingEl);
  // Real feedback: this whole screen, skeleton included, used to sit
  // behind this one real getCurrentUser() call before painting
  // anything at all, just to know a name neither the skeleton nor the
  // rows below it actually need. Patched in once it resolves instead,
  // same real cache hit this almost always already is (60s TTL,
  // preloadInitialData()'s own tracked task list keeps it warm) but no
  // longer the one thing every real cold cache had to sit through
  // first regardless.
  getCurrentUser()
    .then(function (user) {
      const name = user && user.Name;
      if (!name) return;
      greetingEl.textContent = greeting + ', ' + name + (greeting === 'Still up' ? '?' : '');
    })
    .catch(function () {});

  // Harbor-style row editor (components/homeCustomizer.js's own header
  // explains the real reasoning): editMode lives only in this real
  // closure, reset to off on every fresh visit to this screen the same
  // way Harbor's own real editMode local state already resets on every
  // real remount, not something worth persisting across navigations.
  let editMode = false;
  const customizeBar = buildHomeCustomizeBar(
    function onToggleEdit() {
      editMode = !editMode;
      updateHomeCustomizeBar(customizeBar, editMode);
      applyHomeCustomization(rows, editMode);
    },
    function onReset() {
      resetHomeCustomization();
      applyHomeCustomization(rows, editMode);
    },
  );
  updateHomeCustomizeBar(customizeBar, editMode);
  header.appendChild(customizeBar.bar);
  root.appendChild(header);

  const rows = el('div', 'jellio-rows');
  root.appendChild(rows);

  // Shimmer skeleton (components/homeSkeleton.js's own buildHomeSkeleton())
  // stands in for rows while this screen loads them. Rather than removing the
  // entire skeleton the instant the first row lands (which left an empty void
  // below while expensive catalog/genre/recommendation rows were still fetching),
  // skeleton rows stay at the bottom of the container and are reduced
  // progressively, finally removed once all sections have settled.
  const skeleton = buildHomeSkeleton(4);
  rows.appendChild(skeleton);
  let skeletonRemoved = false;
  function removeSkeleton() {
    if (skeletonRemoved) return;
    skeletonRemoved = true;
    if (skeleton.parentNode) skeleton.parentNode.removeChild(skeleton);
  }

  // Not awaited: app.js's own sync() queue only starts the next real
  // navigation once this function's own returned promise resolves, so
  // awaiting the full section chain here (even with every section
  // already rendering progressively through the callback below) still
  // meant a reader could not leave a slow-loading home screen for
  // anywhere else until every last catalog/genre row had either
  // resolved or timed out. rows and skeleton are this call's own local
  // elements, not the shared root, so a late section arriving after
  // the reader has already navigated elsewhere just appends into an
  // orphaned, invisible subtree, same reasoning screens/library.js's
  // own fire-and-forget genre rows document.
  // Real bug this exact shape caused: app.js's own preloadInitialData()
  // now fires preloadHomeRows() in the background before this screen
  // ever mounts (see that file's own header), so on a real cold load
  // Up Next/Continue Watching/the hub strip, pushed first and fastest,
  // routinely finish and notify before the listener below even
  // subscribes, missing the live path entirely; catalog/genre rows,
  // slower and pushed later, do reach it live. Appending only the
  // "missed" sections after the live ones, the old shape here, left
  // Up Next and Continue Watching stranded after every row that had
  // arrived live instead of first where they belong. appendChild on a
  // node already in the document moves it rather than duplicating it,
  // so replaying every section from the final, authoritative array
  // once the whole chain settles puts everything back in its real
  // order regardless of which ones streamed in live and which did not,
  // same one line doing both jobs.
  // Rows are shared DOM nodes cached across visits: once this screen has
  // been left, a late-arriving row must not be pulled back into its
  // detached container and away from the home screen now showing.
  let active = true;
  function placeSection(section) {
    if (!active) return;
    // A rebuilt row replaces the one already showing under the same key,
    // keeping how far the reader had scrolled it.
    const key = section.dataset.jellioRowKey;
    let scrolled = null;
    if (key) {
      const current = rows.querySelector('[data-jellio-row-key="' + CSS.escape(key) + '"]');
      if (current && current !== section) {
        scrolled = Array.from(current.querySelectorAll('.jellio-row-track')).map(function (track) {
          return track.scrollLeft;
        });
        current.remove();
      }
    }
    const order = Number(section.dataset.jellioHomeOrder || 0);
    const after = Array.from(rows.children).find(function (child) {
      return child !== section && child !== skeleton && Number(child.dataset.jellioHomeOrder || 0) > order;
    });
    const insertTarget = after || (skeleton.parentNode === rows ? skeleton : null);
    // Moving a row already in place would reset its scroll position.
    if (section.parentNode !== rows || section.nextSibling !== insertTarget) {
      rows.insertBefore(section, insertTarget);
    }
    if (scrolled && scrolled.some(Boolean)) {
      section.querySelectorAll('.jellio-row-track').forEach(function (track, i) {
        if (scrolled[i]) track.scrollLeft = scrolled[i];
      });
    }
    markHomeRowPainted();
    applyHomeCustomization(rows, editMode);

    // As real rows arrive, reduce placeholder rows but keep at least 2
    // while sections are still loading, so the reader sees shimmering
    // skeletons indicating more rows below rather than a blank void.
    if (!skeletonRemoved && skeleton.parentNode === rows) {
      const placeholders = skeleton.querySelectorAll('.jellio-home-skeleton-row');
      if (placeholders.length > 2) {
        placeholders[placeholders.length - 1].remove();
      }
    }
  }
  // Once a build settles, the current rows are authoritative: re-place
  // them in order, and drop personal rows a rebuild no longer produced
  // (a Continue Watching row whose last show was just finished).
  function settleRows(settledSections) {
    if (!active) return;
    // Lazy rows still to come below: their placeholders stay until then.
    if (!lazyRows || lazyRowsDone) removeSkeleton();
    const current = Array.isArray(settledSections) && settledSections.length
      ? settledSections
      : cheapBuilt.concat(expensiveBuilt);
    current.forEach(placeSection);
    Array.from(rows.children).forEach(function (child) {
      if (child === skeleton) return;
      const order = Number(child.dataset.jellioHomeOrder);
      if (order < EXPENSIVE_ORDER_BASE) {
        const inCurrent = current.some(function (sec) {
          return sec === child || (sec.dataset && child.dataset && sec.dataset.jellioRowKey && sec.dataset.jellioRowKey === child.dataset.jellioRowKey);
        });
        if (!inCurrent) child.remove();
      }
    });
  }
  // Row cache on: recommendation, catalog and genre rows load once the
  // screen gets near them, not all at once on mount.
  const lazyRows = isHomeRowCacheEnabled();
  let lazyRowsRequested = false;
  let lazyRowsDone = false;
  function requestLazyRows() {
    if (lazyRowsRequested || !active) return;
    lazyRowsRequested = true;
    preloadExpensiveHomeSections()
      .then(function (sections) {
        lazyRowsDone = true;
        settleRows(sections);
      })
      .catch(function () {
        lazyRowsDone = true;
        removeSkeleton();
      });
  }
  let lazyObserver = null;
  let lazyTimer = null;
  if (lazyRows) {
    const sentinel = el('div', 'jellio-home-lazy-sentinel');
    root.appendChild(sentinel);
    if (typeof IntersectionObserver === 'function') {
      lazyObserver = new IntersectionObserver(
        function (entries) {
          const visible = entries.some(function (entry) {
            return entry.isIntersecting;
          });
          window.clearTimeout(lazyTimer);
          // A pass straight through while the page settles doesn't count.
          if (visible) lazyTimer = window.setTimeout(requestLazyRows, 150);
        },
        { rootMargin: '0px 0px 800px 0px' },
      );
      lazyObserver.observe(sentinel);
    } else {
      lazyTimer = window.setTimeout(requestLazyRows, 1500);
    }
  }

  const subscription = preloadHomeSectionsWithProgress(placeSection);
  subscription.promise.then(settleRows).catch(function (err) {
    console.warn('Jellio: home sections promise failed', err);
    removeSkeleton();
  });

  function refreshFromRowCache(all) {
    if (!active) return;
    preloadHomeSections().then(settleRows);
    if (all && lazyRowsRequested) preloadExpensiveHomeSections().then(settleRows);
  }
  rowCacheRefreshers.add(refreshFromRowCache);

  // invalidateHomeSections() above already re-derives Continue Watching
  // fresh on the NEXT visit to this screen; this covers the one real
  // case that misses, this screen already mounted and visible while a
  // change happens somewhere else (runtime/syncPlay.js's own
  // onUserDataChange header explains where from: another open tab,
  // another device, real Jellyfin's own broadcast to every one of this
  // reader's own sessions on the same already open socket, no polling
  // added for it). Only ever updates a row already on screen, never
  // inserts a fresh one that was not there at mount: the customizer's
  // own saved order/hidden state (components/homeCustomizer.js) has
  // nothing to say yet about a row it never saw, real ordering surprises
  // not worth risking here, the next real visit already covers that
  // case through the cache bust above.
  // Watch/read state changed somewhere (this or another device, or the
  // playback that just ended): rebuild the personal rows. The rebuild's
  // rows arrive through the same listener and replace the current ones
  // by key; debounced because one playback stop can fire several events.
  let userDataRefreshTimer = null;
  const unsubscribeUserData = onUserDataChange(function () {
    window.clearTimeout(userDataRefreshTimer);
    userDataRefreshTimer = window.setTimeout(function () {
      if (!active) return;
      invalidateHomeSections();
      preloadHomeSections().then(settleRows);
    }, 600);
  });

  return function cleanup() {
    active = false;
    rowCacheRefreshers.delete(refreshFromRowCache);
    if (lazyObserver) lazyObserver.disconnect();
    window.clearTimeout(lazyTimer);
    removeSkeleton();
    subscription.unsubscribe();
    window.clearTimeout(userDataRefreshTimer);
    unsubscribeUserData();
    hero.destroy();
  };
}
