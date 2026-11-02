import { t } from '../runtime/i18n.js';
import {
  getItem,
  getLibraryItems,
  getAnimeIds,
  withoutAnime,
  itemTypesForKind,
  discoverGenres,
  getAllGenres,
  getGenreItems,
  getGenreItemsPage,
  getCollections,
  getCollectionItems,
  isAnimeCollection,
} from '../runtime/api.js';
import { buildRow } from '../components/row.js';
import { renderBookshelf } from './bookshelf.js';
import { buildLibraryCoverflow } from '../components/libraryCoverflow.js';
import { showsEditorial } from '../runtime/editorial.js';
import { buildHomeSkeleton } from '../components/homeSkeleton.js';
import { el } from '../runtime/dom.js';

const TRENDING_ANIME_NAME = /anilist.*trending|trending.*anilist/i;

const GENRE_ROWS = 6;
const ROW_LIMIT = 20;
const ROW_LIST_LIMIT = 500;

function getSortOptions() {
  return [
    { value: 'PremiereDate:Descending', label: t('library_sort_newest') },
    { value: 'CommunityRating:Descending', label: t('library_sort_top_rated') },
    { value: 'SortName:Ascending', label: t('library_sort_name_asc') },
    { value: 'SortName:Descending', label: t('library_sort_name_desc') },
  ];
}

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

  const isAnime = params.get('jellioKind') === 'anime';

  if (!parentId) {
    root.textContent = '';
    return;
  }

  if (isAnime) {
    return renderAnime(root, collectionType);
  }

  if (collectionType === 'books') {
    return renderBookshelf(root, params, parentId);
  }

  const itemType = itemTypesForKind(collectionType);

  const header = el('header', 'jellio-library-header');
  const heading = el('h1', 'jellio-library-title');
  header.appendChild(heading);
  root.appendChild(header);

  const filterBar = el('div', 'jellio-library-filters');
  const sortSelect = document.createElement('select');
  sortSelect.className = 'jellio-library-filter-select';
  sortSelect.setAttribute('aria-label', t('library_sort_by'));
  getSortOptions().forEach(function (option) {
    const optionEl = document.createElement('option');
    optionEl.value = option.value;
    optionEl.textContent = option.label;
    sortSelect.appendChild(optionEl);
  });
  filterBar.appendChild(sortSelect);

  const genreSelect = document.createElement('select');
  genreSelect.className = 'jellio-library-filter-select';
  genreSelect.setAttribute('aria-label', t('library_filter_genre'));
  const allGenresOption = document.createElement('option');
  allGenresOption.value = '';
  allGenresOption.textContent = t('library_all_genres');
  genreSelect.appendChild(allGenresOption);
  genreSelect.disabled = true;
  filterBar.appendChild(genreSelect);
  root.appendChild(filterBar);

  const rows = el('div', 'jellio-rows');
  root.appendChild(rows);

  const skeleton = buildHomeSkeleton(4);
  rows.appendChild(skeleton);
  let skeletonRemoved = false;
  function removeSkeleton() {
    if (skeletonRemoved) return;
    skeletonRemoved = true;
    if (skeleton.parentNode) skeleton.parentNode.removeChild(skeleton);
  }

  const editorial = collectionType === 'tvshows' ? showsEditorial(new Date().getHours()) : null;
  const destroy = mountCoverflow(root, {
    parentId,
    itemTypes: itemType,
    editorial: editorial,
    rotate: collectionType === 'tvshows',
  });

  const excludeAnimeIds = collectionType === 'tvshows' || collectionType === 'movies' ? getAnimeIds() : Promise.resolve(null);

  let mainRow = null;

  function sortLabel(value) {
    const match = getSortOptions().filter(function (option) {
      return option.value === value;
    })[0];
    return (match && match.label) || 'Browse';
  }

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
        items = withoutAnime(items, animeIds);
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
        return Promise.resolve(excludeAnimeIds).then(function (animeIds) {
          return withoutAnime((result && result.Items) || [], animeIds);
        });
      });
    });
    if (mainRow) mainRow.remove();
    mainRow = newRow;
    if (newRow) rows.insertBefore(newRow, rows.firstChild);
  }

  sortSelect.addEventListener('change', loadMainRow);
  genreSelect.addEventListener('change', loadMainRow);

  Promise.allSettled([getItem(parentId), loadMainRow()]).then(function (results) {
    const itemResult = results[0];
    heading.textContent = itemResult.status === 'fulfilled' && itemResult.value ? itemResult.value.Name : '';
  });

  getAllGenres(parentId, itemType)
    .then(function (genres) {
      genres.forEach(function (genre) {
        const optionEl = document.createElement('option');
        optionEl.value = genre;
        optionEl.textContent = genre;
        genreSelect.appendChild(optionEl);
      });
      genreSelect.disabled = !genres.length;
    })
    .catch(function (err) {
      console.warn('Jellio: could not load genre filter options', err);
    });

  // Each genre row goes up as soon as its own items arrive, kept in genre
  // order, instead of waiting for the slowest one.
  function placeGenreRow(row, order) {
    row.dataset.jellioGenreOrder = String(order);
    const after = Array.from(rows.children).find(function (child) {
      return child.dataset.jellioGenreOrder !== undefined && Number(child.dataset.jellioGenreOrder) > order;
    });
    rows.insertBefore(row, after || (skeleton.parentNode === rows ? skeleton : null));
  }

  discoverGenres(parentId, itemType, GENRE_ROWS)
    .then(function (genres) {
      return Promise.allSettled(
        genres.map(function (genre, index) {
          return Promise.all([getGenreItems(parentId, itemType, genre, ROW_LIMIT), excludeAnimeIds]).then(function (results) {
            const animeIds = results[1];
            let items = results[0];
            if (animeIds && animeIds.size) {
              items = withoutAnime(items, animeIds);
            }
            const row = buildRow(genre, items, null, {
              fetchPage: function (start, size) {
                return getGenreItemsPage(parentId, itemType, genre, start, size).then(function (page) {
                  return withoutAnime(page, animeIds);
                });
              },
            });
            if (row) placeGenreRow(row, index);
          });
        }),
      ).then(removeSkeleton);
    })
    .catch(function (err) {
      console.warn('Jellio: could not load genre rows', err);
      removeSkeleton();
    });

  return function () {
    removeSkeleton();
    destroy();
  };
}

const MAX_ANIME_ROWS = 8;
const ANIME_EMPTY_MESSAGE =
  t('library_anime_empty');

function renderAnime(root, collectionType) {
  const header = el('header', 'jellio-library-header');
  header.appendChild(el('h1', 'jellio-library-title', t('nav_anime')));
  root.appendChild(header);

  const rows = el('div', 'jellio-rows');
  root.appendChild(rows);

  const skeleton = buildHomeSkeleton();
  rows.appendChild(skeleton);
  let skeletonRemoved = false;
  function removeSkeleton() {
    if (skeletonRemoved) return;
    skeletonRemoved = true;
    if (skeleton.parentNode) skeleton.parentNode.removeChild(skeleton);
  }

  let coverflowDestroy = null;
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
    removeSkeleton();

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
      const row = buildRow(name, items, null, {
        fetchPage: function (start, size) {
          return getCollectionItems(collectionId, collectionType, size, start);
        },
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
