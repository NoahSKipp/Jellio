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
} from '../runtime/api.js';
import { buildRow } from '../components/row.js';
import { buildLibraryCoverflow } from '../components/libraryCoverflow.js';

const GENRE_ROWS = 6;
const ROW_LIMIT = 20;

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
function mountCoverflow(root, options) {
  const coverflow = buildLibraryCoverflow(options);
  coverflow.ready.then(function (mounted) {
    if (mounted) root.insertBefore(coverflow.element, root.firstChild);
  });
  return coverflow.destroy;
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

  const destroy = mountCoverflow(root, { parentId, itemTypes: itemType });

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
      const result = await getLibraryItems(parentId, collectionType, {
        limit: ROW_LIMIT,
        sortBy: parts[0],
        sortOrder: parts[1],
        genre: genre || undefined,
      });
      items = (result && result.Items) || [];
    } catch (err) {
      console.warn('Jellio: could not load library items', err);
    }
    const newRow = buildRow(genre || sortLabel(sortSelect.value), items);
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

      return Promise.allSettled(
        genres.map(function (genre) {
          return getGenreItems(parentId, itemType, genre, ROW_LIMIT);
        }),
      ).then(function (genreItemLists) {
        genreItemLists.forEach(function (result, index) {
          if (result.status === 'fulfilled') {
            const row = buildRow(genres[index], result.value);
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
async function renderAnime(root, collectionType) {
  const header = el('header', 'jellio-library-header');
  header.appendChild(el('h1', 'jellio-library-title', 'Anime'));
  root.appendChild(header);

  let animeCollections = [];
  try {
    const collections = await getCollections();
    animeCollections = collections.filter(function (item) {
      return /anime|anilist/i.test(item.Name || '');
    });
  } catch (err) {
    console.warn('Jellio: could not load anime catalogs', err);
  }

  if (!animeCollections.length) {
    root.appendChild(el('p', 'jellio-service-empty', ANIME_EMPTY_MESSAGE));
    return undefined;
  }

  const rows = el('div', 'jellio-rows');
  root.appendChild(rows);

  const itemLists = await Promise.allSettled(
    animeCollections.slice(0, MAX_ANIME_ROWS).map(function (collection) {
      return getCollectionItems(collection.Id, collectionType, ROW_LIMIT);
    }),
  );

  // The coverflow features whichever catalog actually has the most
  // real items behind it, rather than always the first one returned.
  let coverflowSource = [];
  itemLists.forEach(function (result, index) {
    if (result.status !== 'fulfilled') return;
    const items = result.value;
    if (items.length > coverflowSource.length) coverflowSource = items;
    const row = buildRow(animeCollections[index].Name, items);
    if (row) rows.appendChild(row);
  });

  if (!rows.children.length) {
    rows.remove();
    root.appendChild(el('p', 'jellio-service-empty', ANIME_EMPTY_MESSAGE));
    return undefined;
  }

  return mountCoverflow(root, { items: coverflowSource });
}
