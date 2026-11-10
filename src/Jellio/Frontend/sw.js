const SHELL_CACHE = 'jellio-shell-v2';
const FILES_CACHE = 'jellio-offline-files';
const FILE_PREFIX = '/__jellio_offline__/';
const NETWORK_TIMEOUT_MS = 10000;
const VERSIONED_PREFIX = '/Jellio/frontend/';

// Set by the page (runtime/offline.js): while the server is unreachable,
// cover requests go through here so downloaded covers can stand in.
let serverOffline = false;
self.addEventListener('message', function (event) {
  const data = event.data;
  if (data && data.type === 'jellio-connectivity') serverOffline = Boolean(data.offline);
});

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
        return caches.open(SHELL_CACHE).then(function (cache) {
          return cache.keys().then(function (requests) {
            const urls = requests.map(function (request) {
              return request.url;
            });
            return deleteUrls(cache, staleVersionedUrls(urls));
          });
        });
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

// The ?v= of a frontend asset URL, or null. Those URLs never change content.
function assetVersion(href) {
  const url = new URL(href);
  if (url.origin !== self.location.origin || url.pathname.indexOf(VERSIONED_PREFIX) !== 0) return null;
  return url.searchParams.get('v') || null;
}

function compareVersions(a, b) {
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = parseInt(pa[i] || '0', 10) || 0;
    const nb = parseInt(pb[i] || '0', 10) || 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}

// All but the newest cached version of each frontend asset.
function staleVersionedUrls(urls) {
  const newest = {};
  urls.forEach(function (href) {
    const version = assetVersion(href);
    if (!version) return;
    const path = new URL(href).pathname;
    if (!newest[path] || compareVersions(version, newest[path]) > 0) newest[path] = version;
  });
  return urls.filter(function (href) {
    const version = assetVersion(href);
    return version !== null && version !== newest[new URL(href).pathname];
  });
}

// Other cached versions of the asset at href.
function otherVersionUrls(urls, href) {
  const path = new URL(href).pathname;
  const version = assetVersion(href);
  return urls.filter(function (other) {
    const otherVersion = assetVersion(other);
    return otherVersion !== null && otherVersion !== version && new URL(other).pathname === path;
  });
}

function deleteUrls(cache, urls) {
  return Promise.all(
    urls.map(function (href) {
      return cache.delete(href);
    }),
  );
}

// Immutable: served from the cache when there, fetched and kept otherwise,
// replacing the copies of older versions. With no network and no copy of
// this version, an older one is better than nothing.
function cacheFirst(event) {
  const request = event.request;
  return caches.open(SHELL_CACHE).then(function (cache) {
    return cache.match(request.url).then(function (cached) {
      if (cached) return cached;
      return fetch(request).then(
        function (response) {
          if (response && response.ok && response.type === 'basic') {
            const copy = response.clone();
            event.waitUntil(
              cache.put(request.url, copy).then(function () {
                return cache.keys().then(function (requests) {
                  const urls = requests.map(function (r) {
                    return r.url;
                  });
                  return deleteUrls(cache, otherVersionUrls(urls, request.url));
                });
              }),
            );
          }
          return response;
        },
        function () {
          return cache.match(request, { ignoreSearch: true }).then(function (older) {
            return older || offlineAnswer();
          });
        },
      );
    });
  });
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
      const timer =
        request.mode === 'navigate'
          ? setTimeout(function () {
              cache.match(cacheKey).then(function (cached) {
                if (cached && !settled) {
                  settled = true;
                  resolve(cached);
                }
              });
            }, NETWORK_TIMEOUT_MS)
          : null;
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
    // Online, the browser fetches images itself instead of piping them through here.
    if (serverOffline || self.navigator.onLine === false) event.respondWith(withOfflineCover(event, coverId));
    return;
  }

  if (request.mode !== 'navigate' && assetVersion(request.url)) {
    event.respondWith(cacheFirst(event));
    return;
  }

  if (isShellRequest(url, request)) {
    // Pages are cached by path (the hash never reaches here), so every
    // route of the app shares one entry.
    const key = request.mode === 'navigate' ? url.origin + url.pathname : request.url;
    event.respondWith(networkFirst(event, key));
  }
});
