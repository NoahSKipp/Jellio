// First real screen, proof of the whole architecture end to end: its own
// markup, fed entirely by runtime/api.js's own fetch calls, no native DOM
// read or waited on.
import {
  getCurrentUser,
  getResumeItems,
  getNextUp,
  getWatchlistItems,
  getGrouplistItems,
  getCollections,
  collectionKind,
  getCollectionItems,
  discoverGenres,
  getGenreItems,
  isAnimeCollection,
  getCalendarEntries,
  getImageUrl,
} from '../runtime/api.js';
import { buildRecommendationRows, titleKey } from '../runtime/recommend.js';
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
const MAX_ANIME_CATALOG_ROWS = 1;
const GENRE_ROWS = 4;
const GENRE_ROW_LIMIT = 24;
// components/rowListModal.js's own "browse everything": real full
// depth for whichever row a reader actually opened, not the same
// CATALOG_ROW_LIMIT/GENRE_ROW_LIMIT-capped array the row itself
// already rendered from.
const ROW_LIST_LIMIT = 500;

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
// buildHomeSections() below can run every row source's own real
// network fetch together, catalog, genre and recommendation alike,
// and only sequence the synchronous dedupe step afterward, in the
// priority order real feedback actually cares about.
async function fetchCatalogRows(collections) {
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

  usable = usable.slice(0, MAX_CATALOG_ROWS);

  const results = await Promise.allSettled(
    usable.map(function (collection) {
      return getCollectionItems(collection.Id, collectionKind(collection), CATALOG_ROW_LIMIT);
    }),
  );

  return results
    .map(function (result, index) {
      if (result.status !== 'fulfilled') return null;
      const collection = usable[index];
      return {
        id: collection.Id,
        kind: collectionKind(collection),
        title: titleFor(collection.Name, collectionKind(collection)),
        items: result.value,
      };
    })
    .filter(Boolean);
}

function buildCatalogRows(catalogData, seen) {
  const sections = [];
  catalogData.forEach(function (entry) {
    const row = buildRow(entry.title, dedupe(entry.items, seen), null, function () {
      return getCollectionItems(entry.id, entry.kind, ROW_LIST_LIMIT);
    });
    if (row) sections.push(wrapRowForCustomization(row, 'catalog:' + entry.id));
  });
  return sections;
}

async function fetchGenreRows() {
  try {
    const genres = await discoverGenres(null, 'Movie,Series', GENRE_ROWS);
    const results = await Promise.allSettled(
      genres.map(function (genre) {
        return getGenreItems(null, 'Movie,Series', genre, GENRE_ROW_LIMIT);
      }),
    );
    return results
      .map(function (result, index) {
        if (result.status !== 'fulfilled') return null;
        return { title: genres[index], items: result.value };
      })
      .filter(Boolean);
  } catch (err) {
    console.warn('Jellio: could not load home genre rows', err);
    return [];
  }
}

function buildGenreRows(genreData, seen) {
  const sections = [];
  genreData.forEach(function (entry) {
    const row = buildRow(entry.title, dedupe(entry.items, seen), null, function () {
      return getGenreItems(null, 'Movie,Series', entry.title, ROW_LIST_LIMIT);
    });
    if (row) sections.push(wrapRowForCustomization(row, 'genre:' + entry.title));
  });
  return sections;
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
  section.appendChild(el('h2', 'jellio-row-title', 'Studio Hubs'));
  const tiles = el('div', 'jellio-hub-tiles');
  names.forEach(function (name) {
    tiles.appendChild(buildHubTile(name));
  });
  section.appendChild(tiles);
  return section;
}

const COMING_SOON_LIMIT = 12;

// Real feedback (the same audit that found rows missing a Movies row
// past the first 100 collections): nothing on this whole page ever
// looked forward, every row here is either what already exists in a
// real catalog or what this reader already watched. screens/calendar.js's
// own full page covers the same real Watchlist-driven data in depth;
// this is the same real CalendarController answer, a handful of cards
// wide, the same "here's what to look forward to" glance Nuvio/Netflix
// both put right on their own home page rather than behind a second
// real screen only.
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
    return entry.Detail ? entry.Detail : 'New episode';
  }
  return 'Digital release';
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
    entries = await getCalendarEntries();
  } catch (err) {
    console.warn('Jellio: could not load Coming Soon', err);
    return null;
  }
  if (!entries.length) return null;

  const section = el('section', 'jellio-row');
  section.appendChild(el('h2', 'jellio-row-title', 'Coming Soon'));
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
    header.appendChild(el('h1', 'jellio-home-greeting', 'Watchlist'));
    return header;
  }

  const toggle = el('div', 'jellio-lists-toggle');
  const watchlistTab = el('button', 'jellio-lists-toggle-tab', 'Watchlist');
  watchlistTab.type = 'button';
  watchlistTab.classList.toggle('jellio-lists-toggle-tab-active', activeList !== 'group');
  watchlistTab.addEventListener('click', function () {
    navigateTo('#/home?tab=1');
  });
  const grouplistTab = el('button', 'jellio-lists-toggle-tab', 'Grouplist');
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

  try {
    const items = await (isGroup ? getGrouplistItems() : getWatchlistItems());
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
let homeSectionsPromise = null;

// Reset on leaving playback (screens/player.js's own cleanup calls
// this) rather than left to rot for the rest of the session: Up
// Next and Continue Watching are exactly the two rows a real playback
// session changes, so the next visit to home has to re-derive them,
// not keep serving what was true before that session started.
export function invalidateHomeSections() {
  homeSectionsPromise = null;
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

async function buildHomeSections() {
  const sections = [];

  function pushAll(newSections) {
    newSections.forEach(function (section) {
      sections.push(section);
    });
    if (newSections.length) notifySections(newSections);
  }

  const [nextUpResult, resumeResult, collectionsResult, comingSoonRow] = await Promise.allSettled([
    getNextUp(20),
    getResumeItems(20),
    getCollections(),
    buildComingSoonRow(),
  ]);

  // Continue Watching, then Up Next, then the recommendation rows,
  // real feedback's own updated order: a title actually left mid
  // playback is the more immediate real pickup than one only queued up
  // next, ahead of anything the catalog itself has to say either way.
  if (resumeResult.status === 'fulfilled') {
    const row = buildRow('Continue Watching', resumeResult.value, { continueWatching: true });
    if (row) pushAll([wrapRowForCustomization(row, 'continue-watching')]);
  }

  if (nextUpResult.status === 'fulfilled') {
    const row = buildRow('Up Next', nextUpResult.value, { upNext: true });
    if (row) pushAll([wrapRowForCustomization(row, 'up-next')]);
  }

  if (comingSoonRow.status === 'fulfilled' && comingSoonRow.value) {
    pushAll([wrapRowForCustomization(comingSoonRow.value, 'coming-soon')]);
  }

  const collections = collectionsResult.status === 'fulfilled' ? collectionsResult.value : null;
  if (collections) {
    const hub = buildHubStrip(collections);
    if (hub) pushAll([wrapRowForCustomization(hub, 'studio-hubs')]);
  }

  // Shared with buildCatalogRows/buildGenreRows below via dedupe(): a
  // title a recommendation row already picked should not also turn up
  // in a catalog or genre row further down the same page, and a title
  // a catalog row picked should not also turn up in a genre row. Only
  // that final dedupe actually needs this priority order though; none
  // of these three phases' own real network fetches depend on the
  // other two at all, so all three fire together here instead of
  // genre rows waiting on catalog rows waiting on recommendation rows
  // to even start asking the network for anything.
  const seen = {};

  const [recommendationRows, catalogData, genreData] = await Promise.all([
    buildRecommendationRows(seen).catch(function (err) {
      console.warn('Jellio: could not load recommendation rows', err);
      return [];
    }),
    collections
      ? fetchCatalogRows(collections).catch(function (err) {
          console.warn('Jellio: could not load catalog rows', err);
          return [];
        })
      : Promise.resolve([]),
    fetchGenreRows(),
  ]);

  pushAll(
    recommendationRows
      .map(function (spec) {
        const row = buildRow(spec.title, spec.items);
        return row ? wrapRowForCustomization(row, 'rec:' + spec.title) : null;
      })
      .filter(Boolean),
  );
  pushAll(buildCatalogRows(catalogData, seen));
  pushAll(buildGenreRows(genreData, seen));

  return sections;
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
  if (!homeSectionsPromise) {
    homeSectionsPromise = buildHomeSections().catch(function (err) {
      console.warn('Jellio: could not build home sections', err);
      homeSectionsPromise = null;
      return [];
    });
  }
  return homeSectionsPromise;
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
  sectionListeners.push(onSection);
  const promise = preloadHomeSections();
  promise.finally(function () {
    sectionListeners = sectionListeners.filter(function (listener) {
      return listener !== onSection;
    });
  });
  return promise;
}

// Real feedback: "Welcome back" regardless of what time it actually is
// read as a placeholder that never got filled in. Local browser clock,
// not the server's own: a real greeting is about the reader's own real
// time of day, not wherever the Jellyfin server itself happens to run.
// 0-4 gets its own real late night text rather than folding into
// "evening", the one bucket real feedback specifically called out.
function greetingFor(hour) {
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 17) return 'Good afternoon';
  if (hour >= 17 && hour < 22) return 'Good evening';
  return 'Still up';
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
  const greetingEl = el('h1', 'jellio-home-greeting', greeting + (greeting === 'Still up' ? '?' : ''));
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

  // Nuvio's own real shimmer skeleton (components/homeSkeleton.js's
  // own buildHomeSkeleton(), matching that same real reference before
  // writing this) stands in for these rows the instant this screen
  // starts building them, removed the moment the first real one
  // actually lands. Only ever visible at all on the same cache miss
  // preloadHomeSectionsWithProgress()'s own real progress callback
  // below already only fires on: the common already-preloaded path
  // never sees it, since sections has usually already arrived by the
  // time this reaches removeChild().
  const skeleton = buildHomeSkeleton();
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
  preloadHomeSectionsWithProgress(function (section) {
    removeSkeleton();
    rows.appendChild(section);
    applyHomeCustomization(rows, editMode);
  }).then(function (sections) {
    removeSkeleton();
    sections.forEach(function (section) {
      rows.appendChild(section);
    });
    applyHomeCustomization(rows, editMode);
  });

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
  let userDataRefreshTimer = null;
  function refreshContinueWatchingRow() {
    const existing = rows.querySelector('[data-jellio-row-key="continue-watching"]');
    if (!existing) return;
    getResumeItems(20)
      .then(function (items) {
        const row = buildRow('Continue Watching', items, { continueWatching: true });
        if (!row) {
          existing.remove();
          return;
        }
        existing.replaceWith(wrapRowForCustomization(row, 'continue-watching'));
        applyHomeCustomization(rows, editMode);
      })
      .catch(function () {});
  }
  const unsubscribeUserData = onUserDataChange(function () {
    invalidateHomeSections();
    window.clearTimeout(userDataRefreshTimer);
    userDataRefreshTimer = window.setTimeout(refreshContinueWatchingRow, 500);
  });

  return function cleanup() {
    window.clearTimeout(userDataRefreshTimer);
    unsubscribeUserData();
    hero.destroy();
  };
}
