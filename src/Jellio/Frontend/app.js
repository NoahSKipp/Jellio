// Bootstrap: mounts Jellio's own root container over the native page,
// renders the persistent sidebar alongside whichever screen owns the
// current route. An unmigrated route (no entry in SCREENS) leaves native
// jellyfin-web showing underneath, untouched, real fallback rather than a
// broken page.
import { isAuthenticated } from './runtime/auth.js';
import { renderHome } from './screens/home.js';
import { renderSidebar } from './components/sidebar.js';
import { onRouteChange, currentHash } from './runtime/router.js';

const ROOT_ID = 'jellioRoot';

const SCREENS = {
  home: renderHome,
};

function currentRouteKey() {
  const hash = currentHash();
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

async function sync(hash) {
  try {
    const routeKey = currentRouteKey();
    const screen = routeKey && SCREENS[routeKey];

    if (!screen || !isAuthenticated()) {
      hide();
      return;
    }

    const root = getRoot();
    root.classList.add('jellio-root-visible');

    const sidebarMount = root.querySelector('.jellio-sidebar-mount');
    const content = root.querySelector('.jellio-content');

    await Promise.all([renderSidebar(sidebarMount), screen(content)]);
  } catch (err) {
    console.warn('Jellio: screen render failed, falling back to native page', err);
    hide();
  }
}

onRouteChange(sync);
