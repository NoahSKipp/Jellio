// First real screen, proof of the whole architecture end to end: its own
// markup, fed entirely by runtime/api.js's own fetch calls, no native DOM
// read or waited on.
import {
  getCurrentUser,
  getResumeItems,
  getNextUp,
  getFavoriteItems,
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

// #/home?tab=1, the same hash the sidebar's own Favorites link and the
// original Jellio codebase's own NAV_LINKS both already point at, rather
// than a separate #/favorites route.
async function renderFavorites(root) {
  const header = el('header', 'jellio-home-header');
  header.appendChild(el('h1', 'jellio-home-greeting', 'Favorites'));
  root.appendChild(header);

  const grid = el('div', 'jellio-library-grid');
  root.appendChild(grid);

  try {
    const items = await getFavoriteItems();
    items.forEach(function (item) {
      grid.appendChild(buildCard(item));
    });
  } catch (err) {
    console.warn('Jellio: could not load favorites', err);
  }
}

export async function renderHome(root, params) {
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-home';

  if (params && params.get('tab') === '1') {
    await renderFavorites(root);
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
    const row = buildRow('Up Next', nextUpResult.value);
    if (row) rows.appendChild(row);
  }

  if (resumeResult.status === 'fulfilled') {
    const row = buildRow('Continue Watching', resumeResult.value);
    if (row) rows.appendChild(row);
  }

  // Shared with buildCatalogRows/buildGenreRows below via dedupe():
  // a title a recommendation row already picked should not also turn
  // up in a catalog or genre row further down the same page.
  const seen = {};

  try {
    const recommendationRows = await buildRecommendationRows(seen);
    recommendationRows.forEach(function (spec) {
      const row = buildRow(spec.title, spec.items);
      if (row) rows.appendChild(row);
    });
  } catch (err) {
    console.warn('Jellio: could not load recommendation rows', err);
  }

  if (collectionsResult.status === 'fulfilled') {
    const collections = collectionsResult.value;
    const hub = buildHubStrip(collections);
    if (hub) rows.appendChild(hub);

    const catalogRows = await buildCatalogRows(collections, seen);
    catalogRows.forEach(function (row) {
      rows.appendChild(row);
    });
  }

  const genreRows = await buildGenreRows(seen);
  genreRows.forEach(function (row) {
    rows.appendChild(row);
  });

  return hero.destroy;
}
