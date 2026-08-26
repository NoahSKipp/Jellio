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
import { buildCard } from '../components/card.js';
import { buildLibraryCoverflow } from '../components/libraryCoverflow.js';

const GENRE_ROWS = 6;
const ROW_LIMIT = 20;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function buildRow(title, items) {
  if (!items || !items.length) return null;
  const section = el('section', 'jellio-row');
  section.appendChild(el('h2', 'jellio-row-title', title));
  const track = el('div', 'jellio-row-track');
  items.forEach(function (item) {
    track.appendChild(buildCard(item));
  });
  section.appendChild(track);
  return section;
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
    return renderAnime(root, parentId, collectionType);
  }

  const itemType = itemTypesForKind(collectionType);

  const header = el('header', 'jellio-library-header');
  const heading = el('h1', 'jellio-library-title');
  header.appendChild(heading);
  root.appendChild(header);

  const rows = el('div', 'jellio-rows');
  root.appendChild(rows);

  const destroy = mountCoverflow(root, { parentId, itemTypes: itemType });

  const [itemResult, latestResult] = await Promise.allSettled([
    getItem(parentId),
    getLibraryItems(parentId, collectionType, { limit: ROW_LIMIT, sortBy: 'DateCreated', sortOrder: 'Descending' }),
  ]);

  heading.textContent = itemResult.status === 'fulfilled' && itemResult.value ? itemResult.value.Name : '';

  if (latestResult.status === 'fulfilled') {
    const row = buildRow('Recently added', (latestResult.value && latestResult.value.Items) || []);
    if (row) rows.appendChild(row);
  }

  try {
    const genres = await discoverGenres(parentId, itemType, GENRE_ROWS);
    const genreItemLists = await Promise.allSettled(
      genres.map(function (genre) {
        return getGenreItems(parentId, itemType, genre, ROW_LIMIT);
      }),
    );
    genreItemLists.forEach(function (result, index) {
      if (result.status === 'fulfilled') {
        const row = buildRow(genres[index], result.value);
        if (row) rows.appendChild(row);
      }
    });
  } catch (err) {
    console.warn('Jellio: could not load genre rows', err);
  }

  return destroy;
}

async function renderAnime(root, parentId, collectionType) {
  const header = el('header', 'jellio-library-header');
  header.appendChild(el('h1', 'jellio-library-title', 'Anime'));
  root.appendChild(header);

  const grid = el('div', 'jellio-library-grid');
  root.appendChild(grid);

  let destroy;
  try {
    const collections = await getCollections();
    const animeCollection = collections.filter(function (item) {
      return /anime|anilist/i.test(item.Name || '');
    })[0];
    if (animeCollection) {
      const items = await getCollectionItems(animeCollection.Id, collectionType, 8);
      const coverflow = buildLibraryCoverflow({ items: items });
      const mounted = await coverflow.ready;
      if (mounted) root.insertBefore(coverflow.element, root.firstChild);
      destroy = coverflow.destroy;
    }
  } catch (err) {
    console.warn('Jellio: could not load anime catalog for the coverflow', err);
  }

  try {
    const result = await getLibraryItems(parentId, collectionType);
    const items = (result && result.Items) || [];
    items.forEach(function (item) {
      grid.appendChild(buildCard(item));
    });
  } catch (err) {
    console.warn('Jellio: could not load library items', err);
  }

  return destroy;
}
