// Bootstrap: mounts Jellio's own root container over the native page and
// hands off to whichever screen owns the current route. An unmigrated
// route (no entry in SCREENS) leaves native jellyfin-web showing
// underneath, untouched, real fallback rather than a broken page.
import { isAuthenticated } from './runtime/auth.js';
import { renderHome } from './screens/home.js';

const ROOT_ID = 'jellioRoot';

const SCREENS = {
  home: renderHome,
};

function currentRouteKey() {
  const hash = window.location.hash || '';
  if (hash.indexOf('#/login') === 0) return null;
  if (hash === '' || hash === '#/' || hash.indexOf('#/home') === 0) {
    return 'home';
  }
  return null;
}

function getRoot() {
  let root = document.getElementById(ROOT_ID);
  if (!root) {
    root = document.createElement('div');
    root.id = ROOT_ID;
    document.body.appendChild(root);
  }
  return root;
}

function hide() {
  const root = document.getElementById(ROOT_ID);
  if (root) {
    root.classList.remove('jellio-root-visible');
    root.textContent = '';
  }
}

async function sync() {
  try {
    const routeKey = currentRouteKey();
    const screen = routeKey && SCREENS[routeKey];

    if (!screen || !isAuthenticated()) {
      hide();
      return;
    }

    const root = getRoot();
    root.classList.add('jellio-root-visible');
    await screen(root);
  } catch (err) {
    console.warn('Jellio: screen render failed, falling back to native page', err);
    hide();
  }
}

let syncScheduled = false;
function scheduleSync() {
  if (syncScheduled) return;
  syncScheduled = true;
  window.requestAnimationFrame(function () {
    syncScheduled = false;
    sync();
  });
}

window.addEventListener('hashchange', scheduleSync);

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', scheduleSync);
} else {
  scheduleSync();
}
