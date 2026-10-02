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
  getStreamLibrary,
  invalidateStreamLibrary,
  getStreamSeries,
  markReadingItems,
  setPlayed,
} from '../runtime/api.js';
import { showToast } from '../components/toast.js';
import {
  groupMangaSeries,
  resumePoint,
  useSeriesCover,
  mangaSeriesTitle,
  mangaSeriesKey,
  streamChapterItem,
} from '../components/mangaSeries.js';
import { attachCardOptionsTrigger } from '../components/cardOptionsMenu.js';
import { openCategoryPicker, openCategoryManager } from '../components/shelfCategories.js';
import { loadShelf, onShelfChange, updateCategory, itemShelfKey, seriesShelfKey, setInLibrary } from '../runtime/shelf.js';
import { renderMangaSeries } from './mangaSeries.js';
import { renderMangaUpdates } from './mangaUpdates.js';
import { loadLibraryView, openLibraryView, passesLibraryFilters, activeFilterCount } from '../components/libraryView.js';
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
    requestLabel: 'Find manga',
    requestPlaceholder: 'Series and volume, e.g. Berserk Vol. 1',
    requestButton: 'Request',
  },
};

// desc: the direction a sort starts in when picked.
const SORTS = [
  { value: 'title', label: 'Title' },
  { value: 'author', label: 'Author' },
  { value: 'added', label: 'Date added', desc: true },
  { value: 'year', label: 'Published' },
  { value: 'last-read', label: 'Last read', desc: true },
  { value: 'unread', label: 'Unread chapters', manga: true, desc: true },
  { value: 'chapters', label: 'Total chapters', manga: true, desc: true },
  { value: 'latest', label: 'Latest chapter', manga: true, desc: true },
];
const LEGACY_SORTS = {
  added: { sort: 'added', desc: true },
  'year-desc': { sort: 'year', desc: true },
  'year-asc': { sort: 'year', desc: false },
};

const ROW_LIMIT = 20;
const MAX_AUTHOR_ROWS = 6;
const MAX_SERIES_ROWS = 6;
// Below this, a "Recently added" row just repeats the grid under it.
const RECENT_ROW_MIN_ITEMS = 9;

function sortStorageKey(kind) {
  return 'jellio-bookshelf-sort:' + kind;
}

// { sort, desc }
function readSort(kind) {
  try {
    const saved = localStorage.getItem(sortStorageKey(kind));
    if (LEGACY_SORTS[saved]) return LEGACY_SORTS[saved];
    if (SORTS.some((sort) => sort.value === saved)) return { sort: saved, desc: false };
    const parsed = JSON.parse(saved || 'null');
    if (parsed && SORTS.some((sort) => sort.value === parsed.sort)) return { sort: parsed.sort, desc: !!parsed.desc };
  } catch (err) {
    // Storage unavailable (private window) or an old value: the default.
  }
  return { sort: 'title', desc: false };
}

function writeSort(kind, value) {
  try {
    localStorage.setItem(sortStorageKey(kind), JSON.stringify(value));
  } catch (err) {
    // Not worth surfacing; the sort still applies for this visit.
  }
}

function categoryStorageKey(kind) {
  return 'jellio-bookshelf-category:' + kind;
}

function readCategory(kind) {
  try {
    return localStorage.getItem(categoryStorageKey(kind)) || '';
  } catch (err) {
    return '';
  }
}

function writeCategory(kind, id) {
  try {
    if (id) localStorage.setItem(categoryStorageKey(kind), id);
    else localStorage.removeItem(categoryStorageKey(kind));
  } catch (err) {
    // Only remembered for this visit.
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
function lastReadOf(item, progress) {
  const record = progress && progress[idKey(item.Id).toLowerCase()];
  const read = record ? Date.parse(record.UpdatedAt) || 0 : 0;
  const played = item.UserData && item.UserData.LastPlayedDate ? Date.parse(item.UserData.LastPlayedDate) || 0 : 0;
  return Math.max(read, played);
}

function isFinished(item, progress) {
  const record = progress && progress[idKey(item.Id).toLowerCase()];
  return !!((record && record.Progress >= 0.98) || (item.UserData && item.UserData.Played));
}

function describe(item, info, progress) {
  const meta = info[idKey(item.Id)] || {};
  const author = item.AlbumArtist || meta.Authors || '';
  const added = item.DateCreated ? Date.parse(item.DateCreated) || 0 : 0;
  return {
    item: item,
    key: itemShelfKey(item),
    author: author,
    authorKey: author ? authorKey(author) : '',
    year: item.ProductionYear || meta.Year || null,
    series: meta.SeriesTitle || '',
    added: added,
    latest: added,
    lastRead: lastReadOf(item, progress),
    chapters: 1,
    unread: isFinished(item, progress) ? 0 : 1,
    search: ((item.Name || '') + ' ' + author + ' ' + (meta.SeriesTitle || '')).toLowerCase(),
  };
}

// Ascending order for each sort; desc flips it. Ties go by title.
function compareBy(sort, desc) {
  const byTitle = (a, b) => (a.item.SortName || a.item.Name || '').localeCompare(b.item.SortName || b.item.Name || '');
  let compare;
  if (sort === 'author') {
    compare = (a, b) => {
      if (!a.author !== !b.author) return a.author ? -1 : 1;
      return a.author.localeCompare(b.author);
    };
  } else if (sort === 'year') {
    compare = (a, b) => (a.year || (desc ? 0 : Infinity)) - (b.year || (desc ? 0 : Infinity));
  } else if (sort === 'added' || sort === 'last-read' || sort === 'unread' || sort === 'chapters' || sort === 'latest') {
    const field = { added: 'added', 'last-read': 'lastRead', unread: 'unread', chapters: 'chapters', latest: 'latest' }[sort];
    compare = (a, b) => (a[field] || 0) - (b[field] || 0);
  } else {
    return desc ? (a, b) => byTitle(b, a) : byTitle;
  }
  return (a, b) => (desc ? compare(b, a) : compare(a, b)) || byTitle(a, b);
}

// Cards carry the author under the title; books are told apart by who
// wrote them far more often than by year.
// The manga shelf's filter and display choices (components/libraryView.js).
let libraryViewState = loadLibraryView();

function bookCard(entry, cardOptions) {
  if (entry.seriesGroup) return seriesCard(entry, cardOptions);
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
      card.replaceWith(seriesCard(entry, cardOptions));
      return;
    }
    if (entry && entry.author) card.appendChild(el('div', 'jellio-card-subtitle', entry.author));
  });
  return row;
}

// A manga series: the first chapter's card, relabelled, opening the
// series (screens/mangaSeries.js) instead of one chapter. Cloned to drop
// the chapter card's own click handling.
function seriesCard(entry, cardOptions) {
  const card = buildCard(entry.item, { reading: true }).cloneNode(true);
  card.classList.add('jellio-card-manga-series');
  const group = entry.seriesGroup;
  let img = card.querySelector('img.jellio-card-image');
  if (!img) {
    const placeholder = card.querySelector('.jellio-card-image-empty');
    if (placeholder) {
      img = document.createElement('img');
      img.className = 'jellio-card-image';
      img.alt = group.title;
      img.loading = 'lazy';
      placeholder.hidden = true;
      placeholder.after(img);
    }
  }
  if (img) {
    useSeriesCover(
      img,
      group.chapters[0],
      function () {
        img.remove();
        const placeholder = card.querySelector('.jellio-card-image-empty');
        if (placeholder) placeholder.hidden = false;
      },
      group.stream && group.stream.MangaId,
    );
  }
  const total = entry.chapters || group.chapters.length;
  const facts = [total + (total === 1 ? ' chapter' : ' chapters')];
  if (entry.readCount) facts.push(entry.readCount >= total ? 'all read' : entry.readCount + ' read');
  card.appendChild(el('div', 'jellio-card-subtitle', facts.join(' · ')));
  if (libraryViewState.badges && entry.unread > 0) {
    const badge = el('span', 'jellio-card-unread-badge', String(entry.unread));
    badge.title = entry.unread + (entry.unread === 1 ? ' unread chapter' : ' unread chapters');
    card.appendChild(badge);
  }
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
  if (cardOptions && cardOptions.extraOptions) {
    attachCardOptionsTrigger(card, entry.item, null, {
      onlyExtra: true,
      extraOptions: cardOptions.extraOptions(entry.item, entry),
    });
  }
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
function mangaEntries(items, info, progress, shelf, stream) {
  const grouped = groupMangaSeries(items);
  const streamByKey = new Map((stream || []).map((series) => [series.Key, series]));
  // A lone chapter file of a streamed series belongs with it.
  grouped.singles = grouped.singles.filter(function (item) {
    const title = mangaSeriesTitle(item);
    const key = title ? mangaSeriesKey(title) : '';
    if (!key || !streamByKey.has(key)) return true;
    grouped.series.push({ key: key, title: title, chapters: [item] });
    return false;
  });
  const continueEntries = [];
  function streamContinue(series, lastRead) {
    if (!series.Resume) return;
    const item = streamChapterItem(
      { Id: series.Resume.Id, ChapterId: series.Resume.ChapterId, MangaId: series.MangaId, Name: series.Resume.Name },
      series.Title,
    );
    continueEntries.push({ item: item, key: seriesShelfKey(series.Key), author: series.Title, lastRead: lastRead });
  }
  const entries = grouped.series.map(function (group) {
    const coverItem = group.chapters.find((item) => item.ImageTags && item.ImageTags.Primary) || group.chapters[0];
    const base = describe(coverItem, info, progress);
    const resume = resumePoint(group.chapters, progress);
    const streamed = streamByKey.get(group.key);
    streamByKey.delete(group.key);
    group.stream = streamed || null;
    const streamLastRead = streamed && streamed.LastReadAt ? Date.parse(streamed.LastReadAt) || 0 : 0;
    if (streamed && streamLastRead > resume.lastRead) {
      streamContinue(streamed, streamLastRead);
    } else if (resume.lastRead && resume.chapter) {
      const entry = describe(resume.chapter, info, progress);
      continueEntries.push(Object.assign(entry, { author: group.title, lastRead: resume.lastRead, seriesKey: seriesShelfKey(group.key) }));
    }
    const key = seriesShelfKey(group.key);
    const prefs = (shelf.Series || {})[key] || {};
    const latest = Math.max(
      streamed ? streamed.LatestUpload || 0 : 0,
      Math.max.apply(null, group.chapters.map((item) => (item.DateCreated ? Date.parse(item.DateCreated) || 0 : 0))),
    );
    const chapters = Math.max(group.chapters.length, streamed ? streamed.ChapterCount : 0);
    const readCount = Math.max(resume.readCount, streamed ? streamed.ReadCount : 0);
    return Object.assign(base, {
      item: Object.assign({}, coverItem, { Name: group.title, SortName: group.title, UserData: null }),
      key: key,
      series: '',
      seriesGroup: group,
      readCount: readCount,
      added: prefs.AddedAt || latest,
      latest: latest,
      lastRead: Math.max(resume.lastRead, streamLastRead),
      chapters: chapters,
      unread: chapters - readCount,
      search: (group.title + ' ' + base.author).toLowerCase(),
    });
  });
  // Series only in Suwayomi's library: read straight from the source.
  streamByKey.forEach(function (series) {
    const key = seriesShelfKey(series.Key);
    const prefs = (shelf.Series || {})[key] || {};
    const lastRead = series.LastReadAt ? Date.parse(series.LastReadAt) || 0 : 0;
    if (lastRead) streamContinue(series, lastRead);
    const author = series.Author || '';
    entries.push({
      item: {
        Id: series.FirstChapterId || 'stream' + series.MangaId,
        Name: series.Title,
        SortName: series.Title,
        Type: 'Book',
        ImageTags: {},
        UserData: null,
        Stream: { MangaId: series.MangaId },
      },
      key: key,
      author: author,
      authorKey: author ? authorKey(author) : '',
      year: null,
      series: '',
      seriesGroup: { key: series.Key, title: series.Title, chapters: [], stream: series },
      readCount: series.ReadCount,
      added: prefs.AddedAt || series.LatestUpload || 0,
      latest: series.LatestUpload || 0,
      lastRead: lastRead,
      chapters: series.ChapterCount,
      unread: series.ChapterCount - series.ReadCount,
      search: (series.Title + ' ' + author).toLowerCase(),
    });
  });
  grouped.singles.forEach((item) => entries.push(describe(item, info, progress)));
  continueEntries.sort((a, b) => b.lastRead - a.lastRead);
  // The reader's own library (Mihon style): series they added or have
  // read, minus any they removed. Streamed series already come filtered
  // from the server.
  const mine = new Set(shelf.Library || []);
  const removed = new Set(shelf.LibraryRemoved || []);
  const kept = entries.filter(
    (entry) =>
      !removed.has(entry.key) &&
      (mine.has(entry.key) || (entry.seriesGroup && entry.seriesGroup.stream) || entry.lastRead > 0 || entry.readCount > 0),
  );
  const continuing = continueEntries.filter((entry) => !removed.has(entry.seriesKey || entry.key));
  return { entries: kept, continueEntries: continuing.slice(0, ROW_LIMIT) };
}

export function renderBookshelf(root, params, parentId) {
  const requestedKind = params.get('bookKind');
  const kind = requestedKind === 'audiobook' || requestedKind === 'manga' ? requestedKind : 'ebook';
  if (kind === 'manga' && params.get('series')) return renderMangaSeries(root, params, parentId);
  if (kind === 'manga' && params.get('updates')) return renderMangaUpdates(root, params);
  const copy = KINDS[kind];
  setTitle(copy.title + ' - Jellio');
  root.classList.add('jellio-screen-bookshelf');

  let cancelled = false;
  let closeMangaSheet = null;
  let entries = [];
  let filterText = '';
  let selectedAuthor = '';
  let sort = readSort(kind);
  let shelf = { Categories: [], Series: {}, Bookmarks: [] };
  let activeCategory = readCategory(kind);
  let loadedItems = null;

  // Manga chapters belong to their series' categories.
  function keyForItem(item) {
    if (kind === 'manga') {
      const title = mangaSeriesTitle(item);
      const key = title ? seriesShelfKey(mangaSeriesKey(title)) : '';
      if (key && entries.some((entry) => entry.key === key)) return key;
    }
    return itemShelfKey(item);
  }

  // Every chapter id a series card stands for: saved chapters (and the
  // streamed ones they match), plus the rest from its source.
  async function seriesChapterIds(entry) {
    const group = entry.seriesGroup;
    const ids = [];
    group.chapters.forEach(function (chapter) {
      ids.push(chapter.Id);
      if (chapter.StreamId) ids.push(chapter.StreamId);
    });
    if (group.stream && group.stream.MangaId) {
      const series = await getStreamSeries(group.stream.MangaId).catch(() => null);
      ((series && series.Chapters) || []).forEach((chapter) => ids.push(chapter.Id));
    }
    return ids;
  }

  async function markRead(entry, item, read) {
    const chapters = entry && entry.seriesGroup ? entry.seriesGroup.chapters : [item];
    const ids = entry && entry.seriesGroup ? await seriesChapterIds(entry) : [item.Id];
    if (!ids.length) return;
    await markReadingItems(ids, read);
    // A chapter marked watched before counts as read too; clear that.
    if (!read) {
      await Promise.all(
        chapters.filter((chapter) => chapter.UserData && chapter.UserData.Played).map((chapter) => setPlayed(chapter.Id, false).catch(() => null)),
      );
    }
    load();
  }

  function readOptions(item, entry) {
    if (kind === 'audiobook') return [];
    const options = [];
    const progress = (loadedItems && loadedItems.progress) || {};
    const allRead = entry && entry.seriesGroup ? entry.chapters > 0 && entry.readCount >= entry.chapters : isFinished(item, progress);
    const someRead = entry && entry.seriesGroup ? entry.readCount > 0 : allRead;
    function option(read) {
      return {
        label: read ? 'Mark as read' : 'Mark as unread',
        icon: read ? 'done_all' : 'remove_done',
        onClick: function () {
          markRead(entry, item, read).catch(function (err) {
            console.warn('Jellio: could not update read state', err);
            showToast('Could not update read state. Try again.');
          });
        },
      };
    }
    if (!allRead) options.push(option(true));
    if (someRead) options.push(option(false));
    return options;
  }

  const shelfCardOptions = {
    reading: true,
    onlyExtra: true,
    extraOptions: function (item, givenEntry) {
      const key = givenEntry ? givenEntry.key : keyForItem(item);
      // A Continue reading card is one chapter; its series is the entry.
      const entry = givenEntry || entries.find((candidate) => candidate.key === key) || null;
      const options = [
        {
          label: 'Categories…',
          icon: 'label',
          onClick: function () {
            openCategoryPicker(kind, [key], entry ? entry.item.Name : item.Name);
          },
        },
      ];
      if (kind === 'manga' && key.indexOf('s:') === 0) {
        options.push({
          label: 'Remove from library',
          icon: 'heart_broken',
          onClick: function () {
            invalidateStreamLibrary();
            setInLibrary(key, false).catch(function (err) {
              console.warn('Jellio: could not update the library', err);
              showToast('Could not remove it from your library. Try again.');
            });
          },
        });
      }
      return readOptions(item, entry && (entry.seriesGroup || entry.item.Id === item.Id) ? entry : null).concat(options);
    },
  };

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
  SORTS.filter((option) => !option.manga || kind === 'manga').forEach(function (option) {
    const optionEl = document.createElement('option');
    optionEl.value = option.value;
    optionEl.textContent = option.label;
    sortSelect.appendChild(optionEl);
  });
  toolbar.appendChild(sortSelect);
  const sortDirection = el('button', 'jellio-bookshelf-sort-direction');
  sortDirection.type = 'button';
  const sortDirectionIcon = el('span', 'material-icons');
  sortDirection.appendChild(sortDirectionIcon);
  toolbar.appendChild(sortDirection);
  const viewButton = el('button', 'jellio-bookshelf-sort-direction jellio-bookshelf-view-button');
  viewButton.type = 'button';
  viewButton.setAttribute('aria-label', 'Filter and display');
  viewButton.appendChild(el('span', 'material-icons tune'));
  const viewCount = el('span', 'jellio-bookshelf-view-count');
  viewButton.appendChild(viewCount);
  viewButton.hidden = kind !== 'manga';
  viewButton.addEventListener('click', function () {
    openLibraryView(libraryViewState, function () {
      renderGrid();
    });
  });
  toolbar.appendChild(viewButton);

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

  // Mihon-style categories: All, then the reader's own.
  const tabs = el('div', 'jellio-shelf-tabs');
  tabs.setAttribute('role', 'tablist');
  root.appendChild(tabs);
  function updatesButton() {
    const button = el('button', 'jellio-book-request-toggle jellio-bookshelf-discover');
    button.type = 'button';
    button.appendChild(el('span', 'material-icons new_releases'));
    button.appendChild(el('span', null, 'Updates'));
    button.addEventListener('click', function () {
      const next = new URLSearchParams(params);
      next.set('updates', '1');
      navigateTo('#/books?' + next.toString());
    });
    return button;
  }
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
            openSeries: function (key) {
              const next = new URLSearchParams(params);
              next.set('series', key);
              navigateTo('#/books?' + next.toString());
            },
          });
        });
        wrap.appendChild(open);
        wrap.appendChild(discover);
        wrap.appendChild(updatesButton());
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
        if (kind === 'manga') wrap.appendChild(updatesButton());
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

  function currentCategory() {
    return activeCategory ? shelf.Categories.find((category) => category.Id === activeCategory) || null : null;
  }

  function isFiltering() {
    return !!(filterText || selectedAuthor || currentCategory());
  }

  // The category's own sort while one is open, else this shelf's.
  function currentSort() {
    const category = currentCategory();
    return category ? { sort: category.Sort || 'title', desc: !!category.Descending } : sort;
  }

  function paintSortControls() {
    const current = currentSort();
    sortSelect.value = current.sort;
    sortDirectionIcon.className = 'material-icons ' + (current.desc ? 'arrow_downward' : 'arrow_upward');
    const label = current.desc ? 'Descending' : 'Ascending';
    sortDirection.setAttribute('aria-label', label);
    sortDirection.title = label;
  }

  function setSort(next) {
    const category = currentCategory();
    if (category) {
      category.Sort = next.sort;
      category.Descending = next.desc;
      updateCategory(kind, category.Id, { Sort: next.sort, Descending: next.desc }).catch(function (err) {
        console.warn('Jellio: could not save the category sort', err);
      });
    } else {
      sort = next;
      writeSort(kind, sort);
    }
    paintSortControls();
    renderGrid();
  }

  function renderTabs() {
    tabs.textContent = '';
    const keys = new Set(entries.map((entry) => entry.key));
    function tab(label, id, count) {
      const button = el('button', 'jellio-shelf-tab' + (activeCategory === id ? ' jellio-shelf-tab-active' : ''));
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', activeCategory === id ? 'true' : 'false');
      button.appendChild(el('span', null, label));
      button.appendChild(el('span', 'jellio-shelf-tab-count', String(count)));
      button.addEventListener('click', function () {
        activeCategory = id;
        writeCategory(kind, id);
        renderTabs();
        paintSortControls();
        renderGrid();
      });
      tabs.appendChild(button);
    }
    tab('All', '', entries.length);
    shelf.Categories.forEach(function (category) {
      tab(category.Name, category.Id, category.Items.filter((key) => keys.has(key)).length);
    });
    const edit = el('button', 'jellio-shelf-tab jellio-shelf-tab-edit');
    edit.type = 'button';
    edit.appendChild(el('span', 'material-icons ' + (shelf.Categories.length ? 'edit' : 'add')));
    edit.appendChild(el('span', null, shelf.Categories.length ? 'Edit' : 'Category'));
    edit.setAttribute('aria-label', shelf.Categories.length ? 'Edit categories' : 'Add a category');
    edit.addEventListener('click', () => openCategoryManager(kind));
    tabs.appendChild(edit);
  }

  function renderGrid() {
    const query = filterText.toLowerCase();
    const category = currentCategory();
    const inCategory = category ? new Set(category.Items) : null;
    const current = currentSort();
    const matches = entries
      .filter((entry) => !inCategory || inCategory.has(entry.key))
      .filter((entry) => !selectedAuthor || entry.authorKey === selectedAuthor)
      .filter((entry) => !query || entry.search.indexOf(query) !== -1)
      .filter((entry) => kind !== 'manga' || passesLibraryFilters(entry, libraryViewState))
      .sort(compareBy(current.sort, current.desc));

    const filterCount = kind === 'manga' ? activeFilterCount(libraryViewState) : 0;
    viewCount.textContent = filterCount ? String(filterCount) : '';
    viewButton.classList.toggle('jellio-bookshelf-view-active', filterCount > 0);
    grid.classList.toggle('jellio-bookshelf-grid-compact', kind === 'manga' && libraryViewState.display === 'compact');
    grid.classList.toggle('jellio-bookshelf-grid-cover', kind === 'manga' && libraryViewState.display === 'cover');
    grid.textContent = '';
    matches.forEach(function (entry) {
      grid.appendChild(bookCard(entry, shelfCardOptions));
    });

    const selected = selectedAuthor && entries.find((entry) => entry.authorKey === selectedAuthor);
    if (selected) gridTitle.textContent = 'By ' + selected.author;
    else if (query) gridTitle.textContent = matches.length + ' ' + (matches.length === 1 ? copy.one : copy.many) + ' found';
    else if (category) gridTitle.textContent = category.Name;
    else gridTitle.textContent = kind === 'manga' ? 'Library' : 'All ' + copy.many;

    if (!matches.length && category && !query && !selectedAuthor) {
      grid.appendChild(el('p', 'jellio-bookshelf-empty-inline', 'Nothing in ' + category.Name + ' yet. Right click (or hold) a cover and choose Categories to add it.'));
    } else if (!matches.length && entries.length) {
      grid.appendChild(el('p', 'jellio-bookshelf-empty-inline', 'Nothing on this shelf matches.'));
    }

    rows.hidden = isFiltering();
    authorsSection.hidden = !!category || !authorsSection.childElementCount;
    clearFilter.hidden = !(filterText || selectedAuthor);
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
    if (!authorGroups.length || kind === 'manga') {
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
    const continueRow = bookRow(copy.continueTitle, continueEntries, Object.assign({ openReader: true }, shelfCardOptions));
    if (continueRow) rows.appendChild(continueRow);
    // Manga is the reader's own library; Discover is for browsing.
    if (kind === 'manga') return;

    if (entries.length >= RECENT_ROW_MIN_ITEMS) {
      const recent = entries
        .slice()
        .sort(compareBy('latest', true))
        .slice(0, ROW_LIMIT);
      const recentRow = bookRow('Recently added', recent, shelfCardOptions);
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
      const row = bookRow(group.label, group.entries.slice().sort(compareBy('year', false)).slice(0, ROW_LIMIT), shelfCardOptions);
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
        const row = bookRow('More by ' + group.label, group.entries.slice().sort(compareBy('title', false)).slice(0, ROW_LIMIT), shelfCardOptions);
        if (row) rows.appendChild(row);
      });
  }

  function renderEmpty() {
    rows.textContent = '';
    gridSection.hidden = true;
    const empty = el('div', 'jellio-bookshelf-empty');
    empty.appendChild(el('span', 'material-icons ' + copy.emptyIcon));
    empty.appendChild(el('p', null, kind === 'manga' ? 'Your manga library is empty.' : 'No ' + copy.many + ' on this shelf yet.'));
    if (kind === 'manga') {
      empty.appendChild(
        el('p', 'jellio-bookshelf-stats', 'Find series with Discover or Request manga, or bring your Mihon library over in Settings.'),
      );
    }
    rows.appendChild(empty);
  }

  searchInput.addEventListener('input', function () {
    filterText = searchInput.value.trim();
    renderGrid();
  });
  sortSelect.addEventListener('change', function () {
    const option = SORTS.find((entry) => entry.value === sortSelect.value);
    setSort({ sort: sortSelect.value, desc: !!(option && option.desc) });
  });
  sortDirection.addEventListener('click', function () {
    const current = currentSort();
    setSort({ sort: current.sort, desc: !current.desc });
  });
  paintSortControls();
  clearFilter.addEventListener('click', function () {
    filterText = '';
    selectedAuthor = '';
    searchInput.value = '';
    renderGrid();
  });

  function load() {
  Promise.all([
    getBookshelfItems(parentId, kind, params.get('mangaLibrary') === '1'),
    kind === 'manga' ? Promise.resolve({}) : getBookShelfInfo(parentId),
    copy.loadContinue(20).catch(function () {
      return [];
    }),
    kind === 'audiobook' ? Promise.resolve({}) : getAllReadingProgress().catch(() => ({})),
    loadShelf(kind),
    kind === 'manga' ? getStreamLibrary() : Promise.resolve([]),
  ])
    .then(function (results) {
      if (cancelled) return;
      const items = results[0];
      const info = results[1] || {};
      shelf = results[4];
      if (activeCategory && !currentCategory()) activeCategory = '';
      loadedItems = { items: items, info: info, progress: results[3] || {}, stream: results[5] || [] };
      if (kind === 'manga') {
        const manga = mangaEntries(items, info, results[3] || {}, shelf, results[5]);
        entries = manga.entries;
        results[2] = manga.continueEntries;
      } else {
        entries = items.map((item) => describe(item, info, results[3] || {}));
      }

      if (!entries.length) {
        stats.textContent = kind === 'manga' && results[5] && results[5].failed ? 'Suwayomi isn’t answering right now.' : '';
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

      if (kind === 'manga' && results[5] && results[5].failed) {
        stats.textContent += ' · Suwayomi isn’t answering, so series read from their sources are missing';
      }
      renderRows(results[2] || [], authorGroups);
      renderAuthors(authorGroups);
      renderTabs();
      paintSortControls();
      renderGrid();
    })
    .catch(function (err) {
      if (cancelled) return;
      console.warn('Jellio: could not load the shelf', err);
      rows.textContent = '';
      gridSection.hidden = true;
      rows.appendChild(el('p', 'jellio-service-empty', 'Could not load this shelf. Try again in a moment.'));
    });
  }
  load();

  // Categories changed (here or in a dialog): repaint with the new ones.
  const stopShelf = onShelfChange(function () {
    if (!loadedItems) return;
    Promise.all([loadShelf(kind), kind === 'manga' ? getStreamLibrary() : Promise.resolve(loadedItems.stream)]).then(function (results) {
      const next = results[0];
      if (cancelled || !entries.length) return;
      shelf = next;
      loadedItems.stream = results[1];
      if (activeCategory && !currentCategory()) {
        activeCategory = '';
        writeCategory(kind, '');
      }
      if (kind === 'manga') {
        entries = mangaEntries(loadedItems.items, loadedItems.info, loadedItems.progress, shelf, loadedItems.stream).entries;
      }
      renderTabs();
      paintSortControls();
      renderGrid();
    });
  });

  return function () {
    cancelled = true;
    stopShelf();
    if (closeMangaSheet) closeMangaSheet();
  };
}
