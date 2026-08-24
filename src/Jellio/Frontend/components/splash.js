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
// Real feedback on a slow connection (hotel wifi, reported directly)
// asked for more than a bare spinner: a real step count, not a
// guessed one, since preloadInitialData() only knows how many real
// tasks it queued once the reader's own library list resolves.
const SPLASH_ID = 'jellioSplash';
const HIDE_TRANSITION_MS = 420;

let statusEl = null;
let progressFillEl = null;
let totalSteps = 0;
let completedSteps = 0;

export function showSplash() {
  if (document.getElementById(SPLASH_ID)) return;
  totalSteps = 0;
  completedSteps = 0;

  const splash = document.createElement('div');
  splash.id = SPLASH_ID;

  const mark = document.createElement('div');
  mark.className = 'jellio-splash-mark';
  mark.textContent = 'Jellio';
  splash.appendChild(mark);

  const spinner = document.createElement('div');
  spinner.className = 'jellio-splash-spinner';
  splash.appendChild(spinner);

  const progressGroup = document.createElement('div');
  progressGroup.className = 'jellio-splash-progress-group';

  const progress = document.createElement('div');
  progress.className = 'jellio-splash-progress';
  progressFillEl = document.createElement('div');
  progressFillEl.className = 'jellio-splash-progress-fill';
  progress.appendChild(progressFillEl);
  progressGroup.appendChild(progress);

  statusEl = document.createElement('div');
  statusEl.className = 'jellio-splash-status';
  statusEl.textContent = 'Getting ready…';
  progressGroup.appendChild(statusEl);

  splash.appendChild(progressGroup);

  document.body.appendChild(splash);
}

function paintProgress() {
  if (progressFillEl) {
    const pct = totalSteps ? Math.min(100, Math.round((completedSteps / totalSteps) * 100)) : 0;
    progressFillEl.style.width = pct + '%';
  }
}

// Called once app.js's own preload task list is known (it depends on
// a real library list, so the true count is never known any earlier
// than that): resets the counter and gives the progress bar something
// real to fill toward instead of an indeterminate spin the whole time.
export function setSplashTotal(total) {
  totalSteps = total;
  completedSteps = 0;
  paintProgress();
}

// One real task finished, success or failure either way: app.js's own
// preload calls this from both branches of each task's own settle, the
// same reasoning withTimeout() already applies to the preload as a
// whole, just per step instead of once for everything.
export function reportSplashStep(label) {
  completedSteps += 1;
  if (statusEl) {
    statusEl.textContent = totalSteps
      ? label + ' (' + completedSteps + '/' + totalSteps + ')'
      : label;
  }
  paintProgress();
}

export function hideSplash() {
  const splash = document.getElementById(SPLASH_ID);
  if (!splash) return;
  splash.classList.add('jellio-splash-hidden');
  window.setTimeout(function () {
    splash.remove();
  }, HIDE_TRANSITION_MS);
  statusEl = null;
  progressFillEl = null;
}
