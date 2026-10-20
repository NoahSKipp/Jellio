// Persistent stale-while-revalidate cache for the home screen's row
// requests, shared by every open Jellio tab. A new tab paints rows from
// what an earlier tab (or visit) stored, then refreshes them in the
// background: one tab fetches a given request at a time, at most a few
// at once, and only one while a video plays anywhere. Pure apart from
// what createRowCache is given, so tests/frontend/rowcache.test.mjs can
// run it with fake storage, timers, channels and locks.

const MINUTE = 60000;

// Age after which a stored answer is refreshed in the background; it is
// still shown meanwhile. 0: shown at once and always refreshed.
export const TTL_MS = {
  views: 10 * MINUTE,
  collections: 10 * MINUTE,
  rows: 10 * MINUTE,
  hero: 10 * MINUTE,
  watchlist: 10 * MINUTE,
  genres: 30 * MINUTE,
  people: 30 * MINUTE,
  latest: 3 * MINUTE,
  personal: 0,
  user: 0,
};

// What playback, watched/unwatched, the watchlist and finished books
// change.
export const USER_DATA_CLASSES = ['personal', 'latest', 'watchlist'];

// Just fetched (here or in another tab): not asked for again within this,
// even for a class that always refreshes.
export const MIN_REVALIDATE_MS = 5000;

const DEFAULT_MAX_ENTRIES = 400;
const DEFAULT_MAX_BYTES = 6 * 1024 * 1024;
// Bigger answers go over the channel as a key only; other tabs read them
// from shared storage.
const MAX_MESSAGE_BYTES = 512 * 1024;
const LOCK_PREFIX = 'jellio-rowcache:';
const LEASE_PREFIX = 'jellio_rowcache_lease:';
const LEASE_MS = 15000;
const LEASE_POLL_MS = 200;
const PLAYING_HEARTBEAT_MS = 30000;
const PLAYING_EXPIRY_MS = 75000;
const IDB_NAME = 'jellio-rowcache';
const IDB_STORE = 'entries';
const LS_PREFIX = 'jellio_rc:';
const LS_CHANNEL_KEY = 'jellio_rowcache_msg';
const CHANNEL_NAME = 'jellio-rowcache';

// Request params that never change the answer.
const DROP_PARAMS = new Set(['api_key', 'apikey']);

function safeDecode(text) {
  try {
    return decodeURIComponent(String(text).replace(/\+/g, ' '));
  } catch (err) {
    return String(text);
  }
}

// Same request, same key: path lowercased, params sorted by lowercased
// name, credentials left out.
export function normalizePath(path) {
  const text = String(path || '');
  const q = text.indexOf('?');
  const base = (q === -1 ? text : text.slice(0, q)).toLowerCase();
  if (q === -1) return base;
  const pairs = text
    .slice(q + 1)
    .split('&')
    .filter(Boolean)
    .map(function (part) {
      const eq = part.indexOf('=');
      const name = safeDecode(eq === -1 ? part : part.slice(0, eq)).toLowerCase();
      const value = eq === -1 ? '' : safeDecode(part.slice(eq + 1));
      return [name, value];
    })
    .filter(function (pair) {
      return !DROP_PARAMS.has(pair[0]);
    });
  pairs.sort(function (a, b) {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
    return 0;
  });
  if (!pairs.length) return base;
  return (
    base +
    '?' +
    pairs
      .map(function (pair) {
        return encodeURIComponent(pair[0]) + '=' + encodeURIComponent(pair[1]);
      })
      .join('&')
  );
}

export function scopePrefix(scope) {
  const lang = (scope && scope.language) || '';
  return String((scope && scope.serverId) || '') + '|' + String((scope && scope.userId) || '') + '|' + (lang ? lang + '|' : '');
}

export function buildKey(scope, path) {
  return scopePrefix(scope) + normalizePath(path);
}

// FNV-1a over the stored JSON: equal digests mean nothing to re-render.
export function digest(json) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0') + ':' + json.length;
}

export function ttlFor(cls) {
  return Object.prototype.hasOwnProperty.call(TTL_MS, cls) ? TTL_MS[cls] : 10 * MINUTE;
}

// Past this an answer isn't shown at all, not even while it refreshes:
// after a long break the screen loads rows fresh, the way streaming apps
// do, instead of showing days-old Continue Watching for a moment.
const HOUR = 60 * MINUTE;
export const MAX_AGE_MS = {
  personal: 12 * HOUR,
  user: 12 * HOUR,
  latest: 12 * HOUR,
  watchlist: 12 * HOUR,
};
const DEFAULT_MAX_AGE_MS = 7 * 24 * HOUR;

export function isExpired(entry, nowMs) {
  const max = Object.prototype.hasOwnProperty.call(MAX_AGE_MS, entry.cls) ? MAX_AGE_MS[entry.cls] : DEFAULT_MAX_AGE_MS;
  return nowMs - entry.storedAt >= max;
}

export function isStale(entry, nowMs) {
  return nowMs - entry.storedAt >= Math.max(ttlFor(entry.cls), MIN_REVALIDATE_MS);
}

// ---- Storage ---------------------------------------------------------------
// Every adapter: load() -> entries, get(key), put(entry), remove(keys),
// clear(). All async, none throw past a rejected promise.

export function createMemoryStorage(sharedMap) {
  const map = sharedMap || new Map();
  return {
    name: 'memory',
    maxBytes: DEFAULT_MAX_BYTES,
    load: function () {
      return Promise.resolve(Array.from(map.values()).map(copyEntry));
    },
    get: function (key) {
      const entry = map.get(key);
      return Promise.resolve(entry ? copyEntry(entry) : null);
    },
    put: function (entry) {
      map.set(entry.key, copyEntry(entry));
      return Promise.resolve();
    },
    remove: function (keys) {
      keys.forEach(function (key) {
        map.delete(key);
      });
      return Promise.resolve();
    },
    clear: function () {
      map.clear();
      return Promise.resolve();
    },
  };
}

function copyEntry(entry) {
  return {
    key: entry.key,
    cls: entry.cls,
    json: entry.json,
    digest: entry.digest,
    storedAt: entry.storedAt,
    usedAt: entry.usedAt,
    size: entry.size,
  };
}

export function createLocalStorageStorage(ls) {
  function readEntry(storageKey) {
    try {
      const raw = ls.getItem(storageKey);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null;
    }
  }
  function allKeys() {
    const keys = [];
    try {
      for (let i = 0; i < ls.length; i++) {
        const name = ls.key(i);
        if (name && name.indexOf(LS_PREFIX) === 0) keys.push(name);
      }
    } catch (err) {}
    return keys;
  }
  return {
    name: 'localStorage',
    // Shares the origin's ~5 MB with the rest of the app.
    maxBytes: 1.5 * 1024 * 1024,
    load: function () {
      return Promise.resolve(allKeys().map(readEntry).filter(Boolean));
    },
    get: function (key) {
      return Promise.resolve(readEntry(LS_PREFIX + key));
    },
    put: function (entry) {
      try {
        ls.setItem(LS_PREFIX + entry.key, JSON.stringify(copyEntry(entry)));
        return Promise.resolve();
      } catch (err) {
        return Promise.reject(err);
      }
    },
    remove: function (keys) {
      keys.forEach(function (key) {
        try {
          ls.removeItem(LS_PREFIX + key);
        } catch (err) {}
      });
      return Promise.resolve();
    },
    clear: function () {
      allKeys().forEach(function (name) {
        try {
          ls.removeItem(name);
        } catch (err) {}
      });
      return Promise.resolve();
    },
  };
}

function idbRequest(request) {
  return new Promise(function (resolve, reject) {
    request.onsuccess = function () {
      resolve(request.result);
    };
    request.onerror = function () {
      reject(request.error);
    };
  });
}

export function openIndexedDbStorage(idb, timeoutMs) {
  return new Promise(function (resolve, reject) {
    let settled = false;
    const timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      reject(new Error('IndexedDB open timed out'));
    }, timeoutMs || 1500);
    let request;
    try {
      request = idb.open(IDB_NAME, 1);
    } catch (err) {
      clearTimeout(timer);
      reject(err);
      return;
    }
    request.onupgradeneeded = function () {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE, { keyPath: 'key' });
    };
    request.onerror = request.onblocked = function () {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(request.error || new Error('IndexedDB blocked'));
    };
    request.onsuccess = function () {
      const db = request.result;
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      // Another tab deleting or upgrading the database.
      db.onversionchange = function () {
        db.close();
      };
      function store(mode) {
        return db.transaction(IDB_STORE, mode).objectStore(IDB_STORE);
      }
      resolve({
        name: 'indexedDB',
        maxBytes: DEFAULT_MAX_BYTES,
        load: function () {
          return idbRequest(store('readonly').getAll());
        },
        get: function (key) {
          return idbRequest(store('readonly').get(key)).then(function (entry) {
            return entry || null;
          });
        },
        put: function (entry) {
          return idbRequest(store('readwrite').put(copyEntry(entry)));
        },
        remove: function (keys) {
          if (!keys.length) return Promise.resolve();
          const objectStore = store('readwrite');
          return Promise.all(
            keys.map(function (key) {
              return idbRequest(objectStore.delete(key));
            }),
          );
        },
        clear: function () {
          return idbRequest(store('readwrite').clear());
        },
      });
    };
  });
}

// IndexedDB, else localStorage, else memory. Never rejects.
export function pickStorage(env) {
  const scope = env || {};
  function localOrMemory() {
    try {
      const ls = scope.localStorage;
      if (ls) {
        ls.setItem(LS_PREFIX + '__probe', '1');
        ls.removeItem(LS_PREFIX + '__probe');
        return createLocalStorageStorage(ls);
      }
    } catch (err) {}
    return createMemoryStorage();
  }
  try {
    if (scope.indexedDB) {
      return openIndexedDbStorage(scope.indexedDB, 1500)
        .then(function (storage) {
          // A first real read: some browsers open fine and then fail here.
          return storage.get('__probe').then(function () {
            return storage;
          });
        })
        .catch(localOrMemory);
    }
  } catch (err) {}
  return Promise.resolve(localOrMemory());
}

// ---- Cross-tab channel -----------------------------------------------------
// { post(message), subscribe(listener) -> unsubscribe, close() }

export function createTabChannel(env) {
  const scope = env || {};
  try {
    if (typeof scope.BroadcastChannel === 'function') {
      const bc = new scope.BroadcastChannel(CHANNEL_NAME);
      const listeners = new Set();
      bc.onmessage = function (event) {
        listeners.forEach(function (listener) {
          try {
            listener(event.data);
          } catch (err) {}
        });
      };
      return {
        kind: 'broadcast',
        post: function (message) {
          try {
            bc.postMessage(message);
          } catch (err) {}
        },
        subscribe: function (listener) {
          listeners.add(listener);
          return function () {
            listeners.delete(listener);
          };
        },
        close: function () {
          try {
            bc.close();
          } catch (err) {}
        },
      };
    }
  } catch (err) {}
  // Fallback: a localStorage write fires 'storage' in every other tab.
  try {
    const ls = scope.localStorage;
    if (ls && typeof scope.addEventListener === 'function') {
      const listeners = new Set();
      const onStorage = function (event) {
        if (event.key !== LS_CHANNEL_KEY || !event.newValue) return;
        let data;
        try {
          data = JSON.parse(event.newValue).message;
        } catch (err) {
          return;
        }
        listeners.forEach(function (listener) {
          try {
            listener(data);
          } catch (err) {}
        });
      };
      scope.addEventListener('storage', onStorage);
      let seq = 0;
      return {
        kind: 'storage',
        post: function (message) {
          try {
            ls.setItem(LS_CHANNEL_KEY, JSON.stringify({ message: message, nonce: Date.now() + ':' + seq++ }));
          } catch (err) {}
        },
        subscribe: function (listener) {
          listeners.add(listener);
          return function () {
            listeners.delete(listener);
          };
        },
        close: function () {
          scope.removeEventListener('storage', onStorage);
        },
      };
    }
  } catch (err) {}
  return null;
}

// ---- Concurrency limiter ---------------------------------------------------

// Runs tasks with at most getMax() in flight, lowest priority number
// first, then in the order they were queued.
export function createLimiter(getMax) {
  let active = 0;
  let seq = 0;
  const queue = [];
  function pump() {
    while (queue.length && active < Math.max(1, getMax())) {
      queue.sort(function (a, b) {
        return a.priority - b.priority || a.seq - b.seq;
      });
      const next = queue.shift();
      active++;
      next.start();
    }
  }
  function run(priority, task) {
    return new Promise(function (resolve, reject) {
      queue.push({
        priority: typeof priority === 'number' ? priority : 5,
        seq: seq++,
        start: function () {
          Promise.resolve()
            .then(task)
            .then(resolve, reject)
            .finally(function () {
              active--;
              pump();
            });
        },
      });
      pump();
    });
  }
  return {
    run: run,
    pump: pump,
    get active() {
      return active;
    },
    get queued() {
      return queue.length;
    },
  };
}

// ---- The cache -------------------------------------------------------------

export function createRowCache(options) {
  const opts = options || {};
  const now = opts.now || Date.now;
  const random = opts.random || Math.random;
  const setTimer = opts.setTimeout || setTimeout;
  const clearTimer = opts.clearTimeout || clearTimeout;
  const maxEntries = opts.maxEntries || DEFAULT_MAX_ENTRIES;
  const maxConcurrent = opts.maxConcurrent || 3;
  const jitterMs = opts.jitterMs == null ? 400 : opts.jitterMs;
  const readyTimeoutMs = opts.readyTimeoutMs == null ? 300 : opts.readyTimeoutMs;
  const channel = opts.channel || null;
  const locks = opts.locks || null;
  const leaseStore = opts.leaseStore || null;
  const tabId = opts.tabId || 'tab-' + now().toString(36) + '-' + Math.floor(random() * 1e9).toString(36);

  let scope = opts.scope || { serverId: '', userId: '', language: '' };
  let storage = null;
  let maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
  const index = new Map();
  let totalBytes = 0;
  const inflight = new Map();
  // How this tab asked for each key, so it can refresh them after a break.
  const known = new Map();
  const listeners = new Set();
  const generations = {};
  const remotePlaying = new Map();
  let localPlaying = false;
  let heartbeat = null;
  let closed = false;
  const stats = { hits: 0, stale: 0, misses: 0, fetches: 0, fromOtherTabs: 0, invalidations: 0 };

  const limiter = createLimiter(function () {
    return isPlayingAnywhere() ? 1 : maxConcurrent;
  });

  function sleep(ms) {
    return new Promise(function (resolve) {
      if (!ms) resolve();
      else setTimer(resolve, ms);
    });
  }

  function generation(cls) {
    return generations[cls] || 0;
  }

  function setIndex(entry) {
    const old = index.get(entry.key);
    if (old) totalBytes -= old.size;
    index.set(entry.key, entry);
    totalBytes += entry.size;
  }

  function dropIndex(key) {
    const old = index.get(key);
    if (!old) return false;
    totalBytes -= old.size;
    index.delete(key);
    return true;
  }

  // Least recently used out first, over the entry count or total size.
  function enforceLimits() {
    const evicted = [];
    if (index.size <= maxEntries && totalBytes <= maxBytes) return evicted;
    const byUse = Array.from(index.values()).sort(function (a, b) {
      return a.usedAt - b.usedAt;
    });
    for (let i = 0; i < byUse.length && (index.size > maxEntries || totalBytes > maxBytes); i++) {
      dropIndex(byUse[i].key);
      evicted.push(byUse[i].key);
    }
    if (evicted.length && storage) storage.remove(evicted).catch(function () {});
    return evicted;
  }

  function emit(event) {
    listeners.forEach(function (listener) {
      try {
        listener(event);
      } catch (err) {}
    });
  }

  function post(message) {
    if (!channel || closed) return;
    channel.post(Object.assign({ from: tabId }, message));
  }

  function inScope(key) {
    return key.indexOf(scopePrefix(scope)) === 0;
  }

  const ready = Promise.resolve(opts.storage)
    .then(function (picked) {
      storage = picked || createMemoryStorage();
      if (!opts.maxBytes && storage.maxBytes) maxBytes = storage.maxBytes;
      return storage.load();
    })
    .then(function (entries) {
      let foreign = false;
      const expired = [];
      (entries || []).forEach(function (entry) {
        if (!entry || !entry.key || typeof entry.json !== 'string') return;
        if (!inScope(entry.key)) {
          foreign = true;
          return;
        }
        if (isExpired(entry, now())) {
          expired.push(entry.key);
          return;
        }
        setIndex(copyEntry(entry));
      });
      // Another user or server: start over.
      if (foreign || opts.wipeOnStart) return wipe({ broadcast: false });
      if (expired.length) storage.remove(expired).catch(function () {});
      enforceLimits();
      return undefined;
    })
    .catch(function () {
      storage = createMemoryStorage();
      index.clear();
      totalBytes = 0;
    });

  // Never holds a row back for long on slow storage: past the timeout it
  // counts as a miss.
  function waitReady() {
    if (!readyTimeoutMs) return ready;
    return Promise.race([ready, sleep(readyTimeoutMs)]);
  }

  function parse(entry) {
    return JSON.parse(entry.json);
  }

  function keyFor(path) {
    return buildKey(scope, path);
  }

  // Stores a fresh answer. Returns whether it differs from what was here.
  function store(key, cls, json, storedAt) {
    const old = index.get(key);
    const entry = {
      key: key,
      cls: cls,
      json: json,
      digest: digest(json),
      storedAt: storedAt,
      usedAt: now(),
      size: json.length,
    };
    // Too big to keep at all.
    if (entry.size > maxBytes / 2) {
      if (old) {
        dropIndex(key);
        storage.remove([key]).catch(function () {});
      }
      return false;
    }
    setIndex(entry);
    enforceLimits();
    if (index.has(key)) {
      storage.put(entry).catch(function () {
        // Storage full: keep it in memory for this tab only.
      });
      post({
        type: 'put',
        entry: entry.size <= MAX_MESSAGE_BYTES ? entry : Object.assign(copyEntry(entry), { json: null }),
      });
    }
    const changed = !!old && old.digest !== entry.digest;
    if (changed) emit({ type: 'change', keys: [key], classes: [cls] });
    return changed;
  }

  // The newest copy anywhere: this tab's index, or shared storage another
  // tab wrote to without the channel telling us.
  function readShared(key) {
    const local = index.get(key) || null;
    if (!storage || !storage.get) return Promise.resolve(local);
    return storage
      .get(key)
      .catch(function () {
        return null;
      })
      .then(function (stored) {
        if (stored && typeof stored.json === 'string' && (!local || stored.storedAt > local.storedAt)) {
          const old = index.get(key);
          setIndex(copyEntry(stored));
          if (old && old.digest !== stored.digest) emit({ type: 'change', keys: [key], classes: [stored.cls] });
          return stored;
        }
        return local;
      });
  }

  function withLock(key, task) {
    if (locks && typeof locks.request === 'function') {
      return locks.request(LOCK_PREFIX + key, { mode: 'exclusive' }, function () {
        return task();
      });
    }
    if (leaseStore) return withLease(key, task);
    return task();
  }

  // Web Locks stand-in: a timestamped lease in localStorage. Waits while
  // another tab holds a live one, then takes it.
  async function withLease(key, task) {
    const leaseKey = LEASE_PREFIX + key;
    const giveUpAt = now() + LEASE_MS;
    function readLease() {
      try {
        const raw = leaseStore.getItem(leaseKey);
        return raw ? JSON.parse(raw) : null;
      } catch (err) {
        return null;
      }
    }
    for (;;) {
      const lease = readLease();
      if (!lease || lease.owner === tabId || lease.until <= now() || now() >= giveUpAt) break;
      await sleep(LEASE_POLL_MS);
    }
    try {
      leaseStore.setItem(leaseKey, JSON.stringify({ owner: tabId, until: now() + LEASE_MS }));
    } catch (err) {}
    try {
      return await task();
    } finally {
      const lease = readLease();
      if (lease && lease.owner === tabId) {
        try {
          leaseStore.removeItem(leaseKey);
        } catch (err) {}
      }
    }
  }

  function fetchAndStore(key, cls, fetcher, priority, background) {
    const existing = inflight.get(key);
    if (existing) return existing;
    const gen = generation(cls);
    const before = index.get(key);
    const task = function () {
      return withLock(key, function () {
        return readShared(key).then(function (shared) {
          // Another tab fetched it while this one waited for the lock.
          const fresh =
            shared &&
            (now() - shared.storedAt < MIN_REVALIDATE_MS || (!background && !isStale(shared, now()))) &&
            (!before || shared.storedAt > before.storedAt || !background);
          // Counts requests this tab didn't have to send.
          if (fresh) {
            stats.fromOtherTabs++;
            return parse(shared);
          }
          stats.fetches++;
          const startedAt = now();
          return Promise.resolve(fetcher()).then(function (value) {
            // Invalidated while this was out: the answer may predate the
            // change, so it is used once and not kept.
            if (generation(cls) === gen && !closed) {
              store(key, cls, JSON.stringify(value === undefined ? null : value), startedAt);
            }
            return value;
          });
        });
      });
    };
    const run = background
      ? sleep(jitterMs ? Math.floor(random() * jitterMs) : 0).then(function () {
          return limiter.run(priority, task);
        })
      : limiter.run(priority, task);
    const tracked = run.finally(function () {
      if (inflight.get(key) === tracked) inflight.delete(key);
    });
    inflight.set(key, tracked);
    return tracked;
  }

  // The stored answer at once when there is one, refreshing it in the
  // background once it's old; otherwise fetched (one tab at a time).
  async function get(path, cls, fetcher, getOptions) {
    const o = getOptions || {};
    await waitReady();
    const key = keyFor(path);
    known.set(key, { cls: cls, fetcher: fetcher, priority: o.priority });
    let entry = index.get(key);
    if (entry && isExpired(entry, now())) {
      dropIndex(key);
      if (storage) storage.remove([key]).catch(function () {});
      entry = null;
    }
    if (entry && entry.cls === cls) {
      entry.usedAt = now();
      if (isStale(entry, now())) {
        stats.stale++;
        fetchAndStore(key, cls, fetcher, o.priority, true).catch(function () {});
      } else {
        stats.hits++;
      }
      return parse(entry);
    }
    stats.misses++;
    return fetchAndStore(key, cls, fetcher, o.priority, false);
  }

  // Back from a break (tab in front again, laptop awake, network back):
  // every row this tab has shown that is past its refresh age is fetched
  // again in the background, Continue Watching and Up Next always. Only
  // answers that actually differ are announced, so rows that didn't
  // change stay put. Returns how many refreshes started.
  function revalidateStale() {
    let started = 0;
    known.forEach(function (request, key) {
      const entry = index.get(key);
      if (!entry || entry.cls !== request.cls || inflight.has(key)) return;
      if (isExpired(entry, now()) || isStale(entry, now())) {
        started++;
        fetchAndStore(key, request.cls, request.fetcher, request.priority, true).catch(function () {});
      }
    });
    return started;
  }

  function peek(path) {
    const entry = index.get(keyFor(path));
    return entry ? parse(entry) : undefined;
  }

  function invalidateLocal(classes) {
    const wanted = new Set(classes);
    wanted.forEach(function (cls) {
      generations[cls] = generation(cls) + 1;
    });
    const keys = [];
    index.forEach(function (entry, key) {
      if (wanted.has(entry.cls)) keys.push(key);
    });
    keys.forEach(dropIndex);
    return keys;
  }

  // Drops every entry of these classes here and in every other tab.
  function invalidate(classes) {
    const list = Array.isArray(classes) ? classes : [classes];
    stats.invalidations++;
    const keys = invalidateLocal(list);
    if (keys.length && storage) storage.remove(keys).catch(function () {});
    post({ type: 'invalidate', classes: list });
    emit({ type: 'invalidate', keys: keys, classes: list });
  }

  function wipe(wipeOptions) {
    const o = wipeOptions || {};
    Object.keys(TTL_MS).forEach(function (cls) {
      generations[cls] = generation(cls) + 1;
    });
    const hadEntries = index.size > 0;
    index.clear();
    totalBytes = 0;
    if (o.broadcast !== false) post({ type: 'wipe' });
    if (hadEntries) emit({ type: 'wipe', keys: [], classes: Object.keys(TTL_MS) });
    return storage ? storage.clear().catch(function () {}) : Promise.resolve();
  }

  // Signed in as someone else, or on another server: start over.
  function setScope(next) {
    if (scopePrefix(next) === scopePrefix(scope)) return;
    scope = { serverId: next.serverId, userId: next.userId, language: next.language || '' };
    wipe();
  }

  function isPlayingElsewhere() {
    const t = now();
    let playing = false;
    remotePlaying.forEach(function (until, id) {
      if (until <= t) remotePlaying.delete(id);
      else playing = true;
    });
    return playing;
  }

  function isPlayingAnywhere() {
    return localPlaying || isPlayingElsewhere();
  }

  function announcePlaying() {
    post({ type: 'playing', tab: tabId, playing: localPlaying, until: now() + PLAYING_EXPIRY_MS });
  }

  function setPlaying(playing) {
    const next = !!playing;
    if (next === localPlaying) return;
    localPlaying = next;
    announcePlaying();
    if (heartbeat) {
      clearTimer(heartbeat);
      heartbeat = null;
    }
    if (next) {
      const beat = function () {
        if (closed || !localPlaying) return;
        announcePlaying();
        heartbeat = setTimer(beat, PLAYING_HEARTBEAT_MS);
      };
      heartbeat = setTimer(beat, PLAYING_HEARTBEAT_MS);
    }
    limiter.pump();
  }

  function applyRemoteEntry(entry) {
    if (!entry || !entry.key || !inScope(entry.key)) return;
    const old = index.get(entry.key);
    if (old && old.storedAt >= entry.storedAt) return;
    setIndex(copyEntry(entry));
    enforceLimits();
    if (old && old.digest !== entry.digest) emit({ type: 'change', keys: [entry.key], classes: [entry.cls] });
  }

  function onMessage(message) {
    if (!message || message.from === tabId || closed) return;
    if (message.type === 'put' && message.entry) {
      if (typeof message.entry.json === 'string') {
        applyRemoteEntry(message.entry);
      } else if (storage) {
        storage
          .get(message.entry.key)
          .then(applyRemoteEntry)
          .catch(function () {});
      }
    } else if (message.type === 'invalidate' && Array.isArray(message.classes)) {
      const keys = invalidateLocal(message.classes);
      emit({ type: 'invalidate', keys: keys, classes: message.classes });
    } else if (message.type === 'wipe') {
      Object.keys(TTL_MS).forEach(function (cls) {
        generations[cls] = generation(cls) + 1;
      });
      const hadEntries = index.size > 0;
      index.clear();
      totalBytes = 0;
      if (hadEntries) emit({ type: 'wipe', keys: [], classes: Object.keys(TTL_MS) });
    } else if (message.type === 'playing' && message.tab) {
      if (message.playing) remotePlaying.set(message.tab, message.until || now() + PLAYING_EXPIRY_MS);
      else remotePlaying.delete(message.tab);
      limiter.pump();
    } else if (message.type === 'hello' && localPlaying) {
      announcePlaying();
    }
  }

  const unsubscribeChannel = channel ? channel.subscribe(onMessage) : null;
  // Tabs already playing say so, so a new tab starts throttled.
  post({ type: 'hello' });

  return {
    tabId: tabId,
    ready: ready,
    get: get,
    peek: peek,
    revalidateStale: revalidateStale,
    get isPlayingHere() {
      return localPlaying;
    },
    invalidate: invalidate,
    wipe: wipe,
    setScope: setScope,
    setPlaying: setPlaying,
    isPlayingElsewhere: isPlayingElsewhere,
    isPlayingAnywhere: isPlayingAnywhere,
    get storageName() {
      return storage ? storage.name : 'pending';
    },
    get size() {
      return index.size;
    },
    get bytes() {
      return totalBytes;
    },
    get limiter() {
      return limiter;
    },
    stats: function () {
      return Object.assign({}, stats);
    },
    onChange: function (listener) {
      listeners.add(listener);
      return function () {
        listeners.delete(listener);
      };
    },
    close: function () {
      closed = true;
      if (heartbeat) clearTimer(heartbeat);
      if (unsubscribeChannel) unsubscribeChannel();
    },
  };
}

// Logout from a tab with no cache instance at hand: every open tab drops
// its rows now, and storage is cleared on the next start (and right away
// when the browser lets it finish before the reload).
export function requestRowCacheWipe(env) {
  const scope = env || {};
  try {
    if (scope.localStorage) {
      scope.localStorage.setItem('jellio_rowcache_wipe', '1');
      createLocalStorageStorage(scope.localStorage).clear();
    }
  } catch (err) {}
  const channel = createTabChannel(scope);
  if (channel) {
    channel.post({ from: 'logout', type: 'wipe' });
    channel.close();
  }
  try {
    if (scope.indexedDB) {
      openIndexedDbStorage(scope.indexedDB, 1000)
        .then(function (storage) {
          return storage.clear();
        })
        .catch(function () {});
    }
  } catch (err) {}
}

// Calls onReturn({ awayMs, reason }) when the page comes back after at
// least minAwayMs: the tab in front again, the machine awake (timers
// stalled while the tab was visible), a page restored from the
// back/forward cache, or the network back. At most once per cooldown.
export function createReturnWatcher(env, onReturn, options) {
  const o = options || {};
  const doc = env.document;
  const win = env.window;
  const now = o.now || Date.now;
  const minAwayMs = o.minAwayMs == null ? 60000 : o.minAwayMs;
  const tickMs = o.tickMs || 20000;
  const cooldownMs = o.cooldownMs == null ? 10000 : o.cooldownMs;
  const setIntervalFn = o.setInterval || setInterval;
  const clearIntervalFn = o.clearInterval || clearInterval;
  let lastTick = now();
  let hiddenAt = doc && doc.visibilityState === 'hidden' ? now() : null;
  let lastFired = -Infinity;

  function fire(awayMs, reason) {
    const t = now();
    if (awayMs < minAwayMs || t - lastFired < cooldownMs) return;
    lastFired = t;
    try {
      onReturn({ awayMs: awayMs, reason: reason });
    } catch (err) {}
  }
  function onVisibility() {
    if (doc.visibilityState === 'hidden') {
      hiddenAt = now();
      return;
    }
    const since = hiddenAt == null ? lastTick : hiddenAt;
    hiddenAt = null;
    lastTick = now();
    fire(now() - since, 'visible');
  }
  // A visible tab's timer runs every tickMs; a much longer gap means the
  // machine slept.
  function onTick() {
    const t = now();
    const gap = t - lastTick;
    lastTick = t;
    if (doc.visibilityState !== 'hidden' && gap >= tickMs + minAwayMs) fire(gap, 'wake');
  }
  function onPageShow(event) {
    if (event && event.persisted) fire(now() - lastTick, 'restored');
    lastTick = now();
  }
  function onOnline() {
    fire(Infinity, 'online');
  }

  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('pageshow', onPageShow);
  win.addEventListener('online', onOnline);
  const timer = setIntervalFn(onTick, tickMs);
  return function stop() {
    doc.removeEventListener('visibilitychange', onVisibility);
    win.removeEventListener('pageshow', onPageShow);
    win.removeEventListener('online', onOnline);
    clearIntervalFn(timer);
  };
}
