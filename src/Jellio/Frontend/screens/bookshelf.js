// The Books and Audiobooks shelves (components/navShared.js gives one
// Jellyfin Books library a sidebar entry per format, told apart by
// &bookKind=). Built around how people browse books rather than films:
// what they're in the middle of, who wrote it, which series it belongs
// to, then the whole shelf as a filterable grid. Authors, genres and
// series come from Controllers/BookMetadataController.cs's shelf-info,
// which fills Jellyfin's usually-empty book fields from Chaptarr.
import {
  getBookshelfItems,
  getBookShelfInfo,
  getContinueReading,
  getContinueListening,
  getJellioConfig,
  getAllReadingProgress,
  audiobookGroupKey,
} from '../runtime/api.js';
import { groupMangaSeries, resumePoint } from '../components/mangaSeries.js';
import { renderMangaSeries } from './mangaSeries.js';
import { buildRow } from '../components/row.js';
import { buildCard } from '../components/card.js';
import { buildBookRequestPanel } from '../components/bookRequest.js';
import { openMangaRequestSheet } from '../components/mangaRequest.js';
import { buildHomeSkeleton } from '../components/homeSkeleton.js';
import { navigateTo, setTitle } from '../runtime/router.js';
import { el } from '../runtime/dom.js';

const KINDS = {
  ebook: {
    title: 'Books',
    one: 'book',
    many: 'books',
    continueTitle: 'Continue reading',
    loadContinue: getContinueReading,
    emptyIcon: 'auto_stories',
  },
  audiobook: {
    title: 'Audiobooks',
    one: 'audiobook',
    many: 'audiobooks',
    continueTitle: 'Continue listening',
    loadContinue: getContinueListening,
    emptyIcon: 'headphones',
  },
  // A Books library named for manga or comics (components/navShared.js).
  // Series lead: volumes are read in order, one series at a time.
  manga: {
    title: 'Manga',
    one: 'series',
    many: 'series',
    continueTitle: 'Continue reading',
    loadContinue: getContinueReading,
    emptyIcon: 'collections_bookmark',
    seriesRows: 24,
    // Requested through components/mangaRequest.js (Suwayomi chapters or
    // Chaptarr volumes); Discover browses AniList.
    requestType: 'ebook',
    requestLabel: 'Request manga',
    requestPlaceholder: 'Series and volume, e.g. Berserk Vol. 1',
    requestButton: 'Request',
  },
};

const SORTS = [
  { value: 'title', label: 'Title' },
  { value: 'author', label: 'Author' },
  { value: 'added', label: 'Recently added' },
  { value: 'year-desc', label: 'Newest published' },
  { value: 'year-asc', label: 'Oldest published' },
];

const ROW_LIMIT = 20;
const MAX_AUTHOR_ROWS = 6;
const MAX_SERIES_ROWS = 6;
// Below this, a "Recently added" row just repeats the grid under it.
const RECENT_ROW_MIN_ITEMS = 9;

function sortStorageKey(kind) {
  return 'jellio-bookshelf-sort:' + kind;
}

function readSort(kind) {
  try {
    const saved = localStorage.getItem(sortStorageKey(kind));
    if (SORTS.some((sort) => sort.value === saved)) return saved;
  } catch (err) {
    // Storage unavailable (private window): fall back to the default.
  }
  return 'title';
}

function writeSort(kind, value) {
  try {
    localStorage.setItem(sortStorageKey(kind), value);
  } catch (err) {
    // Not worth surfacing; the sort still applies for this visit.
  }
}

function idKey(id) {
  return String(id || '').replace(/-/g, '');
}

function authorKey(name) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// One card's worth of what the shelf knows about a book, Jellyfin's own
// fields first (an audiobook's album artist is its author), then
// Chaptarr's via shelf-info.
function describe(item, info) {
  const meta = info[idKey(item.Id)] || {};
  const author = item.AlbumArtist || meta.Authors || '';
  return {
    item: item,
    author: author,
    authorKey: author ? authorKey(author) : '',
    year: item.ProductionYear || meta.Year || null,
    series: meta.SeriesTitle || '',
    added: item.DateCreated ? Date.parse(item.DateCreated) || 0 : 0,
    search: ((item.Name || '') + ' ' + author + ' ' + (meta.SeriesTitle || '')).toLowerCase(),
  };
}

function compareBy(sort) {
  const byTitle = (a, b) => (a.item.SortName || a.item.Name || '').localeCompare(b.item.SortName || b.item.Name || '');
  if (sort === 'author') {
    return (a, b) => {
      if (!a.author !== !b.author) return a.author ? -1 : 1;
      return a.author.localeCompare(b.author) || byTitle(a, b);
    };
  }
  if (sort === 'added') return (a, b) => b.added - a.added || byTitle(a, b);
  if (sort === 'year-desc') return (a, b) => (b.year || 0) - (a.year || 0) || byTitle(a, b);
  if (sort === 'year-asc') {
    return (a, b) => (a.year || Infinity) - (b.year || Infinity) || byTitle(a, b);
  }
  return byTitle;
}

// Cards carry the author under the title; books are told apart by who
// wrote them far more often than by year.
function bookCard(entry, cardOptions) {
  if (entry.seriesGroup) return seriesCard(entry);
  const card = buildCard(entry.item, cardOptions);
  if (entry.author) card.appendChild(el('div', 'jellio-card-subtitle', entry.author));
  return card;
}

function bookRow(title, entries, cardOptions) {
  const row = buildRow(
    title,
    entries.map((entry) => entry.item),
    cardOptions,
  );
  if (!row) return null;
  const cards = row.querySelectorAll('.jellio-row-track > .jellio-card');
  cards.forEach(function (card, index) {
    const entry = entries[index];
    if (entry && entry.seriesGroup) {
      card.replaceWith(seriesCard(entry));
      return;
    }
    if (entry && entry.author) card.appendChild(el('div', 'jellio-card-subtitle', entry.author));
  });
  return row;
}

// A manga series: the first chapter's card, relabelled, opening the
// series (screens/mangaSeries.js) instead of one chapter. Cloned to drop
// the chapter card's own click handling.
function seriesCard(entry) {
  const card = buildCard(entry.item).cloneNode(true);
  card.classList.add('jellio-card-manga-series');
  const group = entry.seriesGroup;
  const facts = [group.chapters.length + ' chapters'];
  if (entry.readCount) facts.push(entry.readCount === group.chapters.length ? 'all read' : entry.readCount + ' read');
  card.appendChild(el('div', 'jellio-card-subtitle', facts.join(' · ')));
  function open() {
    const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
    params.set('series', group.key);
    navigateTo('#/books?' + params.toString());
  }
  card.addEventListener('click', open);
  card.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });
  return card;
}

function groupBy(entries, keyOf, labelOf) {
  const groups = new Map();
  entries.forEach(function (entry) {
    const key = keyOf(entry);
    if (!key) return;
    if (!groups.has(key)) groups.set(key, { key: key, label: labelOf(entry), entries: [] });
    groups.get(key).entries.push(entry);
  });
  return Array.from(groups.values()).sort(
    (a, b) => b.entries.length - a.entries.length || a.label.localeCompare(b.label),
  );
}

// The Manga shelf shows series, not chapter files: one entry per series
// (cover from its first chapter), files that belong to no series on
// their own. Continue reading is worked out per series from reading
// progress, so finishing a chapter moves the series on to the next one.
function mangaEntries(items, info, progress) {
  const grouped = groupMangaSeries(items);
  const continueEntries = [];
  const entries = grouped.series.map(function (group) {
    const coverItem = group.chapters.find((item) => item.ImageTags && item.ImageTags.Primary) || group.chapters[0];
    const base = describe(coverItem, info);
    const resume = resumePoint(group.chapters, progress);
    if (resume.lastRead && resume.chapter) {
      const entry = describe(resume.chapter, info);
      continueEntries.push(Object.assign(entry, { author: group.title, lastRead: resume.lastRead }));
    }
    return Object.assign(base, {
      item: Object.assign({}, coverItem, { Name: group.title, SortName: group.title, UserData: null }),
      series: '',
      seriesGroup: group,
      readCount: resume.readCount,
      added: Math.max.apply(null, group.chapters.map((item) => (item.DateCreated ? Date.parse(item.DateCreated) || 0 : 0))),
      search: (group.title + ' ' + base.author).toLowerCase(),
    });
  });
  grouped.singles.forEach((item) => entries.push(describe(item, info)));
  continueEntries.sort((a, b) => b.lastRead - a.lastRead);
  return { entries: entries, continueEntries: continueEntries.slice(0, ROW_LIMIT) };
}

export function renderBookshelf(root, params, parentId) {
  const requestedKind = params.get('bookKind');
  const kind = requestedKind === 'audiobook' || requestedKind === 'manga' ? requestedKind : 'ebook';
  if (kind === 'manga' && params.get('series')) return renderMangaSeries(root, params, parentId);
  const copy = KINDS[kind];
  setTitle(copy.title + ' - Jellio');
  root.classList.add('jellio-screen-bookshelf');

  let cancelled = false;
  let closeMangaSheet = null;
  let entries = [];
  let filterText = '';
  let selectedAuthor = '';
  let sort = readSort(kind);

  const header = el('header', 'jellio-library-header jellio-bookshelf-header');
  header.appendChild(el('h1', 'jellio-library-title', copy.title));
  const stats = el('p', 'jellio-bookshelf-stats');
  header.appendChild(stats);
  root.appendChild(header);

  const toolbar = el('div', 'jellio-bookshelf-toolbar');
  const searchWrap = el('label', 'jellio-bookshelf-search');
  searchWrap.appendChild(el('span', 'material-icons search'));
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.placeholder = 'Filter ' + copy.many + ' by title, author or series';
  searchInput.setAttribute('aria-label', 'Filter ' + copy.many);
  searchWrap.appendChild(searchInput);
  toolbar.appendChild(searchWrap);

  const sortSelect = document.createElement('select');
  sortSelect.className = 'jellio-library-filter-select';
  sortSelect.setAttribute('aria-label', 'Sort by');
  SORTS.forEach(function (option) {
    const optionEl = document.createElement('option');
    optionEl.value = option.value;
    optionEl.textContent = option.label;
    sortSelect.appendChild(optionEl);
  });
  sortSelect.value = sort;
  toolbar.appendChild(sortSelect);

  // Words saved while reading, reviewed as flashcards (screens/vocab.js).
  const vocabButton = el('button', 'jellio-bookshelf-vocab');
  vocabButton.type = 'button';
  vocabButton.appendChild(el('span', 'material-icons translate'));
  vocabButton.appendChild(el('span', null, 'Vocabulary'));
  vocabButton.addEventListener('click', function () {
    navigateTo('#/vocab');
  });
  toolbar.appendChild(vocabButton);
  root.appendChild(toolbar);

  // Only offered once an admin has wired up Chaptarr, and scoped to this
  // shelf's format.
  const requestMount = el('div', 'jellio-book-request-mount');
  root.appendChild(requestMount);
  getJellioConfig()
    .then(function (config) {
      // Chaptarr and Open Library cover books, not manga.
      if (cancelled) return;
      const discover = el('button', 'jellio-book-request-toggle jellio-bookshelf-discover');
      discover.type = 'button';
      discover.appendChild(el('span', 'material-icons explore'));
      discover.appendChild(el('span', null, 'Discover'));
      discover.addEventListener('click', function () {
        navigateTo(
          '#/discover?kind=' +
            kind +
            '&parent=' +
            encodeURIComponent(parentId) +
            (params.get('mangaLibrary') === '1' ? '&mangaLibrary=1' : ''),
        );
      });
      if (kind === 'manga' && config && (config.BookRequestsEnabled || config.MangaRequestsEnabled)) {
        // Chapters from Suwayomi and/or volumes from Chaptarr, in one sheet.
        const wrap = el('section', 'jellio-book-request');
        const open = el('button', 'jellio-book-request-toggle');
        open.type = 'button';
        open.appendChild(el('span', 'material-icons add'));
        open.appendChild(el('span', null, copy.requestLabel));
        open.addEventListener('click', function () {
          if (closeMangaSheet) closeMangaSheet();
          closeMangaSheet = openMangaRequestSheet(root, {
            suwayomi: !!config.MangaRequestsEnabled,
            chaptarr: !!config.BookRequestsEnabled,
          });
        });
        wrap.appendChild(open);
        wrap.appendChild(discover);
        requestMount.appendChild(wrap);
      } else if (config && config.BookRequestsEnabled && kind !== 'manga') {
        const panel = buildBookRequestPanel(copy.requestType || kind, {
          label: copy.requestLabel,
          placeholder: copy.requestPlaceholder,
          ebookLabel: copy.requestButton,
        });
        panel.querySelector('.jellio-book-request-toggle').after(discover);
        requestMount.appendChild(panel);
      } else {
        const wrap = el('section', 'jellio-book-request');
        wrap.appendChild(discover);
        requestMount.appendChild(wrap);
      }
    })
    .catch(function () {});

  // Rows answer "what next" and "who/which series"; hidden while a
  // filter is active so the grid of matches is right there.
  const rows = el('div', 'jellio-rows jellio-bookshelf-rows');
  root.appendChild(rows);
  const skeleton = buildHomeSkeleton();
  rows.appendChild(skeleton);

  const authorsSection = el('section', 'jellio-bookshelf-authors');
  authorsSection.hidden = true;
  root.appendChild(authorsSection);

  const gridSection = el('section', 'jellio-bookshelf-all');
  const gridHeader = el('div', 'jellio-bookshelf-all-header');
  const gridTitle = el('h2', 'jellio-row-title');
  gridHeader.appendChild(gridTitle);
  const clearFilter = el('button', 'jellio-bookshelf-clear');
  clearFilter.type = 'button';
  clearFilter.appendChild(el('span', 'material-icons close'));
  clearFilter.appendChild(el('span', null, 'Clear filter'));
  clearFilter.hidden = true;
  gridHeader.appendChild(clearFilter);
  gridSection.appendChild(gridHeader);
  const grid = el('div', 'jellio-library-grid jellio-bookshelf-grid');
  gridSection.appendChild(grid);
  root.appendChild(gridSection);

  function isFiltering() {
    return !!(filterText || selectedAuthor);
  }

  function renderGrid() {
    const query = filterText.toLowerCase();
    const matches = entries
      .filter((entry) => !selectedAuthor || entry.authorKey === selectedAuthor)
      .filter((entry) => !query || entry.search.indexOf(query) !== -1)
      .sort(compareBy(sort));

    grid.textContent = '';
    matches.forEach(function (entry) {
      grid.appendChild(bookCard(entry));
    });

    const selected = selectedAuthor && entries.find((entry) => entry.authorKey === selectedAuthor);
    if (selected) gridTitle.textContent = 'By ' + selected.author;
    else if (query) gridTitle.textContent = matches.length + ' ' + (matches.length === 1 ? copy.one : copy.many) + ' found';
    else gridTitle.textContent = 'All ' + copy.many;

    if (!matches.length && entries.length) {
      grid.appendChild(el('p', 'jellio-bookshelf-empty-inline', 'Nothing on this shelf matches.'));
    }

    rows.hidden = isFiltering();
    clearFilter.hidden = !isFiltering();
    authorsSection.querySelectorAll('.jellio-bookshelf-author-chip').forEach(function (chip) {
      chip.classList.toggle('jellio-bookshelf-author-chip-active', chip.dataset.author === selectedAuthor);
      chip.setAttribute('aria-pressed', chip.dataset.author === selectedAuthor ? 'true' : 'false');
    });
  }

  function selectAuthor(key) {
    selectedAuthor = selectedAuthor === key ? '' : key;
    renderGrid();
    if (selectedAuthor) gridSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderAuthors(authorGroups) {
    authorsSection.textContent = '';
    if (!authorGroups.length) {
      authorsSection.hidden = true;
      return;
    }
    authorsSection.hidden = false;
    authorsSection.appendChild(el('h2', 'jellio-row-title', 'Authors'));
    const strip = el('div', 'jellio-bookshelf-author-strip');
    authorGroups.forEach(function (group) {
      const chip = el('button', 'jellio-bookshelf-author-chip');
      chip.type = 'button';
      chip.dataset.author = group.key;
      chip.appendChild(el('span', 'jellio-bookshelf-author-initial', group.label.trim().charAt(0).toUpperCase()));
      chip.appendChild(el('span', 'jellio-bookshelf-author-name', group.label));
      chip.appendChild(el('span', 'jellio-bookshelf-author-count', String(group.entries.length)));
      chip.addEventListener('click', function () {
        selectAuthor(group.key);
      });
      strip.appendChild(chip);
    });
    authorsSection.appendChild(strip);
  }

  function renderRows(continueItems, authorGroups) {
    rows.textContent = '';

    // Only what's on this shelf: the Books shelf doesn't show manga in
    // progress, and vice versa. Audiobooks match by book (folder and
    // album), since the track in progress needn't be the shelf's card.
    const byId = new Map(entries.map((entry) => [idKey(entry.item.Id), entry]));
    const byBook = new Map(entries.map((entry) => [audiobookGroupKey(entry.item), entry]));
    const continueEntries = kind === 'manga' ? continueItems : continueItems
      .map(function (item) {
        const entry = byId.get(idKey(item.Id)) || (item.Type === 'AudioBook' ? byBook.get(audiobookGroupKey(item)) : null);
        return entry ? Object.assign({}, entry, { item: item }) : null;
      })
      .filter(Boolean);
    const continueRow = bookRow(copy.continueTitle, continueEntries, { openReader: true });
    if (continueRow) rows.appendChild(continueRow);

    if (entries.length >= RECENT_ROW_MIN_ITEMS) {
      const recent = entries
        .slice()
        .sort(compareBy('added'))
        .slice(0, ROW_LIMIT);
      const recentRow = bookRow('Recently added', recent);
      if (recentRow) rows.appendChild(recentRow);
    }

    const seriesGroups = groupBy(
      entries,
      (entry) => (entry.series ? entry.series.toLowerCase() : ''),
      (entry) => entry.series,
    ).filter((group) => group.entries.length >= 2);
    const inSeriesRow = new Set();
    seriesGroups.slice(0, copy.seriesRows || MAX_SERIES_ROWS).forEach(function (group) {
      group.entries.forEach((entry) => inSeriesRow.add(entry));
      const row = bookRow(group.label, group.entries.slice().sort(compareBy('year-asc')).slice(0, ROW_LIMIT));
      if (row) {
        row.classList.add('jellio-bookshelf-series-row');
        rows.appendChild(row);
      }
    });

    // An author whose books all sit in a series row above already has
    // their row.
    authorGroups
      .filter((group) => group.entries.length >= 2)
      .filter((group) => group.entries.some((entry) => !inSeriesRow.has(entry)))
      .slice(0, MAX_AUTHOR_ROWS)
      .forEach(function (group) {
        const row = bookRow('More by ' + group.label, group.entries.slice().sort(compareBy('title')).slice(0, ROW_LIMIT));
        if (row) rows.appendChild(row);
      });
  }

  function renderEmpty() {
    rows.textContent = '';
    gridSection.hidden = true;
    const empty = el('div', 'jellio-bookshelf-empty');
    empty.appendChild(el('span', 'material-icons ' + copy.emptyIcon));
    empty.appendChild(el('p', null, 'No ' + copy.many + ' on this shelf yet.'));
    rows.appendChild(empty);
  }

  searchInput.addEventListener('input', function () {
    filterText = searchInput.value.trim();
    renderGrid();
  });
  sortSelect.addEventListener('change', function () {
    sort = sortSelect.value;
    writeSort(kind, sort);
    renderGrid();
  });
  clearFilter.addEventListener('click', function () {
    filterText = '';
    selectedAuthor = '';
    searchInput.value = '';
    renderGrid();
  });

  Promise.all([
    getBookshelfItems(parentId, kind, params.get('mangaLibrary') === '1'),
    getBookShelfInfo(parentId),
    copy.loadContinue(20).catch(function () {
      return [];
    }),
    kind === 'manga' ? getAllReadingProgress().catch(() => ({})) : Promise.resolve(null),
  ])
    .then(function (results) {
      if (cancelled) return;
      const items = results[0];
      const info = results[1] || {};
      if (kind === 'manga') {
        const manga = mangaEntries(items, info, results[3] || {});
        entries = manga.entries;
        results[2] = manga.continueEntries;
      } else {
        entries = items.map((item) => describe(item, info));
      }

      if (!entries.length) {
        stats.textContent = '';
        renderEmpty();
        return;
      }

      const authorGroups = groupBy(
        entries,
        (entry) => entry.authorKey,
        (entry) => entry.author,
      );
      stats.textContent =
        entries.length +
        ' ' +
        (entries.length === 1 ? copy.one : copy.many) +
        (authorGroups.length ? ' · ' + authorGroups.length + (authorGroups.length === 1 ? ' author' : ' authors') : '');

      renderRows(results[2] || [], authorGroups);
      renderAuthors(authorGroups);
      renderGrid();
    })
    .catch(function (err) {
      if (cancelled) return;
      console.warn('Jellio: could not load the shelf', err);
      rows.textContent = '';
      gridSection.hidden = true;
      rows.appendChild(el('p', 'jellio-service-empty', 'Could not load this shelf. Try again in a moment.'));
    });

  return function () {
    cancelled = true;
    if (closeMangaSheet) closeMangaSheet();
  };
}
