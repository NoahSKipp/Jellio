import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../src/Jellio/Frontend/sw.js', import.meta.url), 'utf8');
const handlers = {};
const self = {
  location: { origin: 'https://jf.example' },
  registration: { scope: 'https://jf.example/web/' },
  navigator: { onLine: true },
  addEventListener: (type, fn) => {
    handlers[type] = fn;
  },
  skipWaiting: () => {},
};
const context = vm.createContext({
  self,
  URL,
  Promise,
  fetch: () => Promise.resolve({ ok: true }),
  importScripts: () => {
    throw new Error('none');
  },
});
vm.runInContext(source, context);

const asset = (path, v) => 'https://jf.example/Jellio/frontend/' + path + (v ? '?v=' + v : '');

test('only same-origin frontend assets carry a version', () => {
  assert.equal(context.assetVersion(asset('app.js', '1.2.0.0')), '1.2.0.0');
  assert.equal(context.assetVersion(asset('img/x.svg')), null);
  assert.equal(context.assetVersion('https://other.example/Jellio/frontend/app.js?v=1'), null);
  assert.equal(context.assetVersion('https://jf.example/Items/abc/Images/Primary?v=1'), null);
});

test('versions compare numerically', () => {
  assert.equal(context.compareVersions('1.10.0.0', '1.9.0.0'), 1);
  assert.equal(context.compareVersions('1.9', '1.9.0.0'), 0);
  assert.equal(context.compareVersions('0.9.1', '1.0'), -1);
});

test('activation keeps only the newest cached version of each asset', () => {
  const urls = [
    asset('app.js', '1.9.0.0'),
    asset('app.js', '1.10.0.0'),
    asset('screens/reader.js', '1.9.0.0'),
    asset('img/logo.svg'),
    'https://jf.example/web/index.html',
  ];
  assert.deepEqual(Array.from(context.staleVersionedUrls(urls)), [asset('app.js', '1.9.0.0')]);
});

test('a fresh copy replaces the other versions of the same asset only', () => {
  const urls = [asset('app.js', '1.9.0.0'), asset('app.js', '1.10.0.0'), asset('runtime/api.js', '1.9.0.0')];
  assert.deepEqual(Array.from(context.otherVersionUrls(urls, asset('app.js', '1.10.0.0'))), [asset('app.js', '1.9.0.0')]);
});

function fetchEvent(href, mode) {
  const event = {
    request: { method: 'GET', url: href, mode: mode || 'no-cors' },
    responded: false,
    respondWith() {
      event.responded = true;
    },
  };
  return event;
}

test('cover images bypass the worker unless the server is offline', () => {
  const image = 'https://jf.example/Items/0123456789abcdef0123456789abcdef/Images/Primary?maxWidth=300';
  let event = fetchEvent(image);
  handlers.fetch(event);
  assert.equal(event.responded, false);

  handlers.message({ data: { type: 'jellio-connectivity', offline: true } });
  event = fetchEvent(image);
  handlers.fetch(event);
  assert.equal(event.responded, true);
  handlers.message({ data: { type: 'jellio-connectivity', offline: false } });
});
