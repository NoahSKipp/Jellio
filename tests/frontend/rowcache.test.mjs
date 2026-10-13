import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildKey,
  normalizePath,
  isStale,
  TTL_MS,
  MIN_REVALIDATE_MS,
  USER_DATA_CLASSES,
  createRowCache,
  createMemoryStorage,
  createLimiter,
  pickStorage,
  isExpired,
  createReturnWatcher,
} from '../../src/Jellio/Frontend/runtime/rowcache.js';

const scope = { serverId: 'srv', userId: 'u1' };
const RESUME = '/Users/u1/Items/Resume?Limit=20&MediaTypes=Video';
const VIEWS = '/Users/u1/Views';

// Channels that deliver to every other tab, asynchronously, like BroadcastChannel.
function createHub() {
  const members = new Set();
  return function channel() {
    const listeners = new Set();
    const self = {
      post(message) {
        members.forEach((member) => {
          if (member !== self) queueMicrotask(() => member.deliver(message));
        });
      },
      deliver(message) {
        listeners.forEach((listener) => listener(message));
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close() {
        members.delete(self);
      },
    };
    members.add(self);
    return self;
  };
}

// navigator.locks stand-in: one holder per name, the rest wait in order.
function createLocks() {
  const tails = new Map();
  return {
    request(name, options, callback) {
      const previous = tails.get(name) || Promise.resolve();
      const run = previous.then(() => callback({ name }));
      tails.set(name, run.catch(() => {}));
      return run;
    },
  };
}

function clock(start) {
  let t = start || 1_000_000;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function cacheFor(overrides) {
  return createRowCache(Object.assign({ scope, jitterMs: 0, readyTimeoutMs: 0 }, overrides));
}

test('keys: same request in any order or case, credentials dropped, scoped per server and user', () => {
  const a = buildKey(scope, '/Users/u1/Items?SortBy=Name&Limit=5&api_key=secret');
  const b = buildKey(scope, '/users/U1/items?limit=5&sortby=Name');
  assert.equal(a, b);
  assert.ok(!a.includes('secret'));
  assert.notEqual(a, buildKey({ serverId: 'srv', userId: 'u2' }, '/Users/u1/Items?SortBy=Name&Limit=5'));
  assert.notEqual(a, buildKey({ serverId: 'other', userId: 'u1' }, '/Users/u1/Items?SortBy=Name&Limit=5'));
  assert.equal(normalizePath('/Shows/NextUp?userId=x&Limit=20'), normalizePath('/shows/nextup?limit=20&UserId=x'));
  assert.notEqual(normalizePath('/Items?Genres=Drama'), normalizePath('/Items?Genres=drama'));
});

test('staleness follows each class TTL; personal rows always refresh after a few seconds', () => {
  const t = 5_000_000;
  const entry = (cls, age) => ({ cls, storedAt: t - age });
  assert.equal(isStale(entry('views', TTL_MS.views - 1), t), false);
  assert.equal(isStale(entry('views', TTL_MS.views), t), true);
  assert.equal(isStale(entry('genres', 29 * 60000), t), false);
  assert.equal(isStale(entry('latest', 3 * 60000), t), true);
  assert.equal(isStale(entry('personal', MIN_REVALIDATE_MS - 1), t), false);
  assert.equal(isStale(entry('personal', MIN_REVALIDATE_MS), t), true);
});

test('a miss fetches and stores; a fresh hit serves without a request', async () => {
  const c = clock();
  const cache = cacheFor({ now: c.now });
  let fetches = 0;
  const fetcher = async () => {
    fetches++;
    return { Items: [1, 2] };
  };
  assert.deepEqual(await cache.get(VIEWS, 'views', fetcher), { Items: [1, 2] });
  c.advance(60000);
  assert.deepEqual(await cache.get(VIEWS, 'views', fetcher), { Items: [1, 2] });
  assert.equal(fetches, 1);
  assert.deepEqual(cache.stats().hits, 1);
});

test('stale answers come back at once, refresh in the background, and only a real change is announced', async () => {
  const c = clock();
  const cache = cacheFor({ now: c.now });
  let payload = { Items: ['a'] };
  let fetches = 0;
  const fetcher = async () => {
    fetches++;
    return payload;
  };
  const events = [];
  cache.onChange((event) => events.push(event));
  await cache.get(RESUME, 'personal', fetcher);
  c.advance(MIN_REVALIDATE_MS);

  // Same payload: refreshed, nothing announced.
  assert.deepEqual(await cache.get(RESUME, 'personal', fetcher), { Items: ['a'] });
  await tick();
  await tick();
  assert.equal(fetches, 2);
  assert.equal(events.length, 0);

  // Changed payload: the stale one is still served first, then announced.
  c.advance(MIN_REVALIDATE_MS);
  payload = { Items: ['b'] };
  assert.deepEqual(await cache.get(RESUME, 'personal', fetcher), { Items: ['a'] });
  await tick();
  await tick();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].classes, ['personal']);
  c.advance(1000);
  assert.deepEqual(await cache.get(RESUME, 'personal', fetcher), { Items: ['b'] });
});

test('playback and watched events drop personal rows in every tab; older in-flight answers are not kept', async () => {
  const hub = createHub();
  const shared = new Map();
  const c = clock();
  const tabA = cacheFor({ now: c.now, channel: hub(), storage: createMemoryStorage(shared) });
  const tabB = cacheFor({ now: c.now, channel: hub(), storage: createMemoryStorage(shared) });
  await tabA.get(RESUME, 'personal', async () => ({ v: 1 }));
  await tabA.get(VIEWS, 'views', async () => ({ v: 'views' }));
  await tick();
  assert.equal(tabB.peek(RESUME).v, 1);

  // A refresh that started before the invalidation.
  let release;
  const slow = new Promise((resolve) => {
    release = resolve;
  });
  c.advance(MIN_REVALIDATE_MS);
  tabA.get(RESUME, 'personal', () => slow);
  await tick();
  tabA.invalidate(USER_DATA_CLASSES);
  release({ v: 'from before' });
  await tick();
  await tick();

  assert.equal(tabA.peek(RESUME), undefined);
  assert.equal(tabB.peek(RESUME), undefined);
  assert.equal(shared.size, 1, 'only views stays stored');
  assert.equal(tabB.peek(VIEWS).v, 'views');

  let fetched = 0;
  assert.deepEqual(await tabB.get(RESUME, 'personal', async () => (fetched++, { v: 2 })), { v: 2 });
  assert.equal(fetched, 1);
});

test('logout wipes every tab and storage; another user or server starts over', async () => {
  const hub = createHub();
  const shared = new Map();
  const tabA = cacheFor({ channel: hub(), storage: createMemoryStorage(shared) });
  const tabB = cacheFor({ channel: hub(), storage: createMemoryStorage(shared) });
  await tabA.get(VIEWS, 'views', async () => ({ v: 1 }));
  await tick();
  assert.equal(tabB.size, 1);
  await tabA.wipe();
  await tick();
  assert.equal(shared.size, 0);
  assert.equal(tabB.size, 0);

  await tabA.get(VIEWS, 'views', async () => ({ v: 1 }));
  tabA.setScope({ serverId: 'srv', userId: 'u2' });
  await tick();
  assert.equal(tabA.size, 0);
  assert.equal(shared.size, 0);

  // Entries stored for another user are dropped when a tab starts.
  const leftover = new Map();
  const old = cacheFor({ storage: createMemoryStorage(leftover), scope: { serverId: 'srv', userId: 'someone' } });
  await old.get(VIEWS, 'views', async () => ({ v: 'theirs' }));
  const fresh = cacheFor({ storage: createMemoryStorage(leftover) });
  await fresh.ready;
  assert.equal(fresh.size, 0);
  assert.equal(leftover.size, 0);

  // A wipe requested at logout (no cache in that tab) happens on the next start.
  const pending = new Map();
  const before = cacheFor({ storage: createMemoryStorage(pending) });
  await before.get(VIEWS, 'views', async () => ({ v: 1 }));
  const after = cacheFor({ storage: createMemoryStorage(pending), wipeOnStart: true });
  await after.ready;
  assert.equal(after.size, 0);
  assert.equal(pending.size, 0);
});

test('least recently used entries go first, by count and by size', async () => {
  const c = clock();
  const storageMap = new Map();
  const cache = cacheFor({ now: c.now, maxEntries: 3, storage: createMemoryStorage(storageMap) });
  for (const name of ['a', 'b', 'c']) {
    c.advance(10);
    await cache.get('/x/' + name, 'views', async () => ({ name }));
  }
  c.advance(10);
  await cache.get('/x/a', 'views', async () => ({ name: 'a' })); // a used again
  c.advance(10);
  await cache.get('/x/d', 'views', async () => ({ name: 'd' }));
  await tick();
  assert.equal(cache.peek('/x/b'), undefined);
  assert.ok(cache.peek('/x/a'));
  assert.equal(cache.size, 3);
  assert.equal(storageMap.size, 3);

  const small = cacheFor({ now: c.now, maxBytes: 300 });
  await small.get('/big/1', 'views', async () => ({ pad: 'x'.repeat(100) }));
  c.advance(10);
  await small.get('/big/2', 'views', async () => ({ pad: 'y'.repeat(100) }));
  c.advance(10);
  await small.get('/big/3', 'views', async () => ({ pad: 'z'.repeat(100) }));
  assert.ok(small.bytes <= 300);
  assert.equal(small.peek('/big/1'), undefined);
});

test('blocked storage falls back to localStorage, then memory, and never throws', async () => {
  const throwingIdb = {
    open() {
      throw new Error('blocked');
    },
  };
  const throwingLs = {
    setItem() {
      throw new Error('blocked');
    },
    removeItem() {
      throw new Error('blocked');
    },
  };
  assert.equal((await pickStorage({ indexedDB: throwingIdb, localStorage: throwingLs })).name, 'memory');
  assert.equal((await pickStorage({})).name, 'memory');

  const data = new Map();
  const fakeLs = {
    get length() {
      return data.size;
    },
    key: (i) => Array.from(data.keys())[i],
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
  const ls = await pickStorage({ indexedDB: throwingIdb, localStorage: fakeLs });
  assert.equal(ls.name, 'localStorage');

  // Storage whose every call fails: the cache still answers.
  const broken = {
    name: 'broken',
    load: () => Promise.reject(new Error('nope')),
    get: () => Promise.reject(new Error('nope')),
    put: () => Promise.reject(new Error('nope')),
    remove: () => Promise.reject(new Error('nope')),
    clear: () => Promise.reject(new Error('nope')),
  };
  const cache = cacheFor({ storage: broken });
  assert.deepEqual(await cache.get(VIEWS, 'views', async () => ({ ok: true })), { ok: true });
});

test('limiter: at most three at once, lowest priority number first', async () => {
  const limiter = createLimiter(() => 3);
  let running = 0;
  let peak = 0;
  const order = [];
  const gates = [];
  const job = (name) => () =>
    new Promise((resolve) => {
      running++;
      peak = Math.max(peak, running);
      order.push(name);
      gates.push(() => {
        running--;
        resolve(name);
      });
    });
  const all = [
    limiter.run(5, job('below-fold-1')),
    limiter.run(5, job('below-fold-2')),
    limiter.run(5, job('below-fold-3')),
    limiter.run(5, job('below-fold-4')),
    limiter.run(0, job('continue-watching')),
    limiter.run(1, job('up-next')),
  ];
  await tick();
  assert.equal(limiter.active, 3);
  while (gates.length) {
    gates.shift()();
    await tick();
  }
  await Promise.all(all);
  assert.equal(peak, 3);
  assert.deepEqual(order.slice(3, 5), ['continue-watching', 'up-next']);
});

test('while a video plays in any tab, only one refresh runs at a time', async () => {
  const hub = createHub();
  const player = cacheFor({ channel: hub() });
  const home = cacheFor({ channel: hub() });
  player.setPlaying(true);
  await tick();
  assert.equal(home.isPlayingElsewhere(), true);

  let running = 0;
  let peak = 0;
  const slowFetch = () =>
    new Promise((resolve) => {
      running++;
      peak = Math.max(peak, running);
      setTimeout(() => {
        running--;
        resolve({ ok: true });
      }, 5);
    });
  await Promise.all(['/a', '/b', '/c', '/d'].map((path) => home.get(path, 'views', slowFetch)));
  assert.equal(peak, 1);

  player.setPlaying(false);
  await tick();
  assert.equal(home.isPlayingElsewhere(), false);
  running = 0;
  peak = 0;
  await Promise.all(['/e', '/f', '/g', '/h', '/i'].map((path) => home.get(path, 'views', slowFetch)));
  assert.equal(peak, 3);
  player.close();
  home.close();
});

test('two tabs asking for the same row send one request; the other reads the shared answer', async () => {
  const hub = createHub();
  const shared = new Map();
  const locks = createLocks();
  const tabA = cacheFor({ channel: hub(), storage: createMemoryStorage(shared), locks });
  const tabB = cacheFor({ channel: hub(), storage: createMemoryStorage(shared), locks });
  let requests = 0;
  const fetcher = () =>
    new Promise((resolve) => {
      requests++;
      setTimeout(() => resolve({ Items: ['shared'] }), 5);
    });
  const [a, b] = await Promise.all([tabA.get(VIEWS, 'views', fetcher), tabB.get(VIEWS, 'views', fetcher)]);
  assert.deepEqual(a, { Items: ['shared'] });
  assert.deepEqual(b, { Items: ['shared'] });
  assert.equal(requests, 1);
  assert.equal(tabB.stats().fromOtherTabs, 1);
});

test('without Web Locks, a localStorage lease still lets only one tab fetch', async () => {
  const data = new Map();
  const leaseStore = {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
  const hub = createHub();
  const shared = new Map();
  const tabA = cacheFor({ channel: hub(), storage: createMemoryStorage(shared), leaseStore });
  const tabB = cacheFor({ channel: hub(), storage: createMemoryStorage(shared), leaseStore });
  let requests = 0;
  const fetcher = () =>
    new Promise((resolve) => {
      requests++;
      setTimeout(() => resolve({ Items: ['leased'] }), 30);
    });
  const first = tabA.get(VIEWS, 'views', fetcher);
  await tick();
  const second = tabB.get(VIEWS, 'views', fetcher);
  assert.deepEqual(await first, { Items: ['leased'] });
  assert.deepEqual(await second, { Items: ['leased'] });
  assert.equal(requests, 1);
  assert.equal(data.size, 0, 'lease released');
});

test('a second tab with a warm cache paints rows before any network response arrives (fake timers)', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  try {
    const shared = new Map();
    const firstTab = createRowCache({ scope, storage: createMemoryStorage(shared), jitterMs: 0, readyTimeoutMs: 0 });
    await firstTab.get(RESUME, 'personal', async () => ({ Items: ['Show S1E3'] }));
    await firstTab.get(VIEWS, 'views', async () => ({ Items: ['Movies', 'Shows'] }));
    mock.timers.tick(60_000);

    // The network answers only after 2 s.
    let networkAnswered = false;
    const slowNetwork = (value) => () =>
      new Promise((resolve) => {
        setTimeout(() => {
          networkAnswered = true;
          resolve(value);
        }, 2000);
      });
    const secondTab = createRowCache({ scope, storage: createMemoryStorage(shared), jitterMs: 0, readyTimeoutMs: 0 });
    const painted = [];
    const resume = secondTab.get(RESUME, 'personal', slowNetwork({ Items: ['Show S1E4'] })).then((rows) => painted.push(['resume', rows]));
    const views = secondTab.get(VIEWS, 'views', slowNetwork({ Items: [] })).then((rows) => painted.push(['views', rows]));
    await Promise.all([resume, views]);

    assert.equal(networkAnswered, false, 'rows painted with no network answer yet');
    assert.deepEqual(painted.find((p) => p[0] === 'resume')[1], { Items: ['Show S1E3'] });
    assert.deepEqual(painted.find((p) => p[0] === 'views')[1], { Items: ['Movies', 'Shows'] });
    assert.equal(secondTab.stats().stale, 1, 'Continue Watching refreshes in the background');
    assert.equal(secondTab.stats().hits, 1);

    // The background refresh lands later and is announced.
    const changes = [];
    secondTab.onChange((event) => changes.push(event));
    for (let i = 0; i < 5; i++) await tick();
    mock.timers.tick(2000);
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(networkAnswered, true);
    assert.equal(changes.length, 1);
    assert.deepEqual(secondTab.peek(RESUME), { Items: ['Show S1E4'] });
  } finally {
    mock.timers.reset();
  }
});

test('after a long break, old personal rows are not shown at all; old catalog rows are, while they refresh', async () => {
  const c = clock();
  const shared = new Map();
  const first = cacheFor({ now: c.now, storage: createMemoryStorage(shared) });
  await first.get(RESUME, 'personal', async () => ({ v: 'yesterday' }));
  await first.get('/Users/u1/Items?ParentId=cat', 'rows', async () => ({ v: 'last week' }));
  assert.equal(isExpired({ cls: 'personal', storedAt: 0 }, 12 * 3600000), true);
  assert.equal(isExpired({ cls: 'rows', storedAt: 0 }, 6 * 24 * 3600000), false);

  c.advance(13 * 3600000);
  const later = cacheFor({ now: c.now, storage: createMemoryStorage(shared) });
  await later.ready;
  assert.equal(later.peek(RESUME), undefined, 'expired at load');
  let fetched = 0;
  assert.deepEqual(await later.get(RESUME, 'personal', async () => (fetched++, { v: 'today' })), { v: 'today' });
  assert.equal(fetched, 1);
  assert.deepEqual(await later.get('/Users/u1/Items?ParentId=cat', 'rows', async () => ({ v: 'new' })), { v: 'last week' });

  for (let i = 0; i < 5; i++) await tick(); // its background refresh lands
  assert.deepEqual(later.peek('/Users/u1/Items?ParentId=cat'), { v: 'new' });

  // Same in a tab that stayed open: an expired entry is a miss on read.
  c.advance(8 * 24 * 3600000);
  assert.deepEqual(await later.get('/Users/u1/Items?ParentId=cat', 'rows', async () => ({ v: 'fresh' })), { v: 'fresh' });
});

test('coming back refreshes only what is due, and announces only what changed', async () => {
  const c = clock();
  const cache = cacheFor({ now: c.now });
  const calls = { resume: 0, views: 0, genres: 0 };
  let resumePayload = { v: 1 };
  await cache.get(RESUME, 'personal', async () => (calls.resume++, resumePayload));
  await cache.get(VIEWS, 'views', async () => (calls.views++, { v: 'views' }));
  await cache.get('/Genres', 'genres', async () => (calls.genres++, { v: 'g' }));
  const changes = [];
  cache.onChange((event) => changes.push(event));

  c.advance(15 * 60000); // views (10 min) is due, genres (30 min) isn't
  resumePayload = { v: 2 };
  assert.equal(cache.revalidateStale(), 2);
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(calls, { resume: 2, views: 2, genres: 1 });
  assert.equal(changes.length, 1, 'views came back the same');
  assert.deepEqual(changes[0].classes, ['personal']);
  assert.equal(cache.revalidateStale(), 0, 'just refreshed');
});

test('return watcher: tab back after a minute, machine waking, restored page, network back', () => {
  let t = 0;
  const listeners = {};
  const target = (name) => ({
    addEventListener: (type, fn) => (listeners[name + ':' + type] = fn),
    removeEventListener: () => {},
  });
  const doc = Object.assign(target('doc'), { visibilityState: 'visible' });
  const win = target('win');
  let tickFn;
  const returns = [];
  const stop = createReturnWatcher({ document: doc, window: win }, (info) => returns.push(info.reason), {
    now: () => t,
    setInterval: (fn) => ((tickFn = fn), 1),
    clearInterval: () => {},
    cooldownMs: 0,
  });

  // Hidden for 20 s: nothing.
  doc.visibilityState = 'hidden';
  listeners['doc:visibilitychange']();
  t += 20000;
  doc.visibilityState = 'visible';
  listeners['doc:visibilitychange']();
  assert.deepEqual(returns, []);

  // Hidden for 5 minutes: refresh.
  doc.visibilityState = 'hidden';
  listeners['doc:visibilitychange']();
  t += 5 * 60000;
  doc.visibilityState = 'visible';
  listeners['doc:visibilitychange']();
  assert.deepEqual(returns, ['visible']);

  // Regular ticks while visible: nothing. A two hour gap (lid closed): refresh.
  t += 20000;
  tickFn();
  t += 2 * 3600000;
  tickFn();
  assert.deepEqual(returns, ['visible', 'wake']);

  listeners['win:pageshow']({ persisted: false });
  t += 3 * 60000;
  listeners['win:pageshow']({ persisted: true });
  listeners['win:online']();
  assert.deepEqual(returns, ['visible', 'wake', 'restored', 'online']);
  stop();
});
