import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
let blocked = false;
let full = false;
globalThis.window = {
  get localStorage() {
    if (blocked) throw new Error('SecurityError');
    return {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => {
        if (full) throw new Error('QuotaExceededError');
        store.set(key, String(value));
      },
      removeItem: (key) => store.delete(key),
    };
  },
};

const { readString, writeString, readJson, writeJson, remove, storageReadable } = await import('../../src/Jellio/Frontend/runtime/storage.js');

test('strings round-trip and missing keys read as the fallback', () => {
  assert.equal(writeString('a', 'x'), true);
  assert.equal(readString('a'), 'x');
  assert.equal(readString('missing'), null);
  assert.equal(readString('missing', 'd'), 'd');
  assert.equal(remove('a'), true);
  assert.equal(readString('a'), null);
});

test('JSON round-trips; corrupt or empty values read as the fallback', () => {
  writeJson('j', { a: 1 });
  assert.equal(store.get('j'), '{"a":1}');
  assert.deepEqual(readJson('j'), { a: 1 });
  store.set('bad', '{nope');
  assert.equal(readJson('bad'), null);
  assert.deepEqual(readJson('bad', {}), {});
  store.set('empty', '');
  assert.equal(readJson('empty', 5), 5);
});

test('a full quota makes writes report false instead of throwing', () => {
  full = true;
  assert.equal(writeString('q', '1'), false);
  assert.equal(writeJson('q', 1), false);
  full = false;
});

test('blocked storage reads as missing and is reported unreadable', () => {
  store.set('k', 'v');
  blocked = true;
  assert.equal(readString('k', 'f'), 'f');
  assert.equal(readJson('k', 'f'), 'f');
  assert.equal(writeString('k', 'w'), false);
  assert.equal(remove('k'), false);
  assert.equal(storageReadable(), false);
  blocked = false;
  assert.equal(storageReadable(), true);
  assert.equal(readString('k'), 'v');
});
