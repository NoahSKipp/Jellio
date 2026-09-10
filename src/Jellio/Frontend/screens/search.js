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
import { searchItems, searchMovies, searchSeries } from '../runtime/api.js';
import { buildCard } from '../components/card.js';
import { appendCardsLazily } from '../components/lazyGrid.js';
import { describeNetworkFailure } from '../runtime/network.js';
import { reflectStateInAddressBar } from '../runtime/router.js';
import { el } from '../runtime/dom.js';

const DEBOUNCE_MS = 300;

export async function renderSearch(root, params) {
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-search';

  const header = document.createElement('header');
  header.className = 'jellio-search-header';

  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'jellio-search-input';
  input.placeholder = 'Search movies and shows';
  input.setAttribute('aria-label', 'Search movies and shows');
  input.autofocus = true;
  header.appendChild(input);
  root.appendChild(header);

  // No feedback at all between "typed something" and "cards appeared"
  // used to make a slow or failed request (Gelato resolving a remote
  // catalog is not instant, and a real server error left the grid
  // exactly as empty as it started) look identical to search doing
  // nothing whatsoever, reported live as exactly that. This one line
  // is the whole fix: every branch below now leaves it saying
  // something a reader can tell apart from silence.
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
    reflectStateInAddressBar('#/search?q=' + encodeURIComponent(term));
    abortInFlight();
    const thisRequest = ++requestId;
    status.textContent = 'Searching…';
    results.textContent = '';

    const moviesSlot = el('div', 'jellio-search-type-slot');
    const seriesSlot = el('div', 'jellio-search-type-slot');
    results.appendChild(moviesSlot);
    results.appendChild(seriesSlot);

    let settledCount = 0;
    let anyResults = false;
    let fellBack = false;

    function maybeFinishStatus() {
      if (thisRequest !== requestId) return;
      settledCount += 1;
      if (settledCount < 2 || fellBack) return;
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
          const movieSection = buildTypeSection('Movies', movies);
          if (movieSection) moviesSlot.appendChild(movieSection);
          const seriesSection = buildTypeSection('Series', series);
          if (seriesSection) seriesSlot.appendChild(seriesSection);
          status.textContent = items.length ? '' : 'No results for “' + term + '”.';
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
          if (thisRequest !== requestId || fellBack) return;
          if (items.length) anyResults = true;
          const section = buildTypeSection(title, items);
          if (section) slot.appendChild(section);
          maybeFinishStatus();
        })
        .catch(function (err) {
          if (thisRequest !== requestId || fellBack) return;
          if (err && err.status === 404) {
            fallBackToCombined(err);
            return;
          }
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
  }

  input.addEventListener('input', function () {
    if (timer) window.clearTimeout(timer);
    const term = input.value.trim();
    if (!term) {
      reflectStateInAddressBar('#/search');
      requestId += 1;
      abortInFlight();
      results.textContent = '';
      status.textContent = '';
      return;
    }
    timer = window.setTimeout(function () {
      runSearch(term);
    }, DEBOUNCE_MS);
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
  }

  input.focus();
}
