// Boot splash, shown exactly once per real login (app.js's own
// `preloaded` latch), while the sidebar's own three universal calls
// (views, collections, the current user, all cached in runtime/api.js)
// warm up. MonWUI's own splash (Resources/slider/main.js,
// CUSTOM_SPLASH_*) was investigated first and found to be pure cosmetic
// cover for native jellyfin-web's own boot flicker, nothing behind it
// actually preloads: this runtime has no native boot to cover, so this
// splash only earns its place by being real, waiting on the exact
// requests that made switching libraries feel slow (real feedback), not
// on a timer.
//
// Scoped deliberately to that one always-true cost rather than every
// screen's own data: which route loads first, and what that route's
// own rows need, varies (home's hero and rows, a library's coverflow,
// a detail page), so guessing further would mean caching data some
// visits never use. The one thing every route already pays for through
// the sidebar is the three calls this warms.
const SPLASH_ID = 'jellioSplash';
const HIDE_TRANSITION_MS = 420;

export function showSplash() {
  if (document.getElementById(SPLASH_ID)) return;

  const splash = document.createElement('div');
  splash.id = SPLASH_ID;

  const mark = document.createElement('div');
  mark.className = 'jellio-splash-mark';
  mark.textContent = 'Jellio';
  splash.appendChild(mark);

  const spinner = document.createElement('div');
  spinner.className = 'jellio-splash-spinner';
  splash.appendChild(spinner);

  document.body.appendChild(splash);
}

export function hideSplash() {
  const splash = document.getElementById(SPLASH_ID);
  if (!splash) return;
  splash.classList.add('jellio-splash-hidden');
  window.setTimeout(function () {
    splash.remove();
  }, HIDE_TRANSITION_MS);
}
