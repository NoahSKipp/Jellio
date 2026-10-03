// Own search, not a reskin of native SearchFields.tsx: a plain text input
// against the same real /Items?searchTerm= query every other screen's own
// grid already uses. Debounced locally, does not push a route on every
// keystroke, native jellyfin-web's own hash history has no reason to grow
// one entry per character typed.
//
// Real bug, live-reported: a card clicked from a result grid had no way
// back to that same search once landed on its own detail page, only a
// different nav item or typing the whole query again, every other
// screen's own back navigation (a real history pop, this runtime never
// renders a back button of its own) having nothing here to pop back to
// in the first place, query text and results alike living only in this
// function's own local variables. reflectStateInAddressBar() below
// mirrors the current term into the address bar as this runs, without
// pushing a real history entry for it (the exact per-keystroke growth
// this file's own header above already avoids) and without re-running
// this runtime's own sync() on every keystroke either (that function's
// own header explains why a plain navigateTo()/replaceState() call
// would). A real back landing on #/search?q=... then reruns that exact
// same query fresh, same real "screens fetch their own state" shape
// every other screen here already uses rather than caching the actual
// result set.
import { searchItems, searchMovies, searchSeries, searchBooks, searchAudiobooks, getStreamLibrary, getStreamCoverUrl } from '../runtime/api.js';
import { getMangaShelfHash } from '../components/navShared.js';
import { buildCard } from '../components/card.js';
import { appendCardsLazily } from '../components/lazyGrid.js';
import { describeNetworkFailure } from '../runtime/network.js';
import { reflectStateInAddressBar, navigateTo } from '../runtime/router.js';
import { el } from '../runtime/dom.js';

const DEBOUNCE_MS = 300;
const RECENT_SEARCHES_KEY = 'jellio_recent_searches';
const MAX_RECENT_SEARCHES = 8;

function getRecentSearches() {
  try {
    const raw = window.localStorage.getItem(RECENT_SEARCHES_KEY);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Prune invalid entries and fragments saved by previous rapid-typing sessions
    const cleaned = [];
    for (const item of parsed) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (trimmed.length < 2) continue;
      const lower = trimmed.toLowerCase();
      // Check if we already kept this item or a more specific superset of it
      const hasSuperset = cleaned.some(function (existing) {
        const exLower = existing.toLowerCase();
        return exLower === lower || exLower.startsWith(lower) || exLower.includes(lower);
      });
      if (hasSuperset) continue;

      // Also remove any previously added items that are substrings/prefixes of this longer item
      for (let i = cleaned.length - 1; i >= 0; i--) {
        const exLower = cleaned[i].toLowerCase();
        if (lower.startsWith(exLower) || lower.includes(exLower)) {
          cleaned.splice(i, 1);
        }
      }
      cleaned.push(trimmed);
    }
    return cleaned.slice(0, MAX_RECENT_SEARCHES);
  } catch (err) {
    return [];
  }
}

function saveRecentSearch(term) {
  const clean = (term || '').trim();
  if (!clean || clean.length < 2) return;
  try {
    const cleanLower = clean.toLowerCase();
    const list = getRecentSearches().filter(function (item) {
      const itemLower = item.toLowerCase();
      if (itemLower === cleanLower) return false;
      if (cleanLower.startsWith(itemLower) || itemLower.startsWith(cleanLower)) return false;
      if (cleanLower.includes(itemLower)) return false;
      return true;
    });
    list.unshift(clean);
    if (list.length > MAX_RECENT_SEARCHES) list.length = MAX_RECENT_SEARCHES;
    window.localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(list));
  } catch (err) {
    // Storage blocked
  }
}

function clearRecentSearches() {
  try {
    window.localStorage.removeItem(RECENT_SEARCHES_KEY);
  } catch (err) {
    // Storage blocked
  }
}

// The reader's manga library (series streamed from their sources) by
// title, found locally from the library list the shelf already loads.
async function searchMangaLibrary(term) {
  const library = await getStreamLibrary();
  const wanted = term.toLowerCase();
  return (library || []).filter((series) => series.Title.toLowerCase().indexOf(wanted) !== -1 || (series.Author || '').toLowerCase().indexOf(wanted) !== -1);
}

function buildMangaSection(matches) {
  const section = el('section', 'jellio-search-type-section');
  section.appendChild(el('h2', 'jellio-row-title', 'Manga'));
  const list = el('div', 'jellio-search-manga-list');
  matches.slice(0, 24).forEach(function (series) {
    const row = el('button', 'jellio-search-manga');
    row.type = 'button';
    const cover = el('img', 'jellio-search-manga-cover');
    cover.alt = '';
    cover.loading = 'lazy';
    cover.src = getStreamCoverUrl(series.MangaId);
    row.appendChild(cover);
    const text = el('span', 'jellio-search-manga-text');
    text.appendChild(el('span', 'jellio-search-manga-title', series.Title));
    text.appendChild(
      el(
        'span',
        'jellio-search-manga-meta',
        [series.Author, series.ChapterCount + (series.ChapterCount === 1 ? ' chapter' : ' chapters')].filter(Boolean).join(' · '),
      ),
    );
    row.appendChild(text);
    row.addEventListener('click', function () {
      getMangaShelfHash().then(function (hash) {
        if (hash) navigateTo(hash + '&series=' + encodeURIComponent(series.Key));
      });
    });
    list.appendChild(row);
  });
  section.appendChild(list);
  return section;
}

export async function renderSearch(root, params) {
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-search';

  const header = document.createElement('header');
  header.className = 'jellio-search-header';

  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'jellio-search-input';
  input.placeholder = 'Search movies, shows, books, audiobooks and manga';
  input.setAttribute('aria-label', 'Search movies, shows, books, audiobooks and manga');
  input.autofocus = true;
  header.appendChild(input);
  root.appendChild(header);

  const recentSection = el('div', 'jellio-search-recent');
  root.appendChild(recentSection);

  function paintRecentSearches() {
    recentSection.textContent = '';
    const searches = getRecentSearches();
    if (!searches.length || input.value.trim()) {
      recentSection.hidden = true;
      return;
    }
    recentSection.hidden = false;
    const recentHeader = el('div', 'jellio-search-recent-header');
    recentHeader.appendChild(el('span', 'jellio-search-recent-title', 'Recent Searches'));
    const clearBtn = el('button', 'jellio-search-recent-clear', 'Clear all');
    clearBtn.type = 'button';
    clearBtn.addEventListener('click', function () {
      clearRecentSearches();
      paintRecentSearches();
    });
    recentHeader.appendChild(clearBtn);
    recentSection.appendChild(recentHeader);

    const chips = el('div', 'jellio-search-recent-chips');
    searches.forEach(function (query) {
      const chip = el('button', 'jellio-search-recent-chip');
      chip.type = 'button';
      chip.appendChild(el('span', 'material-icons jellio-search-recent-chip-icon', 'history'));
      chip.appendChild(el('span', null, query));
      chip.addEventListener('click', function () {
        input.value = query;
        saveRecentSearch(query);
        paintRecentSearches();
        runSearch(query);
      });
      chips.appendChild(chip);
    });
    recentSection.appendChild(chips);
  }

  // No feedback at all between "typed something" and "cards appeared"
  // used to make a slow or failed request (Gelato resolving a remote
  // catalog is not instant, and a real server error left the grid
  // exactly as empty as it started) look identical to search doing
  // nothing whatsoever, reported live as exactly that. This one line
  // is the whole fix: every branch below now leaves it saying
  // something a reader can tell apart from silence.
  const FILTER_CATEGORIES = [
    { id: 'all', label: 'All' },
    { id: 'movies', label: 'Movies' },
    { id: 'series', label: 'TV Shows' },
    { id: 'books', label: 'Books' },
    { id: 'audiobooks', label: 'Audiobooks' },
    { id: 'manga', label: 'Manga' },
  ];
  const SEARCH_TAB_STORAGE_KEY = 'jellio_search_category_tab';
  let activeFilter = 'all';
  try {
    const savedFilter = sessionStorage.getItem(SEARCH_TAB_STORAGE_KEY);
    if (savedFilter && FILTER_CATEGORIES.some(function (c) { return c.id === savedFilter; })) {
      activeFilter = savedFilter;
    }
  } catch (e) {}
  let currentSlots = {};

  function applyCategoryFilter() {
    if (!currentSlots.moviesSlot) return;
    currentSlots.moviesSlot.hidden = activeFilter !== 'all' && activeFilter !== 'movies';
    currentSlots.seriesSlot.hidden = activeFilter !== 'all' && activeFilter !== 'series';
    currentSlots.booksSlot.hidden = activeFilter !== 'all' && activeFilter !== 'books';
    currentSlots.audiobooksSlot.hidden = activeFilter !== 'all' && activeFilter !== 'audiobooks';
    currentSlots.mangaSlot.hidden = activeFilter !== 'all' && activeFilter !== 'manga';
  }

  const filterBar = el('div', 'jellio-search-filter-bar');
  filterBar.hidden = true;
  FILTER_CATEGORIES.forEach(function (cat) {
    const tab = el(
      'button',
      'jellio-search-filter-tab' + (cat.id === activeFilter ? ' jellio-search-filter-tab-active' : ''),
      cat.label,
    );
    tab.type = 'button';
    tab.addEventListener('click', function () {
      if (activeFilter === cat.id) return;
      activeFilter = cat.id;
      try {
        sessionStorage.setItem(SEARCH_TAB_STORAGE_KEY, cat.id);
      } catch (e) {}
      Array.prototype.forEach.call(filterBar.children, function (child) {
        child.classList.remove('jellio-search-filter-tab-active');
      });
      tab.classList.add('jellio-search-filter-tab-active');
      applyCategoryFilter();
    });
    filterBar.appendChild(tab);
  });
  root.appendChild(filterBar);

  const status = document.createElement('p');
  status.className = 'jellio-service-empty jellio-search-status';
  root.appendChild(status);

  const results = document.createElement('div');
  results.className = 'jellio-search-results';
  root.appendChild(results);

  // Real feedback: results used to land in one flat grid, movies and
  // series interleaved in whatever order Gelato's own AIOStreams proxy
  // happened to return them, no way to tell the two apart at a glance
  // beyond each card's own small type-adjacent detail. searchItems()
  // already asks for IncludeItemTypes: 'Movie,Series' only, so
  // item.Type is always one of exactly those two real values here, the
  // same real split screens/home.js's own Watchlist tab already uses
  // for its own Movies/Series sections.
  function buildTypeSection(title, items) {
    if (!items.length) return null;
    const section = el('section', 'jellio-row');
    section.appendChild(el('h2', 'jellio-row-title', title));
    const grid = el('div', 'jellio-library-grid');
    section.appendChild(grid);
    appendCardsLazily(grid, items, buildCard);
    return section;
  }

  let timer = null;
  let saveTimer = null;
  let requestId = 0;
  // Gelato's own search proxies straight through to AIOStreams live, one
  // real round trip per addon per request, nothing cached: a reader who
  // edits their query mid-search used to leave the old one running to its
  // own full 30s timeout in the background regardless, stacking up
  // concurrent AIOStreams round trips for a result nothing still wants.
  // Aborting it outright the moment a newer query fires frees that
  // connection and backend load immediately instead of waiting it out.
  let inFlight = [];

  function abortInFlight() {
    inFlight.forEach(function (controller) {
      controller.abort();
    });
    inFlight = [];
  }

  // Real bottleneck runtime/api.js's own searchMovies/searchSeries header
  // documents: the old single combined searchItems() call waited on
  // Gelato's own Task.WhenAll(movie search, series search) server side,
  // so a reader saw nothing at all until whichever half was slower also
  // finished. Firing the two halves as separate requests and painting
  // each into its own reserved slot the moment it resolves, regardless
  // of which one lands first, means Movies (or Series) shows up as soon
  // as its own real addon round trip is done rather than both waiting on
  // the slower one. moviesSlot/seriesSlot below are fixed DOM anchors so
  // a late-arriving Movies section still renders above Series, not
  // wherever insertion order happened to land it.
  function runSearch(term) {
    recentSection.hidden = true;
    filterBar.hidden = false;
    reflectStateInAddressBar('#/search?q=' + encodeURIComponent(term));
    abortInFlight();
    const thisRequest = ++requestId;
    status.textContent = 'Searching…';
    results.textContent = '';

    const moviesSlot = el('div', 'jellio-search-type-slot');
    const seriesSlot = el('div', 'jellio-search-type-slot');
    const booksSlot = el('div', 'jellio-search-type-slot');
    const audiobooksSlot = el('div', 'jellio-search-type-slot');
    const mangaSlot = el('div', 'jellio-search-type-slot');
    results.appendChild(moviesSlot);
    results.appendChild(seriesSlot);
    results.appendChild(booksSlot);
    results.appendChild(audiobooksSlot);
    results.appendChild(mangaSlot);

    currentSlots = { moviesSlot: moviesSlot, seriesSlot: seriesSlot, booksSlot: booksSlot, audiobooksSlot: audiobooksSlot, mangaSlot: mangaSlot };
    applyCategoryFilter();

    let settledCount = 0;
    let anyResults = false;
    let fellBack = false;

    function maybeFinishStatus() {
      if (thisRequest !== requestId) return;
      settledCount += 1;
      if (settledCount < 5) return;
      status.textContent = anyResults ? '' : 'No results for “' + term + '”.';
    }

    // Real servers without Gelato installed (or on an older build
    // without these two routes yet) 404 here: fall back to the original
    // combined call so search still works there, same real result that
    // call always gave, just without the incremental split.
    function fallBackToCombined(err) {
      if (thisRequest !== requestId || fellBack) return;
      fellBack = true;
      console.warn('Jellio: per-type search unavailable, falling back to combined search', err);
      const controller = new AbortController();
      inFlight.push(controller);
      searchItems(term, undefined, controller.signal)
        .then(function (items) {
          if (thisRequest !== requestId) return;
          moviesSlot.textContent = '';
          seriesSlot.textContent = '';
          const movies = items.filter(function (item) { return item.Type === 'Movie'; });
          const series = items.filter(function (item) { return item.Type === 'Series'; });
          if (movies.length || series.length) anyResults = true;
          const movieSection = buildTypeSection('Movies', movies);
          if (movieSection) moviesSlot.appendChild(movieSection);
          const seriesSection = buildTypeSection('Series', series);
          if (seriesSection) seriesSlot.appendChild(seriesSection);
          status.textContent = anyResults ? '' : 'No results for “' + term + '”.';
        })
        .catch(function (fallbackErr) {
          if (thisRequest !== requestId) return;
          console.warn('Jellio: combined search fallback also failed', fallbackErr);
          status.textContent = describeNetworkFailure('search results', fallbackErr);
        });
    }

    function runOne(fetcher, slot, title) {
      const controller = new AbortController();
      inFlight.push(controller);
      fetcher(term, controller.signal)
        .then(function (items) {
          if (thisRequest !== requestId) return;
          if (fellBack && (title === 'Movies' || title === 'Series')) return;
          if (items.length) anyResults = true;
          const section = buildTypeSection(title, items);
          if (section) slot.appendChild(section);
          maybeFinishStatus();
        })
        .catch(function (err) {
          if (thisRequest !== requestId) return;
          if (err && err.status === 404 && (title === 'Movies' || title === 'Series')) {
            fallBackToCombined(err);
            return;
          }
          if (fellBack && (title === 'Movies' || title === 'Series')) return;
          console.warn('Jellio: ' + title.toLowerCase() + ' search failed', err);
          const note = document.createElement('p');
          note.className = 'jellio-service-empty jellio-search-status';
          note.textContent = describeNetworkFailure(title.toLowerCase() + ' results', err);
          slot.appendChild(note);
          maybeFinishStatus();
        });
    }

    runOne(searchMovies, moviesSlot, 'Movies');
    runOne(searchSeries, seriesSlot, 'Series');
    runOne(searchBooks, booksSlot, 'Books');
    runOne(searchAudiobooks, audiobooksSlot, 'Audiobooks');
    searchMangaLibrary(term)
      .then(function (matches) {
        if (thisRequest !== requestId) return;
        if (matches.length) {
          anyResults = true;
          mangaSlot.appendChild(buildMangaSection(matches));
          status.textContent = '';
        }
        maybeFinishStatus();
      })
      .catch(function () {
        if (thisRequest === requestId) maybeFinishStatus();
      });
  }

  function commitCurrentSearch() {
    if (saveTimer) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
    }
    const term = input.value.trim();
    if (term.length >= 2) {
      saveRecentSearch(term);
    }
  }

  input.addEventListener('input', function () {
    if (timer) window.clearTimeout(timer);
    if (saveTimer) window.clearTimeout(saveTimer);
    const term = input.value.trim();
    if (!term) {
      reflectStateInAddressBar('#/search');
      requestId += 1;
      abortInFlight();
      results.textContent = '';
      status.textContent = '';
      filterBar.hidden = true;
      paintRecentSearches();
      return;
    }
    timer = window.setTimeout(function () {
      runSearch(term);
    }, DEBOUNCE_MS);
    saveTimer = window.setTimeout(function () {
      saveRecentSearch(term);
    }, 1500);
  });

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      if (timer) {
        window.clearTimeout(timer);
        timer = null;
      }
      const term = input.value.trim();
      if (term) {
        runSearch(term);
      }
      commitCurrentSearch();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (timer) {
        window.clearTimeout(timer);
        timer = null;
      }
      if (saveTimer) {
        window.clearTimeout(saveTimer);
        saveTimer = null;
      }
      input.value = '';
      reflectStateInAddressBar('#/search');
      requestId += 1;
      abortInFlight();
      results.textContent = '';
      status.textContent = '';
      filterBar.hidden = true;
      paintRecentSearches();
    }
  });

  input.addEventListener('blur', function () {
    commitCurrentSearch();
  });

  results.addEventListener('click', function () {
    commitCurrentSearch();
  });

  // A real back navigation landing back on #/search?q=... (a card's own
  // click handler pushed a real new history entry on top of whatever
  // runSearch() last reflected here) remounts this whole screen fresh,
  // same as any other route change; params carries that same term back
  // in, so the query and its results reappear immediately rather than a
  // reader having to type the whole thing again.
  const restoredTerm = (params && params.get('q')) || '';
  if (restoredTerm) {
    input.value = restoredTerm;
    runSearch(restoredTerm);
  } else {
    paintRecentSearches();
  }

  input.focus();
}
