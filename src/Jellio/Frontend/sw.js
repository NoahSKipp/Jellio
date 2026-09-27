// Jellio's service worker (runtime/offline.js has the rest of offline).
// Registered for the web client's own pages, in place of jellyfin-web's
// serviceworker.js, which it loads so notifications keep working.
//
// - The page and its scripts and styles (jellyfin-web's and Jellio's)
//   come from the network when it answers, and are cached as they pass
//   through, so the app opens from the cache when the server can't be
//   reached.
// - Item images and book covers fall back to a downloaded copy.
// - Everything else (the API) goes straight to the network.
const SHELL_CACHE = 'jellio-shell-v1';
const FILES_CACHE = 'jellio-offline-files';
const FILE_PREFIX = '/__jellio_offline__/';
const NETWORK_TIMEOUT_MS = 6000;

try {
  importScripts(new URL('serviceworker.js', self.registration.scope).href);
} catch (err) {
  // No jellyfin-web service worker at this address: nothing to keep.
}

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (key) {
              return key.indexOf('jellio-shell-') === 0 && key !== SHELL_CACHE;
            })
            .map(function (key) {
              return caches.delete(key);
            }),
        );
      })
      .then(function () {
        return self.clients.claim();
      }),
  );
});

function scopePath() {
  return new URL(self.registration.scope).pathname;
}

function isShellRequest(url, request) {
  if (request.mode === 'navigate') return true;
  return url.pathname.indexOf(scopePath()) === 0 || url.pathname.indexOf('/Jellio/frontend/') === 0;
}

// The item id an image or cover request is for, or null.
function coverItemId(url) {
  const match =
    /^\/Items\/([0-9a-fA-F-]{32,36})\/Images\//.exec(url.pathname) ||
    /^\/Jellio\/books\/item\/([0-9a-fA-F-]{32,36})\/cover/.exec(url.pathname) ||
    /^\/Jellio\/manga\/series-cover\/([0-9a-fA-F-]{32,36})/.exec(url.pathname);
  return match ? match[1].replace(/-/g, '').toLowerCase() : null;
}

function offlineAnswer() {
  return new Response('', { status: 503, headers: { 'X-Jellio-Offline': '1' } });
}

// Network first, cached copy when the network fails or takes too long
// (and there is one); successful answers refresh the cache.
function networkFirst(event, cacheKey) {
  const request = event.request;
  return caches.open(SHELL_CACHE).then(function (cache) {
    const network = fetch(request).then(function (response) {
      if (response && response.ok && response.type === 'basic') {
        const copy = response.clone();
        event.waitUntil(cache.put(cacheKey, copy));
      }
      return response;
    });
    return new Promise(function (resolve, reject) {
      let settled = false;
      const timer = setTimeout(function () {
        cache.match(cacheKey).then(function (cached) {
          if (cached && !settled) {
            settled = true;
            resolve(cached);
          }
        });
      }, NETWORK_TIMEOUT_MS);
      network.then(
        function (response) {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolve(response);
          }
        },
        function () {
          clearTimeout(timer);
          if (settled) return;
          cache
            .match(cacheKey)
            .then(function (cached) {
              // A script or style cached under another version's
              // ?v= still beats nothing (e.g. offline right after an
              // update).
              return cached || (request.mode === 'navigate' ? null : cache.match(request, { ignoreSearch: true }));
            })
            .then(function (cached) {
            settled = true;
            if (cached) resolve(cached);
            else if (request.mode === 'navigate') {
              // Any cached copy of the app's page will do: the route
              // lives in the hash.
              const scope = self.registration.scope;
              cache
                .match(new URL('index.html', scope).href)
                .then(function (index) {
                  return index || cache.match(scope);
                })
                .then(function (page) {
                  resolve(page || offlineAnswer());
                });
            } else resolve(offlineAnswer());
          }, reject);
        },
      );
    });
  });
}

function withOfflineCover(event, id) {
  return fetch(event.request).catch(function () {
    return caches.open(FILES_CACHE).then(function (cache) {
      return cache.match(FILE_PREFIX + id + '/cover').then(function (cached) {
        return cached || offlineAnswer();
      });
    });
  });
}

self.addEventListener('fetch', function (event) {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.indexOf(FILE_PREFIX) === 0) {
    event.respondWith(
      caches.open(FILES_CACHE).then(function (cache) {
        return cache.match(url.pathname).then(function (cached) {
          return cached || new Response('', { status: 404 });
        });
      }),
    );
    return;
  }

  const coverId = coverItemId(url);
  if (coverId) {
    event.respondWith(withOfflineCover(event, coverId));
    return;
  }

  if (isShellRequest(url, request)) {
    // Pages are cached by path (the hash never reaches here), so every
    // route of the app shares one entry.
    const key = request.mode === 'navigate' ? url.origin + url.pathname : request.url;
    event.respondWith(networkFirst(event, key));
  }
});
