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
import { searchItems } from '../runtime/api.js';
import { buildCard } from '../components/card.js';
import { appendCardsLazily } from '../components/lazyGrid.js';
import { describeNetworkFailure } from '../runtime/network.js';
import { reflectStateInAddressBar } from '../runtime/router.js';

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

  const grid = document.createElement('div');
  grid.className = 'jellio-library-grid';
  root.appendChild(grid);

  let timer = null;
  let requestId = 0;
  // Gelato's own search proxies straight through to AIOStreams live, one
  // real round trip per addon per request, nothing cached: a reader who
  // edits their query mid-search used to leave the old one running to its
  // own full 30s timeout in the background regardless, stacking up
  // concurrent AIOStreams round trips for a result nothing still wants.
  // Aborting it outright the moment a newer query fires frees that
  // connection and backend load immediately instead of waiting it out.
  let inFlight = null;

  function runSearch(term) {
    reflectStateInAddressBar('#/search?q=' + encodeURIComponent(term));
    if (inFlight) inFlight.abort();
    const controller = new AbortController();
    inFlight = controller;
    const thisRequest = ++requestId;
    status.textContent = 'Searching…';
    searchItems(term, undefined, controller.signal)
      .then(function (items) {
        if (thisRequest !== requestId) return;
        grid.textContent = '';
        appendCardsLazily(grid, items, buildCard);
        status.textContent = items.length ? '' : 'No results for “' + term + '”.';
      })
      .catch(function (err) {
        if (thisRequest !== requestId) return;
        console.warn('Jellio: search failed', err);
        grid.textContent = '';
        status.textContent = describeNetworkFailure('search results', err);
      });
  }

  input.addEventListener('input', function () {
    if (timer) window.clearTimeout(timer);
    const term = input.value.trim();
    if (!term) {
      reflectStateInAddressBar('#/search');
      requestId += 1;
      if (inFlight) inFlight.abort();
      grid.textContent = '';
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
