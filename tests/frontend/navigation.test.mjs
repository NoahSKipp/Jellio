import { test } from 'node:test';
import assert from 'node:assert/strict';

// Set up mock window, history, and document for router tests
const listeners = [];
globalThis.window = globalThis.window || {};
globalThis.window.location = globalThis.window.location || { hash: '' };
globalThis.window.history = globalThis.window.history || {
  pushState: () => {},
  replaceState: () => {},
};
globalThis.window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.window.addEventListener = (event, fn) => {
  if (event === 'hashchange' || event === 'popstate') listeners.push(fn);
};
globalThis.document = globalThis.document || {
  readyState: 'complete',
  title: 'Jellio',
  addEventListener: () => {},
};

const { navigateTo, onRouteChange } = await import('../../src/Jellio/Frontend/runtime/router.js');
const { loadItemInfo } = await import('../../src/Jellio/Frontend/runtime/itemInfo.js');

test('re-clicking the current route triggers navigation handling', async () => {
  window.location.hash = '#/home';
  let routeChangeCount = 0;
  let lastSeenHash = null;

  onRouteChange((hash) => {
    routeChangeCount++;
    lastSeenHash = hash;
  });

  // Re-clicking the exact same route
  navigateTo('#/home');

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.ok(routeChangeCount >= 1, 'Route change listener should be triggered');
  assert.equal(lastSeenHash, '#/home');
});

test('re-clicking current route with Emby.Page.show triggers navigation handling', async () => {
  window.location.hash = '#/movies';
  let routeChangeCount = 0;

  onRouteChange(() => {
    routeChangeCount++;
  });

  window.Emby = {
    Page: {
      show: (hash) => {
        window.location.hash = hash;
      },
    },
  };

  try {
    navigateTo('#/movies');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(routeChangeCount >= 1, 'Route change listener should be triggered via Emby.Page.show');
  } finally {
    delete window.Emby;
  }
});

test('in-flight fetch retry aborts immediately when signal is cancelled', async () => {
  const controller = new AbortController();
  const IMPORT_POLL_INTERVAL_MS = 50; // fast interval for testing
  let attempts = 0;

  function fetchWithRetry(signal) {
    function attempt(attemptsLeft) {
      if (signal && signal.aborted) {
        return Promise.reject(new DOMException('Aborted', 'AbortError'));
      }
      attempts++;
      return Promise.reject(new Error('Network error')).catch((err) => {
        if (signal && signal.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        if (attemptsLeft <= 0) throw err;
        return new Promise((resolve, reject) => {
          let timer = null;
          const onAbort = () => {
            if (timer !== null) {
              clearTimeout(timer);
              timer = null;
            }
            if (signal) signal.removeEventListener('abort', onAbort);
            reject(new DOMException('Aborted', 'AbortError'));
          };
          if (signal && signal.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
          }
          if (signal) signal.addEventListener('abort', onAbort);
          timer = setTimeout(() => {
            timer = null;
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve();
          }, IMPORT_POLL_INTERVAL_MS);
        }).then(() => attempt(attemptsLeft - 1));
      });
    }
    return attempt(5);
  }

  const promise = fetchWithRetry(controller.signal);

  // Abort while waiting in retry backoff
  setTimeout(() => {
    controller.abort();
  }, 10);

  await assert.rejects(promise, { name: 'AbortError' });
  assert.equal(attempts, 1, 'Should not attempt further retries after abort');
});

test('navigation coordinator aborts active screen load and allows new route to render immediately', async () => {
  // Simulates app.js navigation coordinator:
  // sync(), runSync(), activeScreenAbortController, lastRenderedRouteKey
  let activeScreenAbortController = null;
  let lastRenderedRouteKey = null;
  let renderToken = 0;
  let syncRunning = false;
  let syncQueued = false;
  let currentRenderedContent = '';
  let activeRoute = 'item?id=1';

  async function mockScreen(route, signal) {
    if (route === 'item?id=1') {
      // Simulate slow loading screen that retries
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve(() => {});
        }, 1000);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    }
    if (route === 'home?') {
      // Instant screen
      return () => {};
    }
  }

  async function teardown() {
    renderToken++;
    if (activeScreenAbortController) {
      activeScreenAbortController.abort();
      activeScreenAbortController = null;
    }
  }

  async function runSync() {
    let token = 0;
    try {
      const key = activeRoute;
      const isCurrentlyRendered = key === lastRenderedRouteKey && currentRenderedContent === 'loaded';
      if (isCurrentlyRendered) return;

      await teardown();

      activeScreenAbortController = new AbortController();
      token = ++renderToken;

      const cleanup = await mockScreen(key, activeScreenAbortController.signal);
      if (token !== renderToken) return;

      lastRenderedRouteKey = key;
      currentRenderedContent = 'loaded';
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.aborted)) {
        return;
      }
      if (token && token !== renderToken) {
        return;
      }
      lastRenderedRouteKey = null;
      throw err;
    }
  }

  async function sync() {
    if (syncRunning) {
      syncQueued = true;
      if (activeScreenAbortController) {
        activeScreenAbortController.abort();
      }
      return;
    }
    syncRunning = true;
    try {
      do {
        syncQueued = false;
        await runSync();
      } while (syncQueued);
    } finally {
      syncRunning = false;
    }
  }

  // 1. Start navigating to item?id=1 (slow load)
  const slowNav = sync();
  assert.equal(syncRunning, true);
  assert.equal(lastRenderedRouteKey, null, 'lastRenderedRouteKey should not be set while loading');

  // 2. While slow screen is loading, navigate to home?
  activeRoute = 'home?';
  const fastNav = sync();

  await Promise.all([slowNav, fastNav]);

  // Route 2 (home?) should have successfully rendered immediately without waiting 1000ms
  assert.equal(lastRenderedRouteKey, 'home?');
  assert.equal(currentRenderedContent, 'loaded');
});

test('lastRenderedRouteKey is not set on aborted or failed loads', async () => {
  let activeScreenAbortController = new AbortController();
  let lastRenderedRouteKey = 'home?';
  let renderToken = 1;

  async function teardown() {
    renderToken++;
    if (activeScreenAbortController) {
      activeScreenAbortController.abort();
      activeScreenAbortController = null;
    }
  }

  async function attemptLoad(key) {
    let token = 0;
    try {
      await teardown();
      activeScreenAbortController = new AbortController();
      token = ++renderToken;

      // Simulate load being aborted
      activeScreenAbortController.abort();
      if (activeScreenAbortController.signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      lastRenderedRouteKey = key;
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.aborted)) {
        return;
      }
      lastRenderedRouteKey = null;
    }
  }

  await attemptLoad('item?id=failed');
  assert.notEqual(lastRenderedRouteKey, 'item?id=failed', 'lastRenderedRouteKey must not be set on aborted load');
});

test('re-clicking while screen content has loading spinner does not skip rendering', () => {
  const key = 'item?id=1';
  const lastRenderedRouteKey = 'item?id=1';

  // Mock content containing a loading spinner
  const contentWithSpinner = {
    hasChildNodes: () => true,
    querySelector: (sel) => {
      if (sel === '.jellio-screen-loading' || sel === '.jellio-screen-spinner') {
        return {};
      }
      return null;
    },
  };

  const isCurrentlyRendered = key === lastRenderedRouteKey &&
    contentWithSpinner &&
    contentWithSpinner.hasChildNodes() &&
    !contentWithSpinner.querySelector('.jellio-screen-loading') &&
    !contentWithSpinner.querySelector('.jellio-screen-spinner');

  assert.equal(isCurrentlyRendered, false, 'Should not consider screen currently rendered if spinner exists');
});
