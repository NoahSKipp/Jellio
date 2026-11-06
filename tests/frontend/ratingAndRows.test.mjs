import { test } from 'node:test';
import assert from 'node:assert/strict';

class MockClassList {
  constructor() {
    this.classes = new Set();
  }
  add(...names) {
    names.forEach((n) => {
      if (n) this.classes.add(n);
    });
  }
  remove(...names) {
    names.forEach((n) => this.classes.delete(n));
  }
  toggle(name, force) {
    if (typeof force === 'boolean') {
      if (force) this.classes.add(name);
      else this.classes.delete(name);
      return force;
    }
    if (this.classes.has(name)) {
      this.classes.delete(name);
      return false;
    }
    this.classes.add(name);
    return true;
  }
  contains(name) {
    return this.classes.has(name);
  }
}

class MockElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.classList = new MockClassList();
    this.listeners = new Map();
    this.scrollLeft = 0;
    this.clientWidth = 1000;
    this.scrollWidth = 1000;
    this.tabIndex = 0;
  }
  get className() {
    return Array.from(this.classList.classes).join(' ');
  }
  set className(val) {
    this.classList.classes.clear();
    String(val || '')
      .split(/\s+/)
      .filter(Boolean)
      .forEach((c) => this.classList.classes.add(c));
  }
  appendChild(child) {
    if (!child) return child;
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  insertBefore(newChild, refChild) {
    newChild.parentNode = this;
    const idx = this.children.indexOf(refChild);
    if (idx === -1) {
      this.children.push(newChild);
    } else {
      this.children.splice(idx, 0, newChild);
    }
    return newChild;
  }
  remove() {
    if (this.parentNode) {
      const idx = this.parentNode.children.indexOf(this);
      if (idx !== -1) this.parentNode.children.splice(idx, 1);
      this.parentNode = null;
    }
  }
  setAttribute(name, val) {
    this.attributes.set(name, String(val));
  }
  getAttribute(name) {
    return this.attributes.get(name) || null;
  }
  addEventListener(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  }
  removeEventListener(event, fn) {
    if (!this.listeners.has(event)) return;
    this.listeners.set(event, this.listeners.get(event).filter((f) => f !== fn));
  }
  dispatchEvent(event) {
    const list = this.listeners.get(event.type) || [];
    list.forEach((fn) => fn(event));
  }
  querySelector(sel) {
    return null;
  }
  querySelectorAll(sel) {
    return [];
  }
  scrollBy() {}
}

globalThis.window = {
  Jellio: {},
  location: { origin: 'http://localhost', hash: '' },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {},
  requestAnimationFrame: (cb) => setTimeout(cb, 0),
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (...args) => clearTimeout(...args),
};

globalThis.document = {
  createElement: (tag) => new MockElement(tag),
  createTextNode: (text) => ({ textContent: String(text), nodeType: 3 }),
  addEventListener: () => {},
  removeEventListener: () => {},
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
};

const { buildRatingBadge } = await import('../../src/Jellio/Frontend/components/ratingBadge.js');
const { buildRow } = await import('../../src/Jellio/Frontend/components/row.js');

test('buildRatingBadge creates TMDB rating badge with correct icon class and formatted score', () => {
  const badge = buildRatingBadge(8.46, 'custom-badge');
  assert.ok(badge.classList.contains('jellio-rating-badge'));
  assert.ok(badge.classList.contains('custom-badge'));

  const icon = badge.children[0];
  assert.equal(icon.tagName, 'IMG');
  assert.ok(icon.classList.contains('jellio-rating-badge-icon'));
  assert.equal(icon.alt, 'TMDB');
  assert.match(icon.src, /\/Jellio\/frontend\/img\/ratings\/tmdb\.svg/);

  const textNode = badge.children[1];
  assert.equal(textNode.textContent, '8.5');
});

test('buildRow returns null when item list is empty', () => {
  assert.equal(buildRow('Action', []), null);
  assert.equal(buildRow('Action', null), null);
});

test('buildRow sets up horizontal infinite scroll and fetches next page on scroll near end', async () => {
  const initialItems = [
    { Id: 'item-1', Name: 'Movie 1', Type: 'Movie' },
    { Id: 'item-2', Name: 'Movie 2', Type: 'Movie' },
  ];

  const pagesAsked = [];
  const fetchPage = async (start, size) => {
    pagesAsked.push({ start, size });
    return [
      { Id: 'item-3', Name: 'Movie 3', Type: 'Movie' },
      { Id: 'item-1', Name: 'Movie 1 Duplicate', Type: 'Movie' },
    ];
  };

  const section = buildRow('Trending Movies', initialItems, null, { fetchPage });
  assert.ok(section);
  assert.ok(section.classList.contains('jellio-row'));

  const trackWrap = section.children[1];
  assert.ok(trackWrap.classList.contains('jellio-row-track-wrap'));
  const track = trackWrap.children[0];
  assert.ok(track.classList.contains('jellio-row-track'));

  // Initially has 2 cards
  assert.equal(track.children.length, 2);

  // Simulate scrolling track near the end
  track.scrollWidth = 1400;
  track.clientWidth = 1000;
  track.scrollLeft = 300; // remaining = 1400 - (300 + 1000) = 100 <= 600

  track.dispatchEvent({ type: 'scroll' });

  // Await async page fetch
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(pagesAsked.length, 1);
  assert.deepEqual(pagesAsked[0], { start: 2, size: 24 });

  // item-3 appended, duplicate item-1 skipped -> total 3 cards
  assert.equal(track.children.length, 3);
});
