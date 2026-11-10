import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map([['jellio_display_language', 'de']]);
const listeners = {};
globalThis.window = {
  localStorage: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  },
  addEventListener: (type, fn) => {
    (listeners[type] = listeners[type] || []).push(fn);
  },
  dispatchEvent: () => true,
};
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init && init.detail;
  }
};

const { fillPlaceholders, getDisplayLanguage, setDisplayLanguage, t } = await import('../../src/Jellio/Frontend/runtime/i18n.js');

test('fillPlaceholders replaces every occurrence of each parameter', () => {
  assert.equal(fillPlaceholders('{a} and {b} and {a}', { a: 1, b: 'x' }), '1 and x and 1');
});

test('fillPlaceholders leaves unknown and unbalanced braces alone', () => {
  assert.equal(fillPlaceholders('{a} {missing} {', { a: 'v' }), 'v {missing} {');
  assert.equal(fillPlaceholders('{{a}}', { a: 5 }), '{5}');
  assert.equal(fillPlaceholders('no braces', { a: 1 }), 'no braces');
});

test('fillPlaceholders inserts values literally', () => {
  assert.equal(fillPlaceholders('Hi {name}', { name: '$& $1 {name}' }), 'Hi $& $1 {name}');
  assert.equal(fillPlaceholders('{n}', { n: undefined }), 'undefined');
});

test('the display language is read once and follows setDisplayLanguage', () => {
  assert.equal(getDisplayLanguage(), 'de');
  store.set('jellio_display_language', 'fr');
  assert.equal(getDisplayLanguage(), 'de');
  setDisplayLanguage('it');
  assert.equal(getDisplayLanguage(), 'it');
  assert.equal(store.get('jellio_display_language'), 'it');
});

test('a change from another tab updates the cached language', () => {
  store.set('jellio_display_language', 'pl');
  for (const fn of listeners.storage || []) fn({ key: 'jellio_display_language' });
  assert.equal(getDisplayLanguage(), 'pl');
  setDisplayLanguage('en');
});

test('t fills parameters and falls back to English', () => {
  assert.equal(t('settings_signed_in_as', { name: 'Ana' }), 'Signed in as Ana');
  assert.equal(t('time_minutes_ago', { count: 3 }), '3 minutes ago');
});
