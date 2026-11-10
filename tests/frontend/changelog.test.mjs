import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};
globalThis.window = {
  Jellio: {},
  localStorage: globalThis.localStorage,
  location: { origin: 'http://localhost', hash: '' },
  addEventListener: () => {},
};

const state = await import('../../src/Jellio/Frontend/runtime/changelogState.js');
const full = await import('../../src/Jellio/Frontend/runtime/changelog.js');

test('the startup version id matches the newest big release in the full changelog', () => {
  const newestBig = full.CHANGELOG_RELEASES.find((r) => state.isBigRelease(r.version));
  assert.ok(newestBig, 'the changelog has a big release');
  assert.equal(state.LATEST_BIG_CHANGELOG_VERSION, newestBig.version);
  assert.equal(full.LATEST_BIG_CHANGELOG.version, state.LATEST_BIG_CHANGELOG_VERSION);
});

test('the full changelog keeps the state exports', () => {
  assert.equal(full.shouldShowChangelogNotification, state.shouldShowChangelogNotification);
  assert.equal(full.markLatestChangelogSeen, state.markLatestChangelogSeen);
  assert.equal(full.hasSeenLatestChangelog, state.hasSeenLatestChangelog);
  assert.equal(full.getChangelogNotification().Id, 'changelog:' + state.LATEST_BIG_CHANGELOG_VERSION);
});

test('seen state follows the latest big release', () => {
  store.clear();
  assert.equal(state.shouldShowChangelogNotification(), true);
  state.markLatestChangelogSeen();
  assert.equal(state.shouldShowChangelogNotification(), false);
  store.set('jellio_last_seen_changelog_global', '0.1.0');
  assert.equal(state.shouldShowChangelogNotification(), true);
  assert.equal(store.has('jellio_last_seen_changelog_global'), false);
});

test('only X.Y.0 releases count as big', () => {
  assert.equal(state.isBigRelease('1.80.0'), true);
  assert.equal(state.isBigRelease('v1.80.0'), true);
  assert.equal(state.isBigRelease('1.80.1'), false);
  assert.equal(state.isBigRelease('1.80'), true);
  assert.equal(state.isBigRelease(''), false);
});
