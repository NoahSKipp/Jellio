// Bootstrap: mounts Jellio's own root container over the native page,
// renders the persistent sidebar alongside whichever screen owns the
// current route. An unmigrated route (no entry in SCREENS) leaves native
// jellyfin-web showing underneath, untouched, real fallback rather than a
// broken page.
import { isAuthenticated } from './runtime/auth.js';
import { renderHome } from './screens/home.js';
import { renderLibrary } from './screens/library.js';
import { renderSearch } from './screens/search.js';
import { renderDetail } from './screens/detail.js';
import { renderPlayer } from './screens/player.js';
import { renderService } from './screens/service.js';
import { renderSettings } from './screens/settings.js';
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
  item: renderDetail,
  play: renderPlayer,
  service: renderService,
  account: renderSettings,
  movies: renderLibrary,
  tv: renderLibrary,
  music: renderLibrary,
  books: renderLibrary,
  homevideos: renderLibrary,
  musicvideos: renderLibrary,
  list: renderLibrary,
};

// The player owns the whole viewport, no persistent sidebar competing
// with video controls for space or attention.
const FULLSCREEN_ROUTES = new Set(['play']);

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

// Set by whichever screen last rendered, if it needs to know it is being
// torn down (the player's own real need: stop the video and report the
// stopped position before the next screen, or native rendering, takes
// over). Screens with nothing to clean up simply return nothing.
let activeCleanup = null;

function teardownActiveScreen() {
  if (activeCleanup) {
    try {
      activeCleanup();
    } catch (err) {
      console.warn('Jellio: screen cleanup failed', err);
    }
    activeCleanup = null;
  }
}

async function sync() {
  try {
    const route = parseRoute();
    const screen = SCREENS[route.path];

    if (!screen || !isAuthenticated()) {
      teardownActiveScreen();
      hide();
      return;
    }

    teardownActiveScreen();

    const root = getRoot();
    root.classList.add('jellio-root-visible');
    root.classList.toggle('jellio-root-fullscreen', FULLSCREEN_ROUTES.has(route.path));

    const sidebarMount = root.querySelector('.jellio-sidebar-mount');
    const content = root.querySelector('.jellio-content');

    const tasks = [screen(content, route.params)];
    if (FULLSCREEN_ROUTES.has(route.path)) {
      sidebarMount.textContent = '';
      sidebarMount.className = 'jellio-sidebar-mount';
    } else {
      tasks.push(renderSidebar(sidebarMount));
    }

    const results = await Promise.all(tasks);
    activeCleanup = typeof results[0] === 'function' ? results[0] : null;
  } catch (err) {
    console.warn('Jellio: screen render failed, falling back to native page', err);
    hide();
  }
}

onRouteChange(sync);

// Best effort: a report sent from here can still be dropped by the
// browser before it lands, the same real limitation every other Jellyfin
// client's own beforeunload reporting already has, not something this
// runtime can fully solve either.
window.addEventListener('beforeunload', teardownActiveScreen);
