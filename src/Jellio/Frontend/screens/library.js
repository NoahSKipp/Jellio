// The library page a sidebar link opens onto. topParentId/parentId and
// collectionType come straight off the route's own query string (app.js's
// job to parse and pass along), the same two params the original Jellio
// codebase's own sidebar already builds into its library links.
//
// Coverflow carousel plus genre rows, ported from the original codebase's
// own libraryBrowse.js/libraryCoverflow.js (real endpoints, same
// thresholds), rather than the flat grid this screen shipped with first
// and rather than the home screen's own hero carousel it briefly used
// after that: real feedback asked directly for library pages to use the
// three-card coverflow shape, not either of those.
import {
  getItem,
  getLibraryItems,
  itemTypesForKind,
  discoverGenres,
  getGenreItems,
  getCollections,
  getCollectionItems,
  isAnimeCollection,
} from '../runtime/api.js';
import { buildRow } from '../components/row.js';
import { buildLibraryCoverflow } from '../components/libraryCoverflow.js';
import { showsEditorial } from '../runtime/editorial.js';

// Only a real anime catalog collection whose own name actually says
// "trending" earns the row badge below: runtime/api.js's own
// isAnimeCollection() elsewhere on this page just answers "does this
// collection belong on the Anime page at all", a much narrower real
// question.
const TRENDING_ANIME_NAME = /anilist.*trending|trending.*anilist/i;

const GENRE_ROWS = 6;
const ROW_LIMIT = 20;
// components/rowListModal.js's own "browse everything": real full
// depth for whichever row a reader actually opened, not the same
// ROW_LIMIT-capped array the row itself already rendered from.
const ROW_LIST_LIMIT = 500;

// Generous rather than exact: this is a best effort exclusion set, not
// a real query Jellyfin itself can answer (no CollectionType tells a
// real anime Series apart from any other one sharing the same real TV
// library, same constraint renderAnime's own header above already
// documents). A catalog with more real members than this still misses
// a few, not worth a second real paginated fetch just to close that
// last gap.
const ANIME_ITEM_ID_LIMIT = 500;

// Every real item id any real anime/anilist catalog collection
// currently claims, best effort: the Shows hub below drops anything in
// this set from its own real main row and genre rows, real feedback's
// own direct ask ("if possible show no anime at all in the Shows
// hub"). Failure of any part of this (no catalogs configured, a
// request that 404s) resolves to an empty real Set rather than
// rejecting, the Shows hub renders unfiltered same as before this
// existed rather than breaking outright over a real best effort
// feature.
function getAnimeItemIds() {
  return getCollections()
    .then(function (collections) {
      const animeCollections = collections.filter(isAnimeCollection);
      if (!animeCollections.length) return new Set();
      return Promise.allSettled(
        animeCollections.map(function (collection) {
          return getCollectionItems(collection.Id, 'tvshows', ANIME_ITEM_ID_LIMIT);
        }),
      ).then(function (results) {
        const ids = new Set();
        results.forEach(function (result) {
          if (result.status !== 'fulfilled') return;
          result.value.forEach(function (item) {
            if (item && item.Id) ids.add(item.Id);
          });
        });
        return ids;
      });
    })
    .catch(function () {
      return new Set();
    });
}

// Ported in spirit from NuvioWeb's own filterPicker.js: a sort/filter
// control over the library's own top row rather than a full rebuild of
// the page, the per genre rows below already cover "browse by genre"
// as fixed shortcuts. value is "SortBy:SortOrder", the same two real
// query params getLibraryItems already accepts.
const SORT_OPTIONS = [
  { value: 'DateCreated:Descending', label: 'Recently added' },
  { value: 'SortName:Ascending', label: 'Name (A-Z)' },
  { value: 'SortName:Descending', label: 'Name (Z-A)' },
  { value: 'CommunityRating:Descending', label: 'Top rated' },
  { value: 'PremiereDate:Descending', label: 'Newest release' },
];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Mounts a coverflow only once it has confirmed enough real slides to be
// worth showing (its own MIN_SLIDES floor), rather than always reserving
// the space: a library without a carousel is still a working library,
// same reasoning the original codebase's own fetchItems() documents.
//
// Real bug, found live against a real screenshot: components/
// libraryCoverflow.js's own real candidate fetch (runtime/api.js's own
// getHeroCandidates) is cached by its own real parentId/itemTypes key,
// so navigating away from a library screen and back to the exact same
// one before that real fetch first resolves starts a second real
// coverflow instance that shares the exact same in-flight real
// promise. app.js's own teardownActiveScreen() calls this function's
// own returned destroy, real cleanup for the first instance's own real
// setInterval, but coverflow.destroy() never touched the real .ready
// promise chain below it at all: that first instance's own real
// insertBefore call still fired once the shared promise resolved, real
// root already repopulated by the second real renderLibrary call by
// then, landing two real coverflow elements in it at once instead of
// one. cancelled, set the moment this screen is actually torn down, is
// checked before that real insert ever runs.
function mountCoverflow(root, options) {
  let cancelled = false;
  const coverflow = buildLibraryCoverflow(options);
  coverflow.ready.then(function (mounted) {
    if (cancelled) return;
    if (mounted) root.insertBefore(coverflow.element, root.firstChild);
  });
  return function () {
    cancelled = true;
    coverflow.destroy();
  };
}

export async function renderLibrary(root, params) {
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-library';

  const parentId = params.get('topParentId') || params.get('parentId');
  const collectionType = params.get('collectionType') || '';

  // The sidebar's own virtual Anime entry (see components/sidebar.js)
  // points here because that is where Gelato actually puts AniList
  // titles: one global SeriesPath per series import, no separate Anime
  // CollectionType. No Jellyfin query can tell an anime Series apart
  // from any other inside the same TV library, same real constraint the
  // original codebase's own libraryBrowse.js documents, so this page
  // still cannot filter the flat grid or build genre rows the way the
  // real library pages below do. It can still get a real coverflow
  // though, sourced from a real anime/anilist catalog collection when
  // one exists, the same source the original codebase's own anime page
  // features from.
  const isAnime = params.get('jellioKind') === 'anime';

  if (!parentId) {
    root.textContent = '';
    return;
  }

  if (isAnime) {
    return renderAnime(root, collectionType);
  }

  const itemType = itemTypesForKind(collectionType);

  const header = el('header', 'jellio-library-header');
  const heading = el('h1', 'jellio-library-title');
  header.appendChild(heading);
  root.appendChild(header);

  const filterBar = el('div', 'jellio-library-filters');
  const sortSelect = document.createElement('select');
  sortSelect.className = 'jellio-library-filter-select';
  sortSelect.setAttribute('aria-label', 'Sort by');
  SORT_OPTIONS.forEach(function (option) {
    const optionEl = document.createElement('option');
    optionEl.value = option.value;
    optionEl.textContent = option.label;
    sortSelect.appendChild(optionEl);
  });
  filterBar.appendChild(sortSelect);

  const genreSelect = document.createElement('select');
  genreSelect.className = 'jellio-library-filter-select';
  genreSelect.setAttribute('aria-label', 'Genre');
  const allGenresOption = document.createElement('option');
  allGenresOption.value = '';
  allGenresOption.textContent = 'All genres';
  genreSelect.appendChild(allGenresOption);
  genreSelect.disabled = true;
  filterBar.appendChild(genreSelect);
  root.appendChild(filterBar);

  const rows = el('div', 'jellio-rows');
  root.appendChild(rows);

  // Real feedback pointed at Harbor's own Shows tab, a mood-led line
  // above its carousel that changes with the reader's own time of day:
  // only the Shows library carries one, Movies has no equivalent real
  // reference screenshot behind it.
  const editorial = collectionType === 'tvshows' ? showsEditorial(new Date().getHours()) : null;
  const destroy = mountCoverflow(root, {
    parentId,
    itemTypes: itemType,
    editorial: editorial,
    rotate: collectionType === 'tvshows',
  });

  // Anime has its own dedicated page (renderAnime above); best effort
  // to keep it off the plain Shows hub too, real feedback's own direct
  // ask. Not attempted for any other library kind, a Movies or Books
  // page has no real anime overlap question to answer at all.
  const excludeAnimeIds = collectionType === 'tvshows' ? getAnimeItemIds() : Promise.resolve(null);

  let mainRow = null;

  function sortLabel(value) {
    const match = SORT_OPTIONS.filter(function (option) {
      return option.value === value;
    })[0];
    return (match && match.label) || 'Browse';
  }

  // Governs only this page's own top row, the genre rows below stay
  // fixed "browse by genre" shortcuts either way: real feedback wanted
  // a way to sort or filter what that top row shows without rebuilding
  // the whole page around one control.
  async function loadMainRow() {
    const parts = sortSelect.value.split(':');
    const genre = genreSelect.value;
    let items = [];
    try {
      const [result, animeIds] = await Promise.all([
        getLibraryItems(parentId, collectionType, {
          limit: ROW_LIMIT,
          sortBy: parts[0],
          sortOrder: parts[1],
          genre: genre || undefined,
        }),
        excludeAnimeIds,
      ]);
      items = (result && result.Items) || [];
      if (animeIds && animeIds.size) {
        items = items.filter(function (item) {
          return !animeIds.has(item.Id);
        });
      }
    } catch (err) {
      console.warn('Jellio: could not load library items', err);
    }
    const newRow = buildRow(genre || sortLabel(sortSelect.value), items, null, function () {
      return getLibraryItems(parentId, collectionType, {
        limit: ROW_LIST_LIMIT,
        sortBy: parts[0],
        sortOrder: parts[1],
        genre: genre || undefined,
      }).then(function (result) {
        return (result && result.Items) || [];
      });
    });
    if (mainRow) mainRow.remove();
    mainRow = newRow;
    if (newRow) rows.insertBefore(newRow, rows.firstChild);
  }

  sortSelect.addEventListener('change', loadMainRow);
  genreSelect.addEventListener('change', loadMainRow);

  // Fire and forget, same reasoning mountCoverflow() above already
  // uses: app.js's own sync() queue only starts the next real
  // navigation once this function's own returned promise resolves, so
  // awaiting any of this here meant every sidebar click queued behind
  // however long this screen's own slowest real request took, reported
  // live as switching screens not working at all on a slow connection.
  // Nothing below writes anywhere this function has not already built
  // and returned control past, so there is nothing left here that
  // needs the reader to wait on it before moving on to a different
  // real screen.
  Promise.allSettled([getItem(parentId), loadMainRow()]).then(function (results) {
    const itemResult = results[0];
    heading.textContent = itemResult.status === 'fulfilled' && itemResult.value ? itemResult.value.Name : '';
  });

  discoverGenres(parentId, itemType, GENRE_ROWS)
    .then(function (genres) {
      genres.forEach(function (genre) {
        const optionEl = document.createElement('option');
        optionEl.value = genre;
        optionEl.textContent = genre;
        genreSelect.appendChild(optionEl);
      });
      genreSelect.disabled = !genres.length;

      return Promise.all([
        Promise.allSettled(
          genres.map(function (genre) {
            return getGenreItems(parentId, itemType, genre, ROW_LIMIT);
          }),
        ),
        excludeAnimeIds,
      ]).then(function (results) {
        const genreItemLists = results[0];
        const animeIds = results[1];
        genreItemLists.forEach(function (result, index) {
          if (result.status === 'fulfilled') {
            let items = result.value;
            if (animeIds && animeIds.size) {
              items = items.filter(function (item) {
                return !animeIds.has(item.Id);
              });
            }
            const row = buildRow(genres[index], items, null, function () {
              return getGenreItems(parentId, itemType, genres[index], ROW_LIST_LIMIT);
            });
            if (row) rows.appendChild(row);
          }
        });
      });
    })
    .catch(function (err) {
      console.warn('Jellio: could not load genre rows', err);
    });

  return destroy;
}

const MAX_ANIME_ROWS = 8;
const ANIME_EMPTY_MESSAGE =
  'No anime catalogs are configured on this server yet. Enable CreateCollection on an AniList catalog in Gelato to see it here.';

// Anime has no library of its own: Gelato resolves one global
// SeriesPath for every series import (GelatoManager.TryGetSeriesFolder),
// so AniList titles physically live in the shared TV library and no
// Jellyfin query can tell them apart from any other series in it. This
// used to fall back to that shared library's own flat grid the moment
// no matching catalog collection existed, which on a real server meant
// the whole TV catalog rendered here under an "Anime" heading (every
// non-anime show included), reported live against a screenshot. Only
// real anime/anilist catalog collections can speak for this page, one
// row per collection, same real constraint and same "no fallback for
// anime" rule the original codebase's own libraryBrowse.js documents:
// showing nothing is the honest outcome when no catalog is configured,
// not a copy of the Shows page.
// Fire and forget, same reasoning renderLibrary's own header above
// documents: this used to await the whole real fetch chain (catalogs,
// then every catalog's own items, then the coverflow) before ever
// returning, which meant app.js's own sync() queue sat blocked behind
// however long that took before the next real navigation could even
// start, the exact bug this screen's own sibling function next to it
// already avoids.
function renderAnime(root, collectionType) {
  const header = el('header', 'jellio-library-header');
  header.appendChild(el('h1', 'jellio-library-title', 'Anime'));
  root.appendChild(header);

  const rows = el('div', 'jellio-rows');
  root.appendChild(rows);

  let coverflowDestroy = null;
  // Real bug, found live: mountCoverflow's own cancelled flag (that
  // file's own header explains it) only ever guards the one real gap
  // between it being called and its own real candidates resolving.
  // Navigating away from Anime and back again before this whole IIFE's
  // own first real await (getCollections, then itemLists) had even
  // resolved left nothing checking whether this screen was actually
  // still the one on real display at all: root/rows are the same
  // persistent real nodes every renderLibrary call reuses, so a stale
  // call finishing late still built its own real rows into an orphaned
  // rows reference and still called mountCoverflow against the real
  // current root, landing a second real coverflow next to whatever the
  // real current call had already mounted, reported live as
  // intermittent "two carousels". cancelled, set true the instant this
  // screen's own real destroy runs, is checked after every real await
  // below rather than only once up front.
  let cancelled = false;

  (async function () {
    let animeCollections = [];
    try {
      const collections = await getCollections();
      if (cancelled) return;
      animeCollections = collections.filter(isAnimeCollection);
    } catch (err) {
      console.warn('Jellio: could not load anime catalogs', err);
    }
    if (cancelled) return;

    if (!animeCollections.length) {
      rows.remove();
      root.appendChild(el('p', 'jellio-service-empty', ANIME_EMPTY_MESSAGE));
      return;
    }

    const itemLists = await Promise.allSettled(
      animeCollections.slice(0, MAX_ANIME_ROWS).map(function (collection) {
        return getCollectionItems(collection.Id, collectionType, ROW_LIMIT);
      }),
    );
    if (cancelled) return;

    // Real feedback: the coverflow used to feature whichever catalog
    // actually had the most real items behind it, which on a real
    // server left it just as likely to show a Popular or Seasonal
    // catalog's own items as the Trending one, no real tie to whatever
    // "Trending on AniList" badge happened to land on a row further
    // down the same page. The real Trending catalog, when this server
    // actually has one, gets the coverflow now, exclusively; every
    // other catalog still falls back to the old "most items" pick
    // among itself so the coverflow is never left empty on a server
    // with no Trending catalog configured at all. That same catalog is
    // skipped as its own row below once it becomes the hero instead,
    // real feedback's own "two carousels" complaint: the same handful
    // of trending titles were rendering twice, once as the coverflow's
    // own pick (whenever it happened to have the most items) and again
    // as a plain row underneath it.
    // components/libraryCoverflow.js's own MIN_SLIDES floor: a Trending
    // catalog with fewer real items than that would never actually
    // mount as a coverflow anyway, so it stays a normal row instead of
    // being pulled out from under itself into a hero that never renders.
    const COVERFLOW_MIN_ITEMS = 3;
    let coverflowSource = [];
    let coverflowIsTrending = false;
    let trendingIndex = -1;
    itemLists.forEach(function (result, index) {
      if (result.status !== 'fulfilled') return;
      const items = result.value;
      const name = animeCollections[index].Name || '';
      if (TRENDING_ANIME_NAME.test(name) && items.length >= COVERFLOW_MIN_ITEMS) {
        trendingIndex = index;
        coverflowSource = items;
        coverflowIsTrending = true;
      } else if (!coverflowIsTrending && items.length > coverflowSource.length) {
        coverflowSource = items;
      }
    });

    itemLists.forEach(function (result, index) {
      if (result.status !== 'fulfilled' || index === trendingIndex) return;
      const items = result.value;
      const name = animeCollections[index].Name || '';
      const collectionId = animeCollections[index].Id;
      const row = buildRow(name, items, null, function () {
        return getCollectionItems(collectionId, collectionType, ROW_LIST_LIMIT);
      });
      if (row) rows.appendChild(row);
    });

    if (!rows.children.length && !coverflowIsTrending) {
      rows.remove();
      root.appendChild(el('p', 'jellio-service-empty', ANIME_EMPTY_MESSAGE));
      return;
    }
    if (cancelled) return;

    coverflowDestroy = mountCoverflow(root, {
      items: coverflowSource,
      badge: coverflowIsTrending ? { icon: 'trending_up', text: 'Trending on AniList' } : null,
    });
  })();

  return function () {
    cancelled = true;
    if (coverflowDestroy) coverflowDestroy();
  };
}
