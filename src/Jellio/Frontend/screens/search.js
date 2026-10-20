import { t } from '../runtime/i18n.js';
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
import { searchItems, searchLibrary, searchMovies, searchSeries } from '../runtime/api.js';
import { buildCard } from '../components/card.js';
import { buildSkeletonRow } from '../components/homeSkeleton.js';
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


export async function renderSearch(root, params) {
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-search';

  const header = document.createElement('header');
  header.className = 'jellio-search-header';

  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'jellio-search-input';
  input.placeholder = t('search_placeholder');
  input.setAttribute('aria-label', t('search_placeholder'));
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
    recentHeader.appendChild(el('span', 'jellio-search-recent-title', t('search_recent_title')));
    const clearBtn = el('button', 'jellio-search-recent-clear', t('search_clear_all'));
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
    { id: 'all', label: t('search_filter_all') },
    { id: 'movies', label: t('search_filter_movies') },
    { id: 'series', label: t('search_filter_shows') },
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
  // Each type fills in as answers arrive: titles already in the library
  // (searchLibrary, near instant) first, then the addon search's results
  // appended after them, nothing shown twice and nothing reordered under
  // the pointer. Placeholder cards sit at the end while a type is still
  // loading.
  const SEARCH_SKELETON_CARDS = 4;

  function identityKeys(item) {
    const keys = ['id:' + String(item.Id || '').replace(/-/g, '').toLowerCase()];
    const ids = item.ProviderIds || {};
    ['Tmdb', 'Imdb', 'Tvdb'].forEach(function (provider) {
      const value = ids[provider] || ids[provider.toLowerCase()];
      if (value) keys.push(item.Type + ':' + provider + ':' + value);
    });
    if (item.Name && item.ProductionYear) keys.push(item.Type + ':name:' + item.Name.trim().toLowerCase() + ':' + item.ProductionYear);
    return keys;
  }

  function createTypeState(slot, title) {
    return { slot: slot, title: title, section: null, grid: null, seen: new Set(), pending: 0, failed: null };
  }

  function addItems(state, items) {
    const fresh = items.filter(function (item) {
      const keys = identityKeys(item);
      if (keys.some(function (key) { return state.seen.has(key); })) return false;
      keys.forEach(function (key) { state.seen.add(key); });
      return true;
    });
    if (fresh.length) {
      if (!state.section) {
        state.slot.textContent = '';
        state.section = el('section', 'jellio-row');
        state.section.appendChild(el('h2', 'jellio-row-title', state.title));
        state.grid = el('div', 'jellio-library-grid');
        state.section.appendChild(state.grid);
        state.slot.appendChild(state.section);
      }
      const firstPlaceholder = state.grid.querySelector('.jellio-search-skeleton-card');
      fresh.forEach(function (item) {
        state.grid.insertBefore(buildCard(item), firstPlaceholder);
      });
    }
    paintLoading(state);
    return fresh.length;
  }

  function paintLoading(state) {
    if (state.section) {
      const placeholders = state.grid.querySelectorAll('.jellio-search-skeleton-card');
      if (state.pending > 0 && !placeholders.length) {
        for (let i = 0; i < SEARCH_SKELETON_CARDS; i++) {
          state.grid.appendChild(el('div', 'jellio-search-skeleton-card jellio-shimmer'));
        }
      } else if (state.pending === 0) {
        placeholders.forEach(function (node) { node.remove(); });
      }
      return;
    }
    state.slot.textContent = '';
    if (state.pending > 0) {
      state.slot.appendChild(buildSkeletonRow());
    } else if (state.failed) {
      const note = document.createElement('p');
      note.className = 'jellio-service-empty jellio-search-status';
      note.textContent = describeNetworkFailure(state.title.toLowerCase() + ' results', state.failed);
      state.slot.appendChild(note);
    }
  }

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
    results.appendChild(moviesSlot);
    results.appendChild(seriesSlot);
    currentSlots = { moviesSlot: moviesSlot, seriesSlot: seriesSlot };
    applyCategoryFilter();

    const movies = createTypeState(moviesSlot, 'Movies');
    const series = createTypeState(seriesSlot, 'Series');
    // The library search and the type's own addon search.
    movies.pending = 2;
    series.pending = 2;
    paintLoading(movies);
    paintLoading(series);

    let anyResults = false;
    let fellBack = false;

    function current() {
      return thisRequest === requestId;
    }

    function add(items) {
      const movieCount = addItems(movies, items.filter(function (item) { return item.Type === 'Movie'; }));
      const seriesCount = addItems(series, items.filter(function (item) { return item.Type === 'Series'; }));
      if (movieCount || seriesCount) anyResults = true;
    }

    function settle(state) {
      state.pending = Math.max(0, state.pending - 1);
      paintLoading(state);
      if (movies.pending === 0 && series.pending === 0) {
        status.textContent = anyResults ? '' : 'No results for “' + term + '”.';
      }
    }

    function request(fetcher) {
      const controller = new AbortController();
      inFlight.push(controller);
      return fetcher(term, controller.signal);
    }

    // Real servers without Gelato installed (or on an older build
    // without these two routes yet) 404 on the per-type search, and the
    // "local:" library search matches nothing there: the plain combined
    // search answers for both types instead.
    function fallBackToCombined(err) {
      if (!current() || fellBack) return;
      fellBack = true;
      console.warn('Jellio: per-type search unavailable, falling back to combined search', err);
      request(function (t, signal) { return searchItems(t, undefined, signal); })
        .then(function (items) {
          if (!current()) return;
          add(items);
        })
        .catch(function (fallbackErr) {
          if (!current()) return;
          console.warn('Jellio: combined search fallback also failed', fallbackErr);
          movies.failed = movies.failed || fallbackErr;
          series.failed = series.failed || fallbackErr;
        })
        .finally(function () {
          if (!current()) return;
          settle(movies);
          settle(series);
        });
    }

    request(searchLibrary)
      .then(function (items) {
        if (current()) add(items);
      })
      .catch(function (err) {
        if (current()) console.warn('Jellio: library search failed', err);
      })
      .finally(function () {
        if (!current()) return;
        settle(movies);
        settle(series);
      });

    function runOne(fetcher, state) {
      request(fetcher)
        .then(function (items) {
          if (!current() || fellBack) return;
          add(items);
          settle(state);
        })
        .catch(function (err) {
          if (!current()) return;
          if (err && err.status === 404) {
            // Settled by the fallback, which answers for both types.
            fallBackToCombined(err);
            return;
          }
          if (fellBack) return;
          console.warn('Jellio: ' + state.title.toLowerCase() + ' search failed', err);
          state.failed = err;
          settle(state);
        });
    }

    runOne(searchMovies, movies);
    runOne(searchSeries, series);
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
