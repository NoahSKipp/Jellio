// Bootstrap: mounts Jellio's own root container over the native page,
// renders the persistent sidebar alongside whichever screen owns the
// current route. An unmigrated route (no entry in SCREENS) leaves native
// jellyfin-web showing underneath, untouched, real fallback rather than a
// broken page.
import { isAuthenticated } from './runtime/auth.js';
import { renderHome } from './screens/home.js';
import { renderLibrary } from './screens/library.js';
import { renderSearch } from './screens/search.js';
import { renderSidebar } from './components/sidebar.js';
import { onRouteChange, parseRoute } from './runtime/router.js';

const ROOT_ID = 'jellioRoot';

// Every route path this runtime has a real screen for. Library routes
// (movies/tv/music/books/homevideos/musicvideos, plus the generic list
// fallback) are the same set components/sidebar.js's own LIBRARY_ROUTES
// can produce, kept in sync by hand since there are only the two places.
const SCREENS = {
  home: renderHome,
  search: renderSearch,
  movies: renderLibrary,
  tv: renderLibrary,
  music: renderLibrary,
  books: renderLibrary,
  homevideos: renderLibrary,
  musicvideos: renderLibrary,
  list: renderLibrary,
};

function getRoot() {
  let root = document.getElementById(ROOT_ID);
  if (!root) {
    root = document.createElement('div');
    root.id = ROOT_ID;
    root.innerHTML =
      '<div class="jellio-shell">' +
      '<nav class="jellio-sidebar-mount"></nav>' +
      '<main class="jellio-content"></main>' +
      '</div>';
    document.body.appendChild(root);
  }
  return root;
}

function hide() {
  const root = document.getElementById(ROOT_ID);
  if (root) {
    root.classList.remove('jellio-root-visible');
  }
}

async function sync() {
  try {
    const route = parseRoute();
    const screen = SCREENS[route.path];

    if (!screen || !isAuthenticated()) {
      hide();
      return;
    }

    const root = getRoot();
    root.classList.add('jellio-root-visible');

    const sidebarMount = root.querySelector('.jellio-sidebar-mount');
    const content = root.querySelector('.jellio-content');

    await Promise.all([renderSidebar(sidebarMount), screen(content, route.params)]);
  } catch (err) {
    console.warn('Jellio: screen render failed, falling back to native page', err);
    hide();
  }
}

onRouteChange(sync);
