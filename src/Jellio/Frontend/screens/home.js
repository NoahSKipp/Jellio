// First real screen, proof of the whole architecture end to end: its own
// markup, fed entirely by runtime/api.js's own fetch calls, no native DOM
// read or waited on.
import {
  getCurrentUser,
  getResumeItems,
  getNextUp,
  getWatchlistItems,
  getCollections,
  collectionKind,
  getCollectionItems,
  discoverGenres,
  getGenreItems,
} from '../runtime/api.js';
import { buildRecommendationRows, titleKey } from '../runtime/recommend.js';
import { buildCard } from '../components/card.js';
import { buildRow } from '../components/row.js';
import { groupByService, logoSlug, serviceOf } from '../components/services.js';
import { buildHeroCarousel } from '../components/heroCarousel.js';
import { buildHomeSkeleton } from '../components/homeSkeleton.js';
import { navigateTo } from '../runtime/router.js';

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

async function buildCatalogRows(collections, seen) {
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
    if (!/anime|anilist/i.test(collection.Name || '')) return true;
    animeSeen++;
    return animeSeen <= MAX_ANIME_CATALOG_ROWS;
  });

  usable = usable.slice(0, MAX_CATALOG_ROWS);

  const results = await Promise.allSettled(
    usable.map(function (collection) {
      return getCollectionItems(collection.Id, collectionKind(collection), CATALOG_ROW_LIMIT);
    }),
  );

  const sections = [];
  results.forEach(function (result, index) {
    if (result.status !== 'fulfilled') return;
    const collection = usable[index];
    const row = buildRow(titleFor(collection.Name, collectionKind(collection)), dedupe(result.value, seen));
    if (row) sections.push(row);
  });
  return sections;
}

async function buildGenreRows(seen) {
  try {
    const genres = await discoverGenres(null, 'Movie,Series', GENRE_ROWS);
    const results = await Promise.allSettled(
      genres.map(function (genre) {
        return getGenreItems(null, 'Movie,Series', genre, GENRE_ROW_LIMIT);
      }),
    );
    const sections = [];
    results.forEach(function (result, index) {
      if (result.status !== 'fulfilled') return;
      const row = buildRow(genres[index], dedupe(result.value, seen));
      if (row) sections.push(row);
    });
    return sections;
  } catch (err) {
    console.warn('Jellio: could not load home genre rows', err);
    return [];
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
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
  logo.src = '/Jellio/frontend/img/services/' + logoSlug(name) + '.svg';
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
  section.appendChild(el('h2', 'jellio-row-title', 'Your streaming'));
  const tiles = el('div', 'jellio-hub-tiles');
  names.forEach(function (name) {
    tiles.appendChild(buildHubTile(name));
  });
  section.appendChild(tiles);
  return section;
}

// #/home?tab=1, the same hash the sidebar's own Watchlist link and the
// original Jellio codebase's own NAV_LINKS both already point at, rather
// than a separate #/watchlist route.
async function renderWatchlist(root) {
  const header = el('header', 'jellio-home-header');
  header.appendChild(el('h1', 'jellio-home-greeting', 'Watchlist'));
  root.appendChild(header);

  const grid = el('div', 'jellio-library-grid');
  root.appendChild(grid);

  try {
    const items = await getWatchlistItems();
    items.forEach(function (item) {
      grid.appendChild(buildCard(item));
    });
  } catch (err) {
    console.warn('Jellio: could not load watchlist', err);
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

  const [nextUpResult, resumeResult, collectionsResult] = await Promise.allSettled([
    getNextUp(20),
    getResumeItems(20),
    getCollections(),
  ]);

  // Up Next, then Continue Watching, then the recommendation rows,
  // real feedback asked for this exact order: the reader's own actual
  // watch state first (what a show is up to, what was left mid
  // playback), then what it suggests, ahead of anything the catalog
  // itself has to say.
  if (nextUpResult.status === 'fulfilled') {
    const row = buildRow('Up Next', nextUpResult.value, { upNext: true });
    if (row) pushAll([row]);
  }

  if (resumeResult.status === 'fulfilled') {
    const row = buildRow('Continue Watching', resumeResult.value, { continueWatching: true });
    if (row) pushAll([row]);
  }

  // Shared with buildCatalogRows/buildGenreRows below via dedupe():
  // a title a recommendation row already picked should not also turn
  // up in a catalog or genre row further down the same page.
  const seen = {};

  try {
    const recommendationRows = await buildRecommendationRows(seen);
    const rows = recommendationRows.map(function (spec) {
      return buildRow(spec.title, spec.items);
    }).filter(Boolean);
    pushAll(rows);
  } catch (err) {
    console.warn('Jellio: could not load recommendation rows', err);
  }

  if (collectionsResult.status === 'fulfilled') {
    const collections = collectionsResult.value;
    const hub = buildHubStrip(collections);
    if (hub) pushAll([hub]);

    try {
      const catalogRows = await buildCatalogRows(collections, seen);
      pushAll(catalogRows);
    } catch (err) {
      console.warn('Jellio: could not load catalog rows', err);
    }
  }

  const genreRows = await buildGenreRows(seen);
  pushAll(genreRows);

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

export async function renderHome(root, params) {
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-home';

  if (params && params.get('tab') === '1') {
    await renderWatchlist(root);
    return undefined;
  }

  const hero = buildHeroCarousel();
  root.appendChild(hero.element);

  const header = el('header', 'jellio-home-header');
  const [user] = await Promise.allSettled([getCurrentUser()]);
  header.appendChild(
    el(
      'h1',
      'jellio-home-greeting',
      user.status === 'fulfilled' && user.value ? 'Welcome back, ' + user.value.Name : 'Welcome back',
    ),
  );
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
  const appended = new Set();
  preloadHomeSectionsWithProgress(function (section) {
    removeSkeleton();
    appended.add(section);
    rows.appendChild(section);
  }).then(function (sections) {
    removeSkeleton();
    sections.forEach(function (section) {
      if (!appended.has(section)) rows.appendChild(section);
    });
  });

  return hero.destroy;
}
