// Boot splash, shown exactly once per real login (app.js's own
// `preloaded` latch), while app.js's own preloadInitialData() warms up
// the sidebar's three universal calls, home's own rows and every real
// library's own coverflow. MonWUI's own splash (Resources/slider/
// main.js, CUSTOM_SPLASH_*) was investigated first and found to be
// pure cosmetic cover for native jellyfin-web's own boot flicker,
// nothing behind it actually preloads: this runtime has no native boot
// to cover, so this splash only earns its place by being real, waiting
// on the exact requests that made switching libraries feel slow (real
// feedback), not on a timer.
//
// The jellyfish mark itself, our own animated wordmark svg, loops for
// as long as the real preload takes rather than racing a fixed-length
// clip: no more ended/error/timeout plumbing to keep in sync with a
// video file's own real runtime. Reduced motion is handled inside the
// svg's own <style> (a media query mirroring app.css's own global
// override), not here: an <img>-referenced svg renders in its own
// isolated document, so the page-wide rule alone never reaches it.
const SPLASH_ID = 'jellioSplash';
const HIDE_TRANSITION_MS = 420;

export function showSplash() {
  if (document.getElementById(SPLASH_ID)) return;

  const splash = document.createElement('div');
  splash.id = SPLASH_ID;

  const mark = document.createElement('div');
  mark.className = 'jellio-splash-mark';

  const logo = document.createElement('img');
  logo.className = 'jellio-splash-logo';
  logo.src = '/Jellio/frontend/img/jellio-mark-animated.svg';
  logo.alt = '';
  mark.appendChild(logo);

  const word = document.createElement('div');
  word.className = 'jellio-splash-word';
  word.textContent = 'Jellio';
  mark.appendChild(word);

  const loading = document.createElement('div');
  loading.className = 'jellio-splash-loading';
  loading.textContent = 'Loading…';
  mark.appendChild(loading);

  splash.appendChild(mark);
  document.body.appendChild(splash);
}

export function setSplashTotal() {}

export function reportSplashStep() {}

// Called once app.js's own preload has actually settled: the only
// real signal this waits on now that the mark loops rather than
// racing a fixed-length clip.
export function hideSplash() {
  const splash = document.getElementById(SPLASH_ID);
  if (!splash) return;
  splash.classList.add('jellio-splash-hidden');
  window.setTimeout(function () {
    splash.remove();
  }, HIDE_TRANSITION_MS);
}
