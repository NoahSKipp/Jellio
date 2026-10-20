import { test } from 'node:test';
import assert from 'node:assert/strict';

// Setup window mock for node environment before importing module
if (typeof globalThis.window === 'undefined') {
  globalThis.window = {
    Jellio: {},
    location: { origin: 'http://localhost', hash: '' },
    history: { pushState: () => {}, replaceState: () => {} },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    matchMedia: () => ({ matches: false }),
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
    setTimeout: (...args) => globalThis.setTimeout(...args),
    clearTimeout: (...args) => globalThis.clearTimeout(...args),
    setInterval: (...args) => globalThis.setInterval(...args),
    clearInterval: (...args) => globalThis.clearInterval(...args),
    requestAnimationFrame: (cb) => globalThis.setTimeout(cb, 0),
    cancelAnimationFrame: (id) => globalThis.clearTimeout(id),
  };
}
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
    createElement: () => ({
      setAttribute: () => {},
      appendChild: () => {},
      classList: { add: () => {}, remove: () => {} },
      addEventListener: () => {},
    }),
  };
}

const { getHeroBackdropUrl, getHeroLogoUrl } = await import('../../src/Jellio/Frontend/components/heroCarousel.js');

test('getHeroBackdropUrl: resolves item backdrop tag with maxWidth 1920', () => {
  const item = {
    Id: 'item-1',
    BackdropImageTags: ['tag-bd-1'],
  };
  const url = getHeroBackdropUrl(item);
  assert.ok(url.includes('/Items/item-1/Images/Backdrop'));
  assert.ok(url.includes('tag=tag-bd-1'));
  assert.ok(url.includes('maxWidth=1920'));
});

test('getHeroBackdropUrl: falls back to ParentBackdropItemId and ParentBackdropImageTags', () => {
  const item = {
    Id: 'episode-1',
    ParentBackdropItemId: 'series-1',
    ParentBackdropImageTags: ['tag-parent-bd'],
  };
  const url = getHeroBackdropUrl(item);
  assert.ok(url.includes('/Items/series-1/Images/Backdrop'));
  assert.ok(url.includes('tag=tag-parent-bd'));
  assert.ok(url.includes('maxWidth=1920'));
});

test('getHeroBackdropUrl: falls back to Primary image when no backdrop is present', () => {
  const item = {
    Id: 'item-no-bd',
    ImageTags: { Primary: 'tag-pri' },
  };
  const url = getHeroBackdropUrl(item);
  assert.ok(url.includes('/Items/item-no-bd/Images/Primary'));
  assert.ok(url.includes('tag=tag-pri'));
});

test('getHeroBackdropUrl: returns empty string when item is invalid', () => {
  assert.equal(getHeroBackdropUrl(null), '');
  assert.equal(getHeroBackdropUrl({}), '');
});

test('getHeroLogoUrl: returns Logo URL when ImageTags.Logo exists', () => {
  const item = {
    Id: 'movie-1',
    ImageTags: { Logo: 'tag-logo-1' },
  };
  const url = getHeroLogoUrl(item);
  assert.ok(url);
  assert.ok(url.includes('/Items/movie-1/Images/Logo'));
  assert.ok(url.includes('tag=tag-logo-1'));
  assert.ok(url.includes('maxWidth=800'));
});

test('getHeroLogoUrl: returns null when item has no Logo tag', () => {
  const item = {
    Id: 'movie-no-logo',
    ImageTags: { Primary: 'tag-pri' },
  };
  assert.equal(getHeroLogoUrl(item), null);
  assert.equal(getHeroLogoUrl(null), null);
  assert.equal(getHeroLogoUrl({}), null);
});
