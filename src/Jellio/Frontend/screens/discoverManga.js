// Discover for the Manga shelf (#/discover?kind=manga): manga, manhwa and
// manhua series from AniList through Controllers/BookRequestController.cs's
// discover-manga, never prose books. AniList knows series, Chaptarr knows
// volumes, so a card's "Request" opens Chaptarr's search for that series
// and each volume is requested from there.
import { discoverManga, getBookshelfItems, getJellioConfig } from '../runtime/api.js';
import { navigateTo, setTitle } from '../runtime/router.js';
import { attachScrollArrows } from '../components/scrollArrows.js';
import { buildBookRequestPanel } from '../components/bookRequest.js';
import { el } from '../runtime/dom.js';

const COUNTRIES = [
  ['JP', 'Manga'],
  ['KR', 'Manhwa'],
  ['CN', 'Manhua'],
];

// AniList's own genre names.
const GENRES = [
  'Action',
  'Adventure',
  'Comedy',
  'Drama',
  'Fantasy',
  'Horror',
  'Mystery',
  'Psychological',
  'Romance',
  'Sci-Fi',
  'Slice of Life',
  'Sports',
  'Supernatural',
  'Thriller',
];

const ROW_LIMIT = 18;

function countryLabel(code) {
  const match = COUNTRIES.find((country) => country[0] === code);
  return match ? match[1] : code === 'TW' ? 'Manhua' : '';
}

function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[,:;(\[].*$/, '')
    .replace(/\s+vol(ume)?\.?\s*\d+.*$/, '')
    .replace(/^(the|a|an)\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export async function renderMangaDiscover(root, params) {
  const parentId = params.get('parent') || '';
  const mangaLibrary = params.get('mangaLibrary') === '1';
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-discover';
  setTitle('Discover manga - Jellio');

  let cancelled = false;
  let requestsEnabled = false;
  const owned = new Set();

  const header = el('header', 'jellio-library-header jellio-discover-header');
  const back = el('button', 'jellio-discover-back');
  back.type = 'button';
  back.setAttribute('aria-label', 'Back to Manga');
  back.appendChild(el('span', 'material-icons arrow_back'));
  back.addEventListener('click', function () {
    if (parentId) {
      navigateTo(
        '#/books?topParentId=' + parentId + '&collectionType=books&bookKind=manga' + (mangaLibrary ? '&mangaLibrary=1' : ''),
      );
    } else {
      window.history.back();
    }
  });
  header.appendChild(back);
  const headingWrap = el('div', 'jellio-discover-heading');
  headingWrap.appendChild(el('h1', 'jellio-library-title', 'Discover manga'));
  headingWrap.appendChild(el('p', 'jellio-bookshelf-stats', 'Manga, manhwa and manhua. Request the volumes you want.'));
  header.appendChild(headingWrap);
  root.appendChild(header);

  const toolbar = el('div', 'jellio-discover-toolbar');
  const searchForm = el('form', 'jellio-bookshelf-search jellio-discover-author-search');
  searchForm.appendChild(el('span', 'material-icons search'));
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.placeholder = 'Search manga, manhwa and manhua';
  searchInput.setAttribute('aria-label', 'Search manga, manhwa and manhua');
  searchForm.appendChild(searchInput);
  toolbar.appendChild(searchForm);
  root.appendChild(toolbar);

  const chips = el('div', 'jellio-discover-chips');
  root.appendChild(chips);
  const body = el('div', 'jellio-discover-body jellio-rows');
  root.appendChild(body);

  // --- request sheet ------------------------------------------------------

  let sheet = null;
  function closeSheet() {
    if (!sheet) return;
    sheet.remove();
    sheet = null;
    document.removeEventListener('keydown', onSheetKey);
  }
  function onSheetKey(event) {
    if (event.key === 'Escape') closeSheet();
  }
  function openRequestSheet(series) {
    closeSheet();
    sheet = el('div', 'jellio-manga-sheet');
    sheet.addEventListener('click', function (event) {
      if (event.target === sheet) closeSheet();
    });
    const panel = el('div', 'jellio-manga-sheet-panel');
    const head = el('div', 'jellio-manga-sheet-head');
    head.appendChild(el('h2', 'jellio-row-title', series.Title));
    const close = el('button', 'jellio-discover-back');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.appendChild(el('span', 'material-icons close'));
    close.addEventListener('click', closeSheet);
    head.appendChild(close);
    panel.appendChild(head);
    panel.appendChild(
      el(
        'p',
        'jellio-bookshelf-stats',
        (series.Volumes ? series.Volumes + ' volumes. ' : '') + 'Pick the volumes to request from Chaptarr.',
      ),
    );
    panel.appendChild(
      buildBookRequestPanel('ebook', {
        label: 'Search volumes',
        placeholder: 'Series and volume',
        initialQuery: series.Title,
        ebookLabel: 'Request',
      }),
    );
    sheet.appendChild(panel);
    root.appendChild(sheet);
    document.addEventListener('keydown', onSheetKey);
  }

  // --- cards --------------------------------------------------------------

  function seriesCard(series) {
    const card = el('article', 'jellio-discover-card');
    const cover = el('div', 'jellio-discover-cover');
    if (series.CoverUrl) {
      const img = document.createElement('img');
      img.src = series.CoverUrl;
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', function () {
        img.replaceWith(el('span', 'material-icons collections_bookmark'));
      });
      cover.appendChild(img);
    } else {
      cover.appendChild(el('span', 'material-icons collections_bookmark'));
    }
    const kindLabel = countryLabel(series.Country);
    if (kindLabel) cover.appendChild(el('span', 'jellio-manga-kind', kindLabel));
    card.appendChild(cover);
    card.appendChild(el('div', 'jellio-discover-title', series.Title));
    if (series.Author) card.appendChild(el('div', 'jellio-discover-year', series.Author));
    const facts = [series.Year, series.Volumes ? series.Volumes + ' vol.' : '', series.Status === 'RELEASING' ? 'Ongoing' : '']
      .filter(Boolean)
      .join(' · ');
    if (facts) card.appendChild(el('div', 'jellio-discover-year', facts));

    const button = el('button', 'jellio-discover-request');
    button.type = 'button';
    const have = owned.has(normalizeTitle(series.Title)) || (series.AltTitle && owned.has(normalizeTitle(series.AltTitle)));
    if (!requestsEnabled) {
      button.hidden = true;
    } else {
      button.textContent = have ? 'In library · more' : 'Request';
      if (have) button.classList.add('jellio-discover-request-done');
      button.addEventListener('click', function () {
        openRequestSheet(series);
      });
    }
    card.appendChild(button);
    return card;
  }

  function row(title, loader, onMore) {
    const section = el('section', 'jellio-row jellio-discover-row');
    const heading = el('button', 'jellio-row-title jellio-discover-row-title');
    heading.type = 'button';
    heading.appendChild(el('span', null, title));
    heading.appendChild(el('span', 'material-icons chevron_right'));
    heading.addEventListener('click', onMore);
    section.appendChild(heading);
    const trackWrap = el('div', 'jellio-row-track-wrap');
    const track = el('div', 'jellio-row-track');
    for (let i = 0; i < 6; i++) track.appendChild(el('div', 'jellio-discover-card jellio-discover-card-skeleton'));
    trackWrap.appendChild(track);
    section.appendChild(trackWrap);
    loader()
      .then(function (list) {
        if (cancelled) return;
        if (!list.length) {
          section.remove();
          return;
        }
        track.textContent = '';
        list.slice(0, ROW_LIMIT).forEach((series) => track.appendChild(seriesCard(series)));
        attachScrollArrows(trackWrap, track);
      })
      .catch(function () {
        section.remove();
      });
    return section;
  }

  // --- views --------------------------------------------------------------

  let active = 'for-you';
  function paintChips() {
    chips.textContent = '';
    const options = [
      ['for-you', 'For you'],
      ['trending', 'Trending'],
      ['popular', 'Popular'],
      ['top', 'Top rated'],
    ]
      .concat(COUNTRIES.map((country) => ['country:' + country[0], country[1]]))
      .concat(GENRES.map((genre) => ['genre:' + genre, genre]));
    options.forEach(function (option) {
      const chip = el('button', 'jellio-discover-chip' + (active === option[0] ? ' jellio-discover-chip-active' : ''), option[1]);
      chip.type = 'button';
      chip.setAttribute('aria-pressed', active === option[0] ? 'true' : 'false');
      chip.addEventListener('click', function () {
        active = option[0];
        if (option[0] === 'for-you') return showForYou();
        if (option[0] === 'trending' || option[0] === 'popular' || option[0] === 'top') {
          return showGrid({ sort: option[0] }, option[1]);
        }
        if (option[0].indexOf('country:') === 0) {
          return showGrid({ sort: 'popular', country: option[0].slice(8) }, 'Popular ' + option[1].toLowerCase());
        }
        return showGrid({ sort: 'popular', genre: option[0].slice(6) }, option[1]);
      });
      chips.appendChild(chip);
    });
  }

  function showForYou() {
    active = 'for-you';
    paintChips();
    body.textContent = '';
    body.appendChild(row('Trending now', () => discoverManga({ sort: 'trending' }), () => showGrid({ sort: 'trending' }, 'Trending')));
    COUNTRIES.forEach(function (country) {
      body.appendChild(
        row(
          'Popular ' + country[1].toLowerCase(),
          () => discoverManga({ sort: 'popular', country: country[0] }),
          () => showGrid({ sort: 'popular', country: country[0] }, 'Popular ' + country[1].toLowerCase()),
        ),
      );
    });
    body.appendChild(row('Top rated', () => discoverManga({ sort: 'top' }), () => showGrid({ sort: 'top' }, 'Top rated')));
  }

  function showGrid(query, title) {
    if (query.q) active = '';
    paintChips();
    body.textContent = '';
    window.scrollTo({ top: 0, behavior: 'smooth' });
    const head = el('div', 'jellio-discover-grid-head');
    head.appendChild(el('h2', 'jellio-row-title', title));
    body.appendChild(head);
    const grid = el('div', 'jellio-discover-grid');
    body.appendChild(grid);
    const status = el('p', 'jellio-bookshelf-empty-inline', 'Loading…');
    body.appendChild(status);
    const more = el('button', 'jellio-vocab-secondary jellio-discover-more', 'Load more');
    more.type = 'button';
    more.hidden = true;
    body.appendChild(more);
    let page = 0;
    const seen = new Set();
    function load() {
      more.hidden = true;
      status.hidden = false;
      status.textContent = 'Loading…';
      discoverManga(Object.assign({}, query, { page: page }))
        .then(function (list) {
          if (cancelled || !grid.isConnected) return;
          const fresh = list.filter((series) => !seen.has(series.Id));
          fresh.forEach(function (series) {
            seen.add(series.Id);
            grid.appendChild(seriesCard(series));
          });
          status.hidden = !!grid.children.length;
          status.textContent = grid.children.length ? '' : 'Nothing found.';
          more.hidden = !fresh.length || list.length < 20;
        })
        .catch(function () {
          if (!grid.isConnected) return;
          status.hidden = false;
          status.textContent = 'Could not reach AniList. Try again in a moment.';
          more.hidden = false;
        });
    }
    more.addEventListener('click', function () {
      page++;
      load();
    });
    load();
  }

  searchForm.addEventListener('submit', function (event) {
    event.preventDefault();
    const query = searchInput.value.trim();
    if (query) showGrid({ q: query }, 'Results for “' + query + '”');
  });

  await Promise.all([
    getJellioConfig()
      .then(function (config) {
        requestsEnabled = !!(config && config.BookRequestsEnabled);
      })
      .catch(function () {}),
    parentId
      ? getBookshelfItems(parentId, 'manga', mangaLibrary)
          .then(function (items) {
            items.forEach(function (item) {
              owned.add(normalizeTitle(item.SeriesName || item.Name));
            });
          })
          .catch(function () {})
      : Promise.resolve(),
  ]);
  if (!cancelled) showForYou();

  return function cleanup() {
    cancelled = true;
    closeSheet();
  };
}
