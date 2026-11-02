function normalizedHash(value) {
  return (value || '').replace(/^#\/?/, '');
}

export function navigateTo(hash) {
  if (window.Emby && window.Emby.Page && typeof window.Emby.Page.show === 'function') {
    try {
      window.Emby.Page.show(hash);
      if (normalizedHash(window.location.hash) === normalizedHash(hash)) return;
      console.warn('Jellio: Emby.Page.show() did not navigate, falling back to a plain hash change');
    } catch (err) {
      console.warn('Jellio: Emby.Page.show() failed, falling back to a plain hash change', err);
    }
  }
  window.location.hash = hash;
}

export function currentHash() {
  return window.location.hash || '#/home';
}

export function setTitle(text) {
  document.title = text || 'Jellio';
}

export function parseRoute() {
  const hash = currentHash().replace(/^#\/?/, '');
  const [path, query] = hash.split('?');
  return { path: path || 'home', params: new URLSearchParams(query || '') };
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
window.addEventListener('popstate', notify);

let originalReplaceState = null;

['pushState', 'replaceState'].forEach(function (method) {
  try {
    const original = window.history[method];
    if (method === 'replaceState') originalReplaceState = original;
    window.history[method] = function () {
      const result = original.apply(this, arguments);
      notify();
      return result;
    };
  } catch (err) {
    console.warn('Jellio: could not patch history.' + method, err);
  }
});

export function reflectStateInAddressBar(hash) {
  if (!originalReplaceState) return;
  try {
    originalReplaceState.call(window.history, null, '', hash);
  } catch (err) {
    console.warn('Jellio: could not reflect state in the address bar', err);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', notify);
} else {
  notify();
}
