import { t } from '../runtime/i18n.js';
import { getSearchSuggestions, searchItems, searchLibrary, searchMovies, searchSeries, getSeriesNextUp } from '../runtime/api.js';
import { createSearchWarmer } from '../runtime/streamWarmup.js';
import { warmBatch, cancelWarmGroup } from '../runtime/warmQueue.js';
import { buildRow } from '../components/row.js';
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
  let inFlight = [];

  // The top results' stream lists are warmed once they stop changing.
  const SEARCH_WARM_COUNT = 3;
  const searchWarmer = createSearchWarmer({
    schedule: function (fn, ms) {
      return window.setTimeout(fn, ms);
    },
    cancel: function (timer) {
      window.clearTimeout(timer);
    },
    settleMs: 600,
    onQueryChanged: function () {
      cancelWarmGroup('search');
    },
    onSettled: function (items) {
      const mine = requestId;
      const top = items
        .filter(function (item) {
          return item && item.Id && (item.Type === 'Movie' || item.Type === 'Episode' || item.Type === 'Series');
        })
        .slice(0, SEARCH_WARM_COUNT);
      // A series plays its next (or first) episode; one not in the library
      // yet is sent as is, which adds it.
      Promise.all(
        top.map(function (item) {
          if (item.Type !== 'Series') return item.Id;
          return getSeriesNextUp(item.Id).then(
            function (episode) {
              return (episode && episode.Id) || item.Id;
            },
            function () {
              return item.Id;
            },
          );
        }),
      ).then(function (ids) {
        if (mine === requestId) warmBatch(ids, 'search');
      });
    },
    onFocused: function () {},
  });

  function abortInFlight() {
    inFlight.forEach(function (controller) {
      controller.abort();
    });
    inFlight = [];
  }

  const SEARCH_SKELETON_CARDS = 4;

  function identityKeys(item) {
    const rawId = item.Id || item.id || '';
    const keys = ['id:' + String(rawId).replace(/-/g, '').toLowerCase()];
    const ids = item.ProviderIds || item.providerIds || {};
    const itemType = item.Type || item.type || '';
    ['Tmdb', 'Imdb', 'Tvdb'].forEach(function (provider) {
      const value = ids[provider] || ids[provider.toLowerCase()];
      if (value) keys.push(itemType + ':' + provider + ':' + value);
    });
    const name = item.Name || item.name;
    const year = item.ProductionYear || item.year;
    if (name && year) keys.push(itemType + ':name:' + name.trim().toLowerCase() + ':' + year);
    return keys;
  }

  function createTypeState(slot, title) {
    return { slot: slot, title: title, section: null, grid: null, seen: new Set(), items: [], pending: 0, failed: null };
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
        state.items.push(item);
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
    searchWarmer.query();
    const thisRequest = ++requestId;
    status.textContent = t('status_loading');
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
      if (movieCount || seriesCount) {
        anyResults = true;
        searchWarmer.results(movies.items.concat(series.items));
      }
    }

    function settle(state) {
      state.pending = Math.max(0, state.pending - 1);
      paintLoading(state);
      if (movies.pending === 0 && series.pending === 0) {
        status.textContent = anyResults ? '' : 'No results for “' + term + '”.';
        if (!anyResults) showSuggestions();
      }
    }

    // Nothing found: titles related to what the search names, the way
    // Netflix answers a title it doesn't carry.
    function showSuggestions() {
      getSearchSuggestions(term)
        .then(function (answer) {
          if (!current() || !answer.Rows || !answer.Rows.length) return;
          if (answer.MatchedTitle) {
            status.textContent = t('search_suggest_intro', { title: answer.MatchedTitle });
          }
          answer.Rows.forEach(function (row) {
            const title =
              row.Kind === 'similar'
                ? t('search_suggest_similar', { title: answer.MatchedTitle || term })
                : row.Kind === 'person'
                  ? t('search_suggest_person', { name: row.Name })
                  : t('search_suggest_genre', { name: row.Name });
            const built = buildRow(title, row.Items || []);
            if (built) results.appendChild(built);
          });
        })
        .catch(function (err) {
          console.warn('Jellio: search suggestions failed', err);
        });
    }

    function request(fetcher) {
      const controller = new AbortController();
      inFlight.push(controller);
      return fetcher(term, controller.signal);
    }

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
      searchWarmer.query();
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
      searchWarmer.query();
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

  const restoredTerm = (params && params.get('q')) || '';
  if (restoredTerm) {
    input.value = restoredTerm;
    runSearch(restoredTerm);
  } else {
    paintRecentSearches();
  }

  input.focus();
}
