import { t, loadDisplayLanguage } from './runtime/i18n.js';
import { isAuthenticated, loginScreenBypassed, clearSession } from './runtime/auth.js';
import {
  getUserViews,
  getCollections,
  getCurrentUser,
  getHeroCandidates,
  itemTypesForKind,
  invalidateNavCaches,
  invalidateUserDataRows,
  loadServerPreferences,
} from './runtime/api.js';
import { renderLogin } from './screens/login.js';
import { transitionsAllowed } from './runtime/motionSettings.js';
import { renderHome, preloadHomeSections } from './screens/home.js';
import { checkServer, isOffline } from './runtime/offline.js';
import { renderSidebar } from './components/sidebar.js';
import { renderMobileNav } from './components/mobileNav.js';
import { getPrimaryNavLinks } from './components/navShared.js';
import { mountSeasons } from './components/seasons.js';
import { startNowPlaying } from './components/nowPlaying.js';
import { startNotifications } from './components/notifications.js';
import { startSounds } from './components/sounds.js';
import { startOverlays } from './components/overlays.js';
import { startAchievementNotifier } from './components/achievementNotifier.js';
import { loadGrouplistSetting } from './runtime/grouplistSettings.js';
import { loadAdminStatus } from './runtime/adminStatus.js';
import { loadSkipIntroCreditsMenuSetting } from './runtime/introCreditsMenuSetting.js';
import { startSyncPlay, onUserDataChange } from './runtime/syncPlay.js';
import { startGroupWatchInvites } from './components/groupWatchInvites.js';
import { showSplash, hideSplash, setSplashTotal, reportSplashStep } from './components/splash.js';
import { showToast } from './components/toast.js';
import { buildLibraryCoverflow } from './components/libraryCoverflow.js';
import { getHeroBackdropUrl, getHeroLogoUrl } from './components/heroCarousel.js';
import { syncMiniPlayer } from './components/audioMiniPlayer.js';
import { onRouteChange, parseRoute, setTitle, navigateTo } from './runtime/router.js';
import { shouldShowOnboarding, openOnboardingModal } from './components/onboardingModal.js';

const ROOT_ID = 'jellioRoot';

const REDUCED_MOTION = Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

function fadeInContent(content) {
  if (REDUCED_MOTION || !transitionsAllowed() || !content || typeof content.animate !== 'function') return;
  content.animate(
    [
      { opacity: 0, transform: 'translateY(10px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ],
    { duration: 260, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' },
  );
}

// Dynamic screen loaders: non-initial screens are imported on-demand to keep
// the initial script bundle and parse time minimal on cold boots.
const loadLibrary = () => import('./screens/library.js').then((m) => m.renderLibrary);
const loadSearch = () => import('./screens/search.js').then((m) => m.renderSearch);
const loadDetail = () => import('./screens/detail.js').then((m) => m.renderDetail);
const loadPlayer = () => import('./screens/player.js').then((m) => m.renderPlayer);
const loadService = () => import('./screens/service.js').then((m) => m.renderService);
const loadSettings = () => import('./screens/settings.js').then((m) => m.renderSettings);
const loadPerson = () => import('./screens/person.js').then((m) => m.renderPerson);
const loadProfile = () => import('./screens/profile.js').then((m) => m.renderProfile);
const loadFeed = () => import('./screens/feed.js').then((m) => m.renderFeed);
const loadReader = () => import('./screens/reader.js').then((m) => m.renderReader);
const loadListen = () => import('./screens/listen.js').then((m) => m.renderListen);
const loadVocab = () => import('./screens/vocab.js').then((m) => m.renderVocab);
const loadDiscover = () => import('./screens/discover.js').then((m) => m.renderDiscover);
const loadDownloads = () => import('./screens/downloads.js').then((m) => m.renderDownloads);

// Pre-warm common next screens during idle time after boot
if (typeof window !== 'undefined') {
  const scheduleIdle = window.requestIdleCallback
    ? (fn) => window.requestIdleCallback(fn, { timeout: 3000 })
    : (fn) => setTimeout(fn, 2000);
  scheduleIdle(() => {
    import('./screens/detail.js').catch(() => {});
    import('./screens/library.js').catch(() => {});
  });
}

const loadLiveTv = () => import('./screens/liveTv.js').then((m) => m.renderLiveTv);
const loadLivePlayer = () => import('./screens/livePlayer.js').then((m) => m.renderLivePlayer);

const SCREENS = {
  home: (content, params, signal) => renderHome(content, params, signal),
  search: async (content, params, signal) => (await loadSearch())(content, params, signal),
  item: async (content, params, signal) => (await loadDetail())(content, params, signal),
  play: async (content, params, signal) => (await loadPlayer())(content, params, signal),
  service: async (content, params, signal) => (await loadService())(content, params, signal),
  account: async (content, params, signal) => (await loadSettings())(content, params, signal),
  person: async (content, params, signal) => (await loadPerson())(content, params, signal),
  profile: async (content, params, signal) => (await loadProfile())(content, params, signal),
  feed: async (content, params, signal) => (await loadFeed())(content, params, signal),
  // The Calendar screen is gone; its entries are the Coming Soon row on
  // Home. Old links and bookmarks land there.
  livetv: async (content, params, signal) => (await loadLiveTv())(content, params, signal),
  live: async (content, params, signal) => (await loadLivePlayer())(content, params, signal),
  calendar: (content, params, signal) => {
    try {
      window.history.replaceState(null, '', '#/home');
    } catch (err) {}
    return renderHome(content, params, signal);
  },
  read: async (content, params, signal) => (await loadReader())(content, params, signal),
  listen: async (content, params, signal) => (await loadListen())(content, params, signal),
  vocab: async (content, params, signal) => (await loadVocab())(content, params, signal),
  discover: async (content, params, signal) => (await loadDiscover())(content, params, signal),
  downloads: async (content, params, signal) => (await loadDownloads())(content, params, signal),
  movies: async (content, params, signal) => (await loadLibrary())(content, params, signal),
  tv: async (content, params, signal) => (await loadLibrary())(content, params, signal),
  music: async (content, params, signal) => (await loadLibrary())(content, params, signal),
  books: async (content, params, signal) => (await loadLibrary())(content, params, signal),
  homevideos: async (content, params, signal) => (await loadLibrary())(content, params, signal),
  musicvideos: async (content, params, signal) => (await loadLibrary())(content, params, signal),
  list: async (content, params, signal) => (await loadLibrary())(content, params, signal),
};

// The player owns the whole viewport, no persistent sidebar competing
// with video controls for space or attention.
const FULLSCREEN_ROUTES = new Set(['play', 'read', 'listen', 'live']);

const OFFLINE_ROUTES = new Set(['downloads', 'read', 'listen', 'play']);

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker
    .register('/Jellio/frontend/sw.js', { scope: new URL('./', window.location.href).pathname })
    .catch(function (err) {
      console.warn('Jellio: offline support unavailable', err);
    });
}

// Whether the server answers, settled before the first render so an
// offline start goes straight to Downloads instead of failing screens.
const connectivityReady = checkServer();
let lastOnlineRoute = null;

document.addEventListener('jellio:connectivity', function (event) {
  const offline = event.detail && event.detail.offline;
  languageReady.then(function () {
    showToast(offline ? t('toast_offline') : t('toast_online'));
  });
  if (!offline) {
    lastNavLinksSignature = null;
    scheduleNavRecheck(2, 0);
    // If redirected to downloads solely due to going offline, restore previous route on reconnection.
    if (lastOnlineRoute && parseRoute().path === 'downloads') {
      const restoreHash = lastOnlineRoute;
      lastOnlineRoute = null;
      navigateTo(restoreHash);
      return;
    }
  }
  const path = parseRoute().path;
  if (path === 'read' || path === 'listen' || path === 'play' || path === 'live') return;
  lastRenderedRouteKey = null;
  sync();
});

// Back to the tab or app: a nav built while requests were being cut off
// in the background is missing the libraries; one quick look fixes it.
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible' && !isOffline() && isAuthenticated()) scheduleNavRecheck(1, 0);
});

function getRoot() {
  let root = document.getElementById(ROOT_ID);
  if (!root) {
    root = document.createElement('div');
    root.id = ROOT_ID;
    document.body.appendChild(root);
  }
  const shell = root.querySelector('.jellio-shell');
  const sidebarMount = shell && shell.querySelector('.jellio-sidebar-mount');
  const content = shell && shell.querySelector('.jellio-content');
  const mobileNavMount = root.querySelector('.jellio-mobile-nav-mount');
  if (!shell || !sidebarMount || !content || !mobileNavMount) {
    root.innerHTML =
      '<div class="jellio-shell">' +
      '<nav class="jellio-sidebar-mount"></nav>' +
      '<main class="jellio-content"></main>' +
      '</div>' +
      '<nav class="jellio-mobile-nav-mount"></nav>';
  }
  return root;
}

const MOBILE_NAV_QUERY = '(pointer: coarse), (max-width: 47.99em)';
const mobileNavQuery = window.matchMedia ? window.matchMedia(MOBILE_NAV_QUERY) : null;

function applyResponsiveNav() {
  const root = document.getElementById(ROOT_ID);
  if (!root) return;
  const sidebarMount = root.querySelector('.jellio-sidebar-mount');
  const mobileNavMount = root.querySelector('.jellio-mobile-nav-mount');
  if (!sidebarMount || !mobileNavMount) return;

  if (root.classList.contains('jellio-root-fullscreen')) {
    sidebarMount.style.display = 'none';
    mobileNavMount.style.display = 'none';
    return;
  }

  const mobile = Boolean(mobileNavQuery && mobileNavQuery.matches);
  sidebarMount.style.display = mobile ? 'none' : '';
  mobileNavMount.style.display = mobile ? 'flex' : 'none';
}

if (mobileNavQuery) {
  mobileNavQuery.addEventListener('change', applyResponsiveNav);
}

function hide() {
  const root = document.getElementById(ROOT_ID);
  if (root) {
    root.classList.remove('jellio-root-visible');
  }
}

let activeCleanup = null;

let lastRenderedRouteKey = null;
let activeScreenAbortController = null;

function routeKey(route) {
  return route.path + '?' + route.params.toString();
}

let renderToken = 0;

async function teardownActiveScreen() {
  // Any screen still mounting is stale now and cleans itself up when it resolves.
  renderToken++;
  if (activeScreenAbortController) {
    try {
      activeScreenAbortController.abort();
    } catch (err) {
      console.warn('Jellio: screen abort failed', err);
    }
    activeScreenAbortController = null;
  }
  if (activeCleanup) {
    try {
      await activeCleanup();
    } catch (err) {
      console.warn('Jellio: screen cleanup failed', err);
    }
    activeCleanup = null;
  }
  const root = document.getElementById(ROOT_ID);
  const content = root && root.querySelector('.jellio-content');
  if (content && (content.querySelector('.jellio-screen-loading') || content.querySelector('.jellio-screen-spinner'))) {
    content.textContent = '';
  }
}

let syncRunning = false;
let syncQueued = false;

async function sync() {
  if (syncRunning) {
    syncQueued = true;
    if (activeScreenAbortController) {
      try {
        activeScreenAbortController.abort();
      } catch (err) {
        console.warn('Jellio: screen abort failed', err);
      }
    }
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

async function renderUnauthenticated() {
  onboardingPrompted = false;
  await teardownActiveScreen();

  const root = getRoot();
  root.classList.add('jellio-root-visible', 'jellio-root-fullscreen');
  applyResponsiveNav();

  const sidebarMount = root.querySelector('.jellio-sidebar-mount');
  sidebarMount.textContent = '';
  sidebarMount.className = 'jellio-sidebar-mount';

  const mobileNavMount = root.querySelector('.jellio-mobile-nav-mount');
  mobileNavMount.textContent = '';
  mobileNavMount.className = 'jellio-mobile-nav-mount';

  const content = root.querySelector('.jellio-content');
  const result = await renderLogin(content);
  activeCleanup = typeof result === 'function' ? result : null;
  fadeInContent(content);
}

const PRELOAD_TIMEOUT_MS = 45000;
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

function prefetchImage(url, priority) {
  if (!url) return;
  const img = new Image();
  if (priority) img.fetchPriority = priority;
  img.src = url;
}

function prefetchLazyImages(roots, limit) {
  const images = [];
  (Array.isArray(roots) ? roots : [roots]).forEach(function (root) {
    images.push.apply(images, root.querySelectorAll('img[loading="lazy"]'));
  });
  const count = limit != null ? Math.min(limit, images.length) : images.length;
  for (let i = 0; i < count; i += 1) {
    prefetchImage(images[i].src);
  }
}

async function preloadHeroImages() {
  const heroItems = await getHeroCandidates(8);
  heroItems.forEach(function (item, index) {
    const priority = index === 0 ? 'high' : 'low';
    const backdropUrl = getHeroBackdropUrl(item);
    if (backdropUrl) prefetchImage(backdropUrl, priority);
    const logoUrl = getHeroLogoUrl(item);
    if (logoUrl) prefetchImage(logoUrl, priority);
  });
}

const HOME_PRELOAD_IMAGE_LIMIT = 20;

async function preloadHomeRows() {
  const sections = await preloadHomeSections();
  prefetchLazyImages(sections, HOME_PRELOAD_IMAGE_LIMIT);
  return sections;
}

async function preloadLibraryCoverflow(view) {
  const coverflow = buildLibraryCoverflow({
    parentId: view.Id,
    itemTypes: itemTypesForKind(view.CollectionType),
  });
  try {
    await coverflow.ready;
    prefetchLazyImages(coverflow.element);
  } finally {
    coverflow.destroy();
  }
}

function runTrackedTasks(tasks) {
  setSplashTotal(tasks.length);
  return Promise.all(
    tasks.map(function (task) {
      return Promise.resolve()
        .then(function () {
          return task.run();
        })
        .then(
          function () {
            reportSplashStep(task.label);
          },
          function (err) {
            console.warn('Jellio: preload step failed', task.label, err);
            reportSplashStep(task.label);
          },
        );
    }),
  );
}

async function preloadInitialData() {
  showSplash();

  try {
    await preloadInitialDataTasks();
  } finally {
    hideSplash();
  }
}

async function preloadInitialDataTasks() {
  const route = parseRoute();
  const tasks = [
    { label: 'Account', run: getCurrentUser },
    { label: 'Streaming services', run: getCollections },
  ];

  if (route.path === 'home') {
    tasks.push({ label: 'Featured', run: preloadHeroImages });
    preloadHomeRows().catch(function (err) {
      console.warn('Jellio: could not preload home rows', err);
    });
  } else {
    tasks.push({
      label: 'Library',
      run: async function () {
        const currentParentId = route.params.get('topParentId') || route.params.get('parentId');
        if (!currentParentId) return;
        let views = [];
        try {
          views = await getUserViews();
        } catch (err) {
          console.warn('Jellio: could not preload library list', err);
          return;
        }
        const currentView = views.filter(function (view) {
          return view.CollectionType && view.Id === currentParentId;
        })[0];
        if (currentView) {
          await preloadLibraryCoverflow(currentView);
        }
      },
    });
  }

  await withTimeout(runTrackedTasks(tasks), PRELOAD_TIMEOUT_MS);
}

const NAV_RECHECK_DELAY_MS = 10000;
const NAV_RECHECK_MAX_ATTEMPTS = 6;

let lastNavLinksSignature = null;

function navLinksSignature(links) {
  return links
    .map(function (link) {
      return link.hash;
    })
    .join('|');
}

function scheduleNavRecheck(attemptsLeft, delayMs) {
  const remaining = attemptsLeft == null ? NAV_RECHECK_MAX_ATTEMPTS : attemptsLeft;
  window.setTimeout(function () {
    invalidateNavCaches();
    getPrimaryNavLinks()
      .then(function (links) {
        const signature = navLinksSignature(links);
        if (signature === lastNavLinksSignature) return null;
        lastNavLinksSignature = signature;

        const root = getRoot();
        const sidebarMount = root.querySelector('.jellio-sidebar-mount');
        const mobileNavMount = root.querySelector('.jellio-mobile-nav-mount');
        if (sidebarMount) delete sidebarMount.dataset.jellioBuilt;
        if (mobileNavMount) delete mobileNavMount.dataset.jellioBuilt;
        return Promise.all([
          sidebarMount ? renderSidebar(sidebarMount) : null,
          mobileNavMount ? renderMobileNav(mobileNavMount) : null,
        ]);
      })
      .catch(function (err) {
        console.warn('Jellio: nav recheck failed', err);
      })
      .finally(function () {
        if (remaining - 1 > 0) scheduleNavRecheck(remaining - 1);
      });
  }, delayMs == null ? NAV_RECHECK_DELAY_MS : delayMs);
}

let userDataRowsHooked = false;
let onboardingPrompted = false;

const languageReady = loadDisplayLanguage();

async function runSync() {
  let token = 0;
  try {
    await languageReady;
    if (!isAuthenticated()) {
      lastRenderedRouteKey = null;
      if (loginScreenBypassed()) {
        await teardownActiveScreen();
        hide();
        return;
      }
      await renderUnauthenticated();
      return;
    }

    await connectivityReady;
    const offline = isOffline();

    if (!preloaded && !offline) {
      preloaded = true;
      await preloadInitialData();
      getPrimaryNavLinks()
        .then(function (links) {
          lastNavLinksSignature = navLinksSignature(links);
        })
        .catch(function () {
        });
      scheduleNavRecheck();
    }

    let route = parseRoute();
    if (offline && !OFFLINE_ROUTES.has(route.path)) {
      if (!lastOnlineRoute) {
        lastOnlineRoute = window.location.hash || '#/home';
      }
      route = { path: 'downloads', params: new URLSearchParams() };
    } else if (!offline && route.path !== 'downloads') {
      lastOnlineRoute = null;
    }
    const screen = SCREENS[route.path];

    if (!screen) {
      lastRenderedRouteKey = null;
      await teardownActiveScreen();
      hide();
      return;
    }

    const key = routeKey(route);
    const root = getRoot();
    const content = root.querySelector('.jellio-content');
    const isCurrentlyRendered = key === lastRenderedRouteKey &&
      content &&
      content.hasChildNodes() &&
      !content.querySelector('.jellio-screen-loading') &&
      !content.querySelector('.jellio-screen-spinner');
    if (isCurrentlyRendered) return;

    await teardownActiveScreen();
    startNowPlaying();
    startNotifications();
    startSounds();
    startOverlays();
    startAchievementNotifier();
    startSyncPlay();
    // Watched, resumed or favourited on another device: home rows are
    // asked for fresh in every tab.
    if (!userDataRowsHooked) {
      userDataRowsHooked = true;
      onUserDataChange(invalidateUserDataRows);
    }
    startGroupWatchInvites();
    loadGrouplistSetting();
    loadAdminStatus();
    loadSkipIntroCreditsMenuSetting();
    loadServerPreferences().catch(function () {});
    setTitle('Jellio');

    root.classList.add('jellio-root-visible');
    root.classList.toggle('jellio-root-fullscreen', FULLSCREEN_ROUTES.has(route.path));
    mountSeasons(root);
    applyResponsiveNav();
    syncMiniPlayer();

    const sidebarMount = root.querySelector('.jellio-sidebar-mount');
    const mobileNavMount = root.querySelector('.jellio-mobile-nav-mount');

    activeScreenAbortController = new AbortController();
    token = ++renderToken;
    const tasks = [screen(content, route.params, activeScreenAbortController.signal)];
    if (!FULLSCREEN_ROUTES.has(route.path)) {
      tasks.push(renderSidebar(sidebarMount));
      tasks.push(renderMobileNav(mobileNavMount));
    }

    const results = await Promise.all(tasks);
    const cleanup = typeof results[0] === 'function' ? results[0] : null;
    if (token !== renderToken) {
      if (cleanup) {
        try { await cleanup(); } catch (err) { console.warn('Jellio: screen cleanup failed', err); }
      }
      return;
    }
    lastRenderedRouteKey = key;
    activeCleanup = cleanup;
    fadeInContent(content);

    // Prompt first-run onboarding setup wizard on initial load
    if (!onboardingPrompted && !FULLSCREEN_ROUTES.has(route.path) && shouldShowOnboarding()) {
      onboardingPrompted = true;
      window.setTimeout(function () {
        if (shouldShowOnboarding() && !document.getElementById('jellioOnboardingModal')) {
          openOnboardingModal();
        }
      }, 350);
    }
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.aborted)) {
      return;
    }
    if (token && token !== renderToken) {
      return;
    }
    if (err && err.status === 401) {
      clearSession();
      sync();
      return;
    }
    console.warn('Jellio: screen render failed', err);
    lastRenderedRouteKey = null;
    showToast(t('toast_load_page_error'));
  }
}

onRouteChange(sync);

document.addEventListener('jellio:session-captured', sync);

document.addEventListener('jellio:session-expired', sync);

function isGlobalShortcutTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || !!target.isContentEditable;
}
document.addEventListener('keydown', function (event) {
  const isSlash = event.key === '/' && !event.ctrlKey && !event.altKey && !event.metaKey;
  const isCmdK = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k';
  if (!isSlash && !isCmdK) return;
  if (!isAuthenticated() || isGlobalShortcutTypingTarget(event.target)) return;
  event.preventDefault();
  const existingInput = document.querySelector('.jellio-search-input');
  if (existingInput) {
    existingInput.focus();
    if (typeof existingInput.select === 'function') existingInput.select();
  } else {
    navigateTo('#/search');
  }
});

window.addEventListener('beforeunload', teardownActiveScreen);

export {
  sync,
  runSync,
  teardownActiveScreen,
  routeKey,
};

export function getLastRenderedRouteKey() {
  return lastRenderedRouteKey;
}

export function getActiveScreenAbortController() {
  return activeScreenAbortController;
}

