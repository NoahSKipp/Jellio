// Own search, not a reskin of native SearchFields.tsx: a plain text input
// against the same real /Items?searchTerm= query every other screen's own
// grid already uses. Debounced locally, does not push a route on every
// keystroke, native jellyfin-web's own hash history has no reason to grow
// one entry per character typed.
import { searchItems } from '../runtime/api.js';
import { buildCard } from '../components/card.js';

const DEBOUNCE_MS = 300;

export async function renderSearch(root) {
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

  const grid = document.createElement('div');
  grid.className = 'jellio-library-grid';
  root.appendChild(grid);

  let timer = null;
  let requestId = 0;

  function runSearch(term) {
    const thisRequest = ++requestId;
    searchItems(term)
      .then(function (items) {
        if (thisRequest !== requestId) return;
        grid.textContent = '';
        items.forEach(function (item) {
          grid.appendChild(buildCard(item));
        });
      })
      .catch(function (err) {
        console.warn('Jellio: search failed', err);
      });
  }

  input.addEventListener('input', function () {
    if (timer) window.clearTimeout(timer);
    const term = input.value.trim();
    if (!term) {
      grid.textContent = '';
      return;
    }
    timer = window.setTimeout(function () {
      runSearch(term);
    }, DEBOUNCE_MS);
  });

  input.focus();
}
