// Real jellyfin-web navigation, not a raw hash assignment, ported from the
// original Jellio codebase's own persistentSidebar.js: window.Emby.Page
// (components/router/appRouter.js, exposed globally, confirmed real) is
// what every native link goes through, its show() records a real push.
// A bare `location.hash =` only fires the native hashchange event, and
// react-router's hash history treats any change it did not itself push
// through navigate() as a pop, indistinguishable from a real back press,
// which misbehaves on any route this runtime has not taken over yet.
// Falls back to the raw assignment only if the real router is not there.
export function navigateTo(hash) {
  if (window.Emby && window.Emby.Page && typeof window.Emby.Page.show === 'function') {
    window.Emby.Page.show(hash);
  } else {
    window.location.hash = hash;
  }
}

export function currentHash() {
  return window.location.hash || '#/home';
}

const listeners = [];

export function onRouteChange(fn) {
  listeners.push(fn);
}

let scheduled = false;
function notify() {
  if (scheduled) return;
  scheduled = true;
  window.requestAnimationFrame(function () {
    scheduled = false;
    listeners.forEach(function (fn) {
      fn(currentHash());
    });
  });
}

window.addEventListener('hashchange', notify);

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', notify);
} else {
  notify();
}
