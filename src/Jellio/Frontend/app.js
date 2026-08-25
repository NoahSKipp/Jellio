// Bootstrap: mounts Jellio's own root container over the native page,
// renders the persistent sidebar alongside whichever screen owns the
// current route. An unmigrated route (no entry in SCREENS) leaves native
// jellyfin-web showing underneath, untouched, real fallback rather than a
// broken page.
import { isAuthenticated, loginScreenBypassed } from './runtime/auth.js';
import { getUserViews, getCollections, getCurrentUser } from './runtime/api.js';
import { renderLogin } from './screens/login.js';
import { renderHome } from './screens/home.js';
import { renderLibrary } from './screens/library.js';
import { renderSearch } from './screens/search.js';
import { renderDetail } from './screens/detail.js';
import { renderPlayer } from './screens/player.js';
import { renderService } from './screens/service.js';
import { renderSettings } from './screens/settings.js';
import { renderPerson } from './screens/person.js';
import { renderSidebar } from './components/sidebar.js';
import { startNowPlaying } from './components/nowPlaying.js';
import { showSplash, hideSplash } from './components/splash.js';
import { onRouteChange, parseRoute } from './runtime/router.js';

const ROOT_ID = 'jellioRoot';

// Content fades in on every screen swap, ported as a real feature
// rather than the "not smooth" real feedback left it: getRoot() below
// already rebuilds .jellio-content fresh on every navigation, so this
// is imperative (content.animate(), the Web Animations API) rather
// than a CSS class, since a screen's own render function always
// overwrites content.className wholesale (root.className = 'jellio-
// content jellio-screen-home', for one real example) the instant it
// runs, which would wipe a class added here before ever painting.
// matchMedia is read once at module load rather than kept reactive:
// this app does not need to notice an OS setting flip mid session, and
// prefers-reduced-motion changing back and forth inside one is not a
// real case to design around.
const REDUCED_MOTION = Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

function fadeInContent(content) {
  if (REDUCED_MOTION || !content || typeof content.animate !== 'function') return;
  content.animate(
    [
      { opacity: 0, transform: 'translateY(10px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ],
    { duration: 260, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' },
  );
}

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
  person: renderPerson,
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

// The inner shell used to be built only at the moment #jellioRoot itself
// was first created, on the assumption a node already in the document
// keeps whatever it was given. Reported live, twice: on a real install,
// a later render found #jellioRoot still present but its sidebar mount
// gone (something outside this codebase's own DOM writes clears it,
// every write this codebase makes to that structure was checked, none
// of them remove it), and renderSidebar crashed reading
// null.textContent on the missing node. sync()'s own catch-all then
// treated that crash as a real reason to fall back to native, so the
// whole reskin dropped out from under a signed-in session. A first fix
// only rebuilt the shell when .jellio-shell itself was gone, which
// missed the case seen live a second time: the .jellio-shell wrapper
// survived while just the sidebar mount and content div inside it did
// not, so that check still found "a shell" and skipped rebuilding.
// Rebuilding the inner structure on every call sidesteps having to know
// which element vanishes: every screen and renderSidebar already clear
// and repopulate their own container the moment they run, so handing
// them a freshly built empty one each time costs nothing real, and
// there is no in between paint for a rebuild to visibly flash.
function getRoot() {
  let root = document.getElementById(ROOT_ID);
  if (!root) {
    root = document.createElement('div');
    root.id = ROOT_ID;
    document.body.appendChild(root);
  }
  root.innerHTML =
    '<div class="jellio-shell">' +
    '<nav class="jellio-sidebar-mount"></nav>' +
    '<main class="jellio-content"></main>' +
    '</div>';
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

// jellio:session-captured can fire a second sync() while an
// already-authenticated visit's own initial sync() is still awaiting its
// screen's data (real case: a returning user, since the credential log
// this event chases fires on every load, not only fresh logins, see
// Services/IndexHtmlPatchService.cs). Both calls share the same content
// element, so an overlapping second call's own root.textContent = ''
// wipes whatever the first call already inserted, while the first call
// keeps appending into the DOM node it originally grabbed a reference
// to, now detached and invisible. Real bug: on a returning user this
// left the page showing only whatever had rendered before the second
// wipe (the greeting, quick) with every row still populating an orphaned
// element. Queueing keeps exactly one sync() body running at a time and
// coalesces any call that arrives mid-render into a single rerun after,
// rather than letting two renders interleave into the same DOM.
let syncRunning = false;
let syncQueued = false;

async function sync() {
  if (syncRunning) {
    syncQueued = true;
    return;
  }
  syncRunning = true;
  try {
    do {
      syncQueued = false;
      await runSync();
    } while (syncQueued);
  } finally {
    syncRunning = false;
  }
}

// Not authenticated is this runtime's own login screen now, real
// endpoints only (auth.js's own authenticateByName/quickSignIn), not a
// fall back to native's login page: unlike a route this codebase has
// simply not migrated yet, there is nothing native could do here that
// this runtime cannot already do itself, and staying on native's own
// login page is what the previous codebase's quick sign-in work was
// actually trying to route around in the first place.
async function renderUnauthenticated() {
  teardownActiveScreen();

  const root = getRoot();
  root.classList.add('jellio-root-visible', 'jellio-root-fullscreen');

  const sidebarMount = root.querySelector('.jellio-sidebar-mount');
  sidebarMount.textContent = '';
  sidebarMount.className = 'jellio-sidebar-mount';

  const content = root.querySelector('.jellio-content');
  const result = await renderLogin(content);
  activeCleanup = typeof result === 'function' ? result : null;
  fadeInContent(content);
}

// Every screen's own real cost, on this run and every one after it, is
// the sidebar's own three calls (runtime/api.js's own cache makes the
// after-this-one cost free): shown once, right after a real session is
// confirmed, so the very first authenticated paint already has warm
// data instead of the sidebar and the first screen both racing the
// network cold. A hard cap keeps a slow network from holding the
// reader on a blank splash indefinitely: showing the app with a cold
// cache is a worse first paint than what came before this, but still
// better than one that never arrives.
const PRELOAD_TIMEOUT_MS = 4000;
let preloaded = false;

function withTimeout(promise, ms) {
  return new Promise(function (resolve) {
    const timer = window.setTimeout(resolve, ms);
    promise.then(
      function () {
        window.clearTimeout(timer);
        resolve();
      },
      function () {
        window.clearTimeout(timer);
        resolve();
      },
    );
  });
}

async function preloadInitialData() {
  showSplash();
  await withTimeout(
    Promise.all([getUserViews(), getCollections(), getCurrentUser()]),
    PRELOAD_TIMEOUT_MS,
  );
  hideSplash();
}

async function runSync() {
  try {
    if (!isAuthenticated()) {
      if (loginScreenBypassed()) {
        teardownActiveScreen();
        hide();
        return;
      }
      await renderUnauthenticated();
      return;
    }

    if (!preloaded) {
      preloaded = true;
      await preloadInitialData();
    }

    const route = parseRoute();
    const screen = SCREENS[route.path];

    if (!screen) {
      teardownActiveScreen();
      hide();
      return;
    }

    teardownActiveScreen();
    startNowPlaying();

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
    fadeInContent(content);
  } catch (err) {
    console.warn('Jellio: screen render failed, falling back to native page', err);
    hide();
  }
}

onRouteChange(sync);

// The early inline script IndexHtmlPatchService injects ahead of this
// module captures a native login's own token synchronously, but still
// resolves the full user object with its own async fetch, which can
// still be in flight when this module's own first sync() call already
// ran and found no session yet. This event fires once that fetch
// finishes, so the very first render happens as soon as a session is
// real rather than waiting on a hashchange that may never come.
document.addEventListener('jellio:session-captured', sync);

// Best effort: a report sent from here can still be dropped by the
// browser before it lands, the same real limitation every other Jellyfin
// client's own beforeunload reporting already has, not something this
// runtime can fully solve either.
window.addEventListener('beforeunload', teardownActiveScreen);
