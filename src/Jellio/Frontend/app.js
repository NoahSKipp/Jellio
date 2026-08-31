// Bootstrap: mounts Jellio's own root container over the native page,
// renders the persistent sidebar alongside whichever screen owns the
// current route. An unmigrated route (no entry in SCREENS) leaves native
// jellyfin-web showing underneath, untouched, real fallback rather than a
// broken page.
import { isAuthenticated, loginScreenBypassed, clearSession } from './runtime/auth.js';
import {
  getUserViews,
  getCollections,
  getCurrentUser,
  getHeroCandidates,
  getImageUrl,
  itemTypesForKind,
  invalidateNavCaches,
} from './runtime/api.js';
import { renderLogin } from './screens/login.js';
import { renderHome, preloadHomeSections } from './screens/home.js';
import { renderLibrary } from './screens/library.js';
import { renderSearch } from './screens/search.js';
import { renderDetail } from './screens/detail.js';
import { renderPlayer } from './screens/player.js';
import { renderService } from './screens/service.js';
import { renderSettings } from './screens/settings.js';
import { renderPerson } from './screens/person.js';
import { renderProfile } from './screens/profile.js';
import { renderFeed } from './screens/feed.js';
import { renderCalendar } from './screens/calendar.js';
import { renderSidebar } from './components/sidebar.js';
import { renderMobileNav } from './components/mobileNav.js';
import { getPrimaryNavLinks } from './components/navShared.js';
import { mountSeasons } from './components/seasons.js';
import { startNowPlaying } from './components/nowPlaying.js';
import { startNotifications } from './components/notifications.js';
import { startAchievementNotifier } from './components/achievementNotifier.js';
import { loadGrouplistSetting } from './runtime/grouplistSettings.js';
import { startSyncPlay } from './runtime/syncPlay.js';
import { startGroupWatchInvites } from './components/groupWatchInvites.js';
import { showSplash, hideSplash, setSplashTotal, reportSplashStep } from './components/splash.js';
import { showToast } from './components/toast.js';
import { buildLibraryCoverflow } from './components/libraryCoverflow.js';
import { onRouteChange, parseRoute, setTitle, navigateTo } from './runtime/router.js';

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
  profile: renderProfile,
  feed: renderFeed,
  calendar: renderCalendar,
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
//
// Rebuilding the inner structure unconditionally on every call fixed
// that, but it is also what made the sidebar icons visibly flicker on
// every single navigation, reported live separately: a fresh, empty
// <nav> replaced the real one every time regardless of whether
// anything had actually gone missing, and components/sidebar.js's own
// renderSidebar had to rebuild every icon from nothing to fill it back
// in. Checking for the two children this self-heal actually cares
// about, rather than rebuilding regardless of whether either is
// really gone, keeps the same real fix for the same real bug without
// paying its cost on every ordinary call.
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

// Belt and suspenders over css/app.css's own media query at the same
// breakpoint: a real tablet kept showing the rail and the pill both at
// once, and widening the width threshold twice over did not fix it,
// confirmed with a real headless run at 1024px (matches the mobile
// side of a width query exactly as written) that this rule alone was
// never the real problem. The real one: a tablet's own real CSS
// viewport can sit well past any width worth calling "mobile" (some
// report their native pixel width directly, no virtual viewport
// scaling at all), so no width threshold this project picks will ever
// reliably catch every real tablet. pointer:coarse asks the real
// question this was always trying to ask with a width proxy instead:
// is the primary input here a finger, not a mouse, true on every
// touchscreen regardless of how wide its own viewport reports, false
// on a real desktop/laptop even in a narrow window. The old width
// check stays as an OR only for the one case pointer:coarse cannot
// cover on its own: a real desktop browser resized down narrow by
// hand, still mouse-driven, still wants the rail to fit rather than
// stay full width, same real case components/mobileNav.js's own
// original spec called "mobile" in the first place.
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

// Set by whichever screen last rendered, if it needs to know it is being
// torn down (the player's own real need: stop the video and report the
// stopped position before the next screen, or native rendering, takes
// over). Screens with nothing to clean up simply return nothing.
let activeCleanup = null;

// Real bug, found live: navigateTo()'s own Emby.Page.show() fallback
// (runtime/router.js's own header explains why) can fire two separate
// route change notifications for one real navigateTo() call, both
// landing on the exact same final hash, sync()'s own coalescing below
// turning the second one into a real extra runSync() rather than
// dropping it. Every screen re-runs every one of its own real side
// effects on every mount, the player screen's own publishSyncQueue()
// among them, so a second real mount for a route already active
// duplicated a real SetNewQueue call and a real Group Watch chat
// message right along with it, confirmed live from chat carrying two
// identical watch cards for one real Play. Tracked as a plain string
// key rather than reusing route.params itself: URLSearchParams has no
// real equality of its own, and every screen this runs already trusts
// route.params fresh off parseRoute() regardless.
let lastRenderedRouteKey = null;

function routeKey(route) {
  return route.path + '?' + route.params.toString();
}

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

// Every screen's own real cost, on this run and every one after it, is
// the sidebar's own three calls (runtime/api.js's own cache makes the
// after-this-one cost free): shown once, right after a real session is
// confirmed, so the very first authenticated paint already has warm
// data instead of the sidebar and the first screen both racing the
// network cold. This used to cap out at 8 seconds on the theory that a
// blank splash was worse than a cold first paint, reported live as
// exactly backwards: on a slow connection the cap fired before the
// hero/home-rows requests it was racing actually finished, hiding the
// one thing telling the reader anything was happening and handing them
// an empty hero shell and empty rows that then sat blank, with no
// spinner, for however much longer those same requests really took.
// The splash's own progress bar already tracks real steps, not a
// guess, so staying up until they are actually done is strictly
// better than guessing wrong about when to give up on them. What is
// still real to guard against is a request that never resolves at
// all, no timeout of its own (runtime/api.js's own getJson has none):
// this stays as that last resort only, high enough it is never the
// one deciding how home's own first paint looks on merely slow wifi.
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
  // fetchPriority is a real, if not universal, browser hint (ignored
  // outright rather than erroring where it is not implemented), a
  // cheap way to tell the network stack this one specific request
  // matters more than the dozens of others this same preload phase is
  // about to fire at once.
  if (priority) img.fetchPriority = priority;
  img.src = url;
}

// The premise every preload task below this point already believed
// about a detached <img>, real src set the instant it exists, loading
// regardless of whether anything has appended it yet, is true, but
// only for a plain one: components/card.js's own buildCard() (every
// home row, every library grid) and components/libraryCoverflow.js's
// own buildSlide() both set loading="lazy" on their real <img>, and a
// lazy image with no layout at all to measure an intersection against
// never starts its own real request, detached or not, confirmed live
// (a detached eager <img>'s own request fires immediately, a detached
// lazy one never fires at all until something actually appends it
// where a reader can see it). Reported as home still taking a long
// time to build and its images still taking a long time to load even
// after the boot splash itself was fixed to stay up for real work:
// preloadHomeSections() below was building every one of those rows
// for real, correctly, the whole time, and every one of their own
// images sat there doing nothing regardless, because none of them
// were ever really the plain kind this whole architecture assumed.
// Walking back over the same DOM already built and prefetching a real
// copy of each lazy image's own src the plain way is the fix, not
// touching loading="lazy" itself: that attribute is still exactly
// right for a library grid genuinely holding hundreds of posters,
// this only ever needs to cover what a reader lands on immediately.
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

// The hero carousel's own backdrops specifically: heroCarousel.js
// builds its own <img> tags only once it mounts, which used to mean
// the reader watched them pop in after the splash had already stepped
// aside. Requesting the same URLs here first means the browser's own
// HTTP cache already has them by the time that real element asks for
// them. getHeroCandidates is cached (see runtime/api.js's own header
// for why a Random sort needs that here specifically), so this and
// heroCarousel.js's own later call return the same eight items rather
// than two different random sets.
async function preloadHeroImages() {
  const heroItems = await getHeroCandidates(8);
  heroItems.forEach(function (item, index) {
    // Only the first slide is ever the reader's own real first paint,
    // the actual LCP candidate; the other seven are exactly as needed
    // but not as urgent, real backdrops for whichever slide the
    // carousel auto-advances to later, not what decides how long the
    // reader watches an empty hero before anything shows up in it.
    const priority = index === 0 ? 'high' : 'low';
    prefetchImage(getImageUrl(item.Id, 'Backdrop', { maxWidth: 1600 }), priority);
    // The logo used to sit outside this warm-up entirely, real reason
    // components/heroCarousel.js's own render() only ever built that
    // <img> once it mounted, the reader watching it pop in after the
    // splash had already stepped aside, same real gap this whole
    // function already closed for the backdrop.
    prefetchImage(getImageUrl(item.Id, 'Logo', { maxWidth: 800 }), priority);
  });
}

// A home row's own real card count adds up fast across every row
// (screens/home.js's own CATALOG_ROW_LIMIT and GENRE_ROW_LIMIT are 24
// each, up to a dozen rows total on a real catalog), the exact shape
// of request burst preloadInitialData()'s own header already explains
// choosing one screen's worth over every library's worth to avoid.
// Every one of those cards is loading="lazy" regardless (see
// prefetchLazyImages() above), so only the reader's own real first
// paint, roughly two rows worth, earns a forced prefetch here; a
// third row and beyond still loads the same moment scrolling it into
// view already would have, same real cost Nuvio itself would pay
// there too, not paid up front for a row that might never get
// scrolled to at all.
const HOME_PRELOAD_IMAGE_LIMIT = 20;

async function preloadHomeRows() {
  const sections = await preloadHomeSections();
  prefetchLazyImages(sections, HOME_PRELOAD_IMAGE_LIMIT);
  return sections;
}

// Builds one real library's own coverflow (components/libraryCoverflow.js,
// the same component screens/library.js mounts). Its own real <img>
// is loading="lazy" (see prefetchLazyImages() above), so ready
// resolving is only ever the underlying candidate fetch finishing,
// not any image actually starting; prefetchLazyImages() below does
// that part for real, all of them, the same fixed 8-slide candidate
// list preloadHeroImages() above already prefetches in full. Destroyed
// right after either way: this throwaway instance's own auto-advance
// timer would otherwise keep firing forever for a carousel nobody is
// looking at.
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

// Runs every queued task in parallel, reporting each one to the splash
// (components/splash.js's own progress bar and status line, real
// feedback on a slow connection asked for both) the moment it settles,
// success or failure either way: a library with nothing worth a
// coverflow, or a request that failed outright, still counts as one
// real step done rather than stalling the counter on it.
function runTrackedTasks(tasks) {
  setSplashTotal(tasks.length);
  return Promise.all(
    tasks.map(function (task) {
      // Promise.resolve().then(...) rather than a bare task.run().then(...):
      // getCurrentUser/getCollections are plain functions, not async ones,
      // so a synchronous throw inside either (rather than a rejected
      // promise) used to escape this whole map() call outright, skipping
      // Promise.all entirely and, with it, preloadInitialData()'s own
      // hideSplash() below. Real bug found live: the splash stayed up
      // indefinitely, no 45s PRELOAD_TIMEOUT_MS ceiling to save it since
      // withTimeout() never even got a promise to race against.
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

// Every screen's own real cost, on this run and every one after it, is
// the sidebar's own three calls (runtime/api.js's own cache makes the
// after-this-one cost free): shown once, right after a real session is
// confirmed, so the very first authenticated paint already has warm
// data instead of the sidebar and the first screen both racing the
// network cold.
//
// Used to warm every real library's own coverflow here too ("preload
// all libraries", real feedback at the time), pulled after later real
// feedback on a genuinely bad connection asked the opposite question:
// why does Nuvio itself not feel this slow on the same wifi. The real
// answer was not the wifi alone. Every one of this runtime's own
// images is a real Jellyfin /Items/{id}/Images/{type} request, resized
// server side on a cache miss, served off this one self-hosted box's
// own upload, not a CDN edge the way Nuvio's own poster/backdrop
// sources are; warming every library at once meant a hundred-plus of
// those landing on that one box within the same few seconds on every
// single cold load, home included. Only the screen actually on
// screen, home's own rows or the one real library a route landed on,
// earns a preload task now; opening a different library later pays
// its own real cost then, the same moment Nuvio would pay it too,
// instead of every session paying every library's cost up front
// regardless of whether it is ever opened.
async function preloadInitialData() {
  showSplash();

  // try/finally rather than a plain sequence: whatever runs between
  // showSplash() and hideSplash() below is not this function's own
  // code alone (parseRoute(), every task's own run(), preloadHomeRows()'
  // own synchronous portion before its catch attaches), so hideSplash()
  // needs a real guarantee here, not just the happy path reaching its
  // own last line.
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
    // Home's own rows, recommendation/catalog/genre alike, run in the
    // background rather than as a tracked, splash-blocking task: this
    // used to keep the splash up until that whole chain resolved, the
    // slowest phase on this whole page deciding how long every reader
    // stared at it regardless of how fast Account/Streaming/Featured
    // above already were. preloadHomeRows() memoizes into home.js's
    // own homeSectionsPromise, so renderHome()'s later real call to
    // preloadHomeSectionsWithProgress() below reuses this exact same
    // in-flight promise and streams each phase's own sections in as it
    // resolves, real Nuvio-style progressive reveal, instead of a
    // blank splash standing in for all of it at once.
    preloadHomeRows().catch(function (err) {
      console.warn('Jellio: could not preload home rows', err);
    });
  } else {
    // getUserViews() used to be awaited ahead of this whole task list,
    // real reason being the current view's own real name for the
    // splash's own step label below, but that inserted one full serial
    // round trip in front of Account/Streaming/Featured on every real
    // load, not only a library one. Folded into its own tracked task
    // instead, it now runs together with the others rather than
    // gating them from even starting.
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

// Gelato's own catalog import (the Anime nav entry's real source,
// components/navShared.js's own getPrimaryNavLinks explains why) can
// still be running well after this runtime's own first render already
// built both rails from whatever collections existed at that exact
// moment, real boot race reported live: Anime missing from the sidebar
// and mobile nav until an actual hard reload gave Gelato enough real
// wall clock time to finish first, confirmed live that a plain wait
// fixes it too, no reload needed at all once enough time has passed.
// A single 20s recheck was not consistently enough either, confirmed
// live the same way the search/detail screen's own single 2s retry
// (screens/detail.js's own header) was not enough for a title's real
// first import (23s end to end there): a full catalog import is real
// work of its own, no fixed ceiling on how long it takes. Rechecking
// up to NAV_RECHECK_MAX_ATTEMPTS times, 10s apart, covers the same
// real minute of wall clock at a finer grain instead of gambling on
// one fixed window; invalidate the two nav-relevant cache entries and
// rebuild both rails each time, the same clearCache() + dataset reset
// pattern components/accountSwitcher.js's own switchToUser already
// uses for the same real job.
const NAV_RECHECK_DELAY_MS = 10000;
const NAV_RECHECK_MAX_ATTEMPTS = 6;

// Real regression, found live off the 10s-grain change above: every
// attempt used to delete both rails' own dataset.jellioBuilt and
// rebuild unconditionally, whether or not Gelato's own catalog import
// had actually finished, so the reader watched the whole rail flash
// empty and repaint up to six times a minute instead of three. Only
// the reader's own actual link set (Anime showing up chief among them)
// ever needs a rebuild; a signature of the hashes this recheck would
// otherwise rebuild from lets every attempt that found nothing new
// skip the teardown entirely.
let lastNavLinksSignature = null;

function navLinksSignature(links) {
  return links
    .map(function (link) {
      return link.hash;
    })
    .join('|');
}

function scheduleNavRecheck(attemptsLeft) {
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
  }, NAV_RECHECK_DELAY_MS);
}

async function runSync() {
  try {
    if (!isAuthenticated()) {
      lastRenderedRouteKey = null;
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
      // Real regression, found live: awaited right here, this sat
      // between hideSplash() above (inside preloadInitialData's own
      // finally) and root.classList.add('jellio-root-visible') further
      // below, the one real line that actually covers native
      // jellyfin-web. getUserViews() specifically is not warm yet on
      // the common home route (only getCollections is, preloadInitialData's
      // own tracked task list), so this was a real, uncached network
      // round trip landing in a gap neither the splash nor #jellioRoot
      // covered, native jellyfin-web visible underneath for exactly as
      // long as that request took. Fired in the background instead:
      // scheduleNavRecheck()'s own first attempt is a full
      // NAV_RECHECK_DELAY_MS away, real time this same call was never
      // going to need to actually resolve in.
      getPrimaryNavLinks()
        .then(function (links) {
          lastNavLinksSignature = navLinksSignature(links);
        })
        .catch(function () {
          // Left null: scheduleNavRecheck()'s own first attempt just
          // treats that the same as a real first-ever check and rebuilds
          // once, same fallback shape as before this signature existed.
        });
      scheduleNavRecheck();
    }

    const route = parseRoute();
    const screen = SCREENS[route.path];

    if (!screen) {
      lastRenderedRouteKey = null;
      teardownActiveScreen();
      hide();
      return;
    }

    const key = routeKey(route);
    if (key === lastRenderedRouteKey) return;
    lastRenderedRouteKey = key;

    teardownActiveScreen();
    startNowPlaying();
    startNotifications();
    startAchievementNotifier();
    startSyncPlay();
    startGroupWatchInvites();
    loadGrouplistSetting();
    // Overwrites whatever native's own unmatched route transition just
    // set the tab to (router.js's own setTitle() header explains why
    // that happens on every single route this runtime owns); a screen
    // with a real title of its own sets it again once its own fetch
    // resolves and wins the same way.
    setTitle('Jellio');

    const root = getRoot();
    root.classList.add('jellio-root-visible');
    root.classList.toggle('jellio-root-fullscreen', FULLSCREEN_ROUTES.has(route.path));
    mountSeasons(root);
    applyResponsiveNav();

    const sidebarMount = root.querySelector('.jellio-sidebar-mount');
    const mobileNavMount = root.querySelector('.jellio-mobile-nav-mount');
    const content = root.querySelector('.jellio-content');

    // The player route used to wipe the sidebar mount's own content
    // outright, which meant components/sidebar.js's own dataset marker
    // for "already built" survived on the (now empty) container while
    // the links it referred to did not, so the very next real
    // navigation's fast path found nothing to update and the rail
    // stayed empty. css/app.css's own .jellio-root-fullscreen rule
    // hides both nav mounts instead now, so the built rail or pill is
    // simply sitting there, unrendered, the moment a real route wants
    // it again, no rebuild needed either way.
    const tasks = [screen(content, route.params)];
    if (!FULLSCREEN_ROUTES.has(route.path)) {
      tasks.push(renderSidebar(sidebarMount));
      tasks.push(renderMobileNav(mobileNavMount));
    }

    const results = await Promise.all(tasks);
    activeCleanup = typeof results[0] === 'function' ? results[0] : null;
    fadeInContent(content);
  } catch (err) {
    // Real bug, found live: revoking this account's own token server
    // side (deleting its device from the Dashboard, or any other real
    // revocation) left isAuthenticated() above still reporting true,
    // since that check is purely local (auth.js's own header explains
    // why: no server round trip). The very next authenticated fetch
    // this function makes then fails with a real 401, caught right
    // here same as any other failure, and used to fall back to native
    // jellyfin-web, whose own credentials are just as stale, real
    // feedback: native's own login screen showing instead of this
    // runtime's own. Clearing the stale local session and re-running
    // sync() routes back to this runtime's own login screen instead,
    // the same real screen a visit that was never logged in already
    // gets, rather than degrading to a native fallback that cannot log
    // back in as this runtime's own account either.
    if (err && err.status === 401) {
      clearSession();
      sync();
      return;
    }
    // Real bug, live-reported: hide() here used to fall back to native
    // jellyfin-web, the same real degradation this file's own top
    // comment documents, but that fallback only actually works for a
    // route this runtime never claimed at all (no SCREENS entry),
    // where native's own router still owns it and can render something
    // real. This catch only ever runs once screen above already
    // resolved off SCREENS, an owned route, and router.js's own header
    // already confirms Emby.Page.show()'s own earlier navigation into
    // it leaves native's own router stuck on a route it does not
    // recognize either: a real "page not found" shell, not a working
    // fallback, reported live from a Group Watch pick's own watch
    // card. Left visible on whatever the previous real screen was
    // instead, a toast the actual feedback a reader gets. Also a real
    // bug on its own: lastRenderedRouteKey was already set to this
    // failed route's own key above, so retrying (the exact same link
    // again, hash unchanged) hit the "already rendered" fast path
    // further up and did nothing at all, not even attempt the render
    // again. Cleared here so a retry genuinely retries.
    console.warn('Jellio: screen render failed', err);
    lastRenderedRouteKey = null;
    showToast('Could not load that page. Try again.');
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

// runtime/api.js's own real choke point for every authenticated call
// this runtime makes: a 401 there (a token revoked server side,
// deleting its device from the Dashboard most of all) already cleared
// the stale local session by the time this fires, that file's own
// header explains why it cannot call sync() directly. A fresh sync()
// here lands back on isAuthenticated() now reporting false, this
// runtime's own login screen, the same one runSync()'s own catch below
// already tries for a 401 that reaches it directly, this one reaching
// every real caller regardless of whether it individually re-throws.
document.addEventListener('jellio:session-expired', sync);

// Real convenience, same category screens/player.js's own keyboard
// shortcuts already are: "/" jumps straight to search from anywhere in
// the app, the same real convention most search heavy web apps already
// use. Focuses an already mounted search input directly rather than
// always navigating fresh (a reader already on #/search who clicked a
// result card, most of all), only actually routing there when nothing
// is mounted yet. Skipped while the reader is already typing anywhere
// (an input, a textarea, a contenteditable bio field) or signed out,
// this runtime's own login screen has no real use for it.
function isGlobalShortcutTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || !!target.isContentEditable;
}
document.addEventListener('keydown', function (event) {
  if (event.key !== '/' || event.ctrlKey || event.altKey || event.metaKey) return;
  if (!isAuthenticated() || isGlobalShortcutTypingTarget(event.target)) return;
  event.preventDefault();
  const existingInput = document.querySelector('.jellio-search-input');
  if (existingInput) {
    existingInput.focus();
  } else {
    navigateTo('#/search');
  }
});

// Best effort: a report sent from here can still be dropped by the
// browser before it lands, the same real limitation every other Jellyfin
// client's own beforeunload reporting already has, not something this
// runtime can fully solve either.
window.addEventListener('beforeunload', teardownActiveScreen);
