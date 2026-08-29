// Real jellyfin-web navigation, not a raw hash assignment, ported from the
// original Jellio codebase's own persistentSidebar.js: window.Emby.Page
// (components/router/appRouter.js, exposed globally, confirmed real) is
// what every native link goes through, its show() records a real push.
// A bare `location.hash =` only fires the native hashchange event, and
// react-router's hash history treats any change it did not itself push
// through navigate() as a pop, indistinguishable from a real back press,
// which misbehaves on any route this runtime has not taken over yet.
// Falls back to the raw assignment only if the real router is not there.
//
// Real bug, found live from the player screen specifically: Emby.Page.show()
// runs through native's own route guard (auth.js's own header explains
// why), and that guard's own internal "where am I" state can be out of
// sync with the real address bar on a route only this runtime ever
// took over, since native never itself ran a real transition into it.
// show() throwing there used to abort navigateTo entirely with nothing
// falling back, reported live as Back doing nothing at all, not even
// the address bar moving. Same real philosophy the history patch below
// already uses: losing native's own route guard integration for the
// one real route it does not recognize is an acceptable degradation,
// leaving the reader stuck on a dead screen is not.
// Real target, not just "did window.location.hash change at all": a
// route guard declining the transition can also leave the address bar
// exactly where navigateTo's own caller already was, a real case a
// plain equality check against the hash before this call would read
// as "it worked" for.
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

// navigateTo()'s own Emby.Page.show() call routes through native's real
// react-router history, and native's own route matcher has no entry for
// any hash this runtime owns (#/item, #/play, its own library and
// service routes, none of them a real native path). Confirmed live:
// that unmatched transition still runs its own "page not found" view
// far enough to set document.title before this runtime's own screen
// content ever paints over it, real page content never visible (this
// runtime's own #jellioRoot already covers it) but the browser tab
// itself stayed on native's own title the whole time regardless,
// reported live as every movie and show reading "Page Not Found" in
// the tab. Called once, synchronously, the moment a route change is
// underway (app.js's own runSync, before that route's screen has even
// started fetching), so it always overwrites whatever native's own
// failed transition just set; a screen with a real title of its own
// (a movie, a show, an episode) calls this again once its own fetch
// resolves and wins the same way, last write standing.
export function setTitle(text) {
  document.title = text || 'Jellio';
}

// Splits "#/movies?topParentId=X&collectionType=movies" into its path
// ("movies") and query params, the same shape every route this runtime
// owns needs to read its own arguments from.
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

// navigateTo's own real Emby.Page.show() call above lands on react-router's
// own history object (components/router/routerHistory.ts's own push(),
// confirmed real before writing this), which navigates through
// window.history.pushState()/replaceState(), never a bare hash
// assignment. pushState/replaceState never fire hashchange, only a
// user's own back/forward press or a direct location.hash write do, so
// every native-routed click this runtime hands off to Emby.Page.show()
// changed the address bar and never reached this router at all. Real
// bug, found live: Movies, Shows, Search, Watchlist and every card's
// own click handler visibly changed the URL and rendered nothing.
// Patching both, the same technique any analytics script already uses
// to see SPA navigation it did not initiate itself, is the only way to
// hear a pushState call fire without owning the router that makes it.
// try/catch around the assignment itself, not just its call: this file
// is an ES module, always strict mode, and a strict-mode assignment to
// a non-writable property throws instead of failing silently. If
// window.history[method] is ever locked down (a frozen history object,
// some embedding this codebase has not seen), that throw happened at
// top-level module evaluation, aborting this whole module's own
// execution before it reached a single addEventListener call below,
// and everything that imports it with it: reported live as the reskin
// not loading at all. Losing pushState detection on a client where
// this cannot be patched is a real, acceptable degradation; losing the
// entire runtime over it is not.
['pushState', 'replaceState'].forEach(function (method) {
  try {
    const original = window.history[method];
    window.history[method] = function () {
      const result = original.apply(this, arguments);
      notify();
      return result;
    };
  } catch (err) {
    console.warn('Jellio: could not patch history.' + method, err);
  }
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', notify);
} else {
  notify();
}
