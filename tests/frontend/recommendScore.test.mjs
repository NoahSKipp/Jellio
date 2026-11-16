// node --test tests/frontend
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
if (!globalThis.window) {
  globalThis.window = {
    location: { hash: '' },
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
}
if (!globalThis.localStorage) {
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}
if (!globalThis.document) {
  globalThis.document = {
    hidden: false,
    visibilityState: 'visible',
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}
if (!globalThis.navigator) {
  globalThis.navigator = {};
}

const { seedWeight, score } = await import('../../src/Jellio/Frontend/runtime/recommend.js');
const { pickSecondSource } = await import('../../src/Jellio/Frontend/runtime/playbackPrefetch.js');
const { markLocalSourceWarm, getLocalWarmedSources } = await import('../../src/Jellio/Frontend/runtime/api/playback.js');

test('recommend: disliked seeds receive weight 0 and liked recent binge seeds score highest', () => {
  const now = Date.parse('2026-11-16T12:00:00Z');
  const liked = {
    Id: '1',
    UserData: { Likes: true, LastPlayedDate: '2026-11-15T12:00:00Z', PlayCount: 2 },
    _recentEpisodeCount: 4,
  };
  const oldPlain = {
    Id: '2',
    UserData: { LastPlayedDate: '2026-10-01T12:00:00Z', PlayCount: 1 },
  };
  const disliked = {
    Id: '3',
    UserData: { Likes: false, LastPlayedDate: '2026-11-15T12:00:00Z' },
  };

  assert.equal(seedWeight(disliked, now), 0);
  assert.ok(seedWeight(liked, now) > seedWeight(oldPlain, now) * 2);
});

test('recommend: score rewards creator/studio matches even when genres differ', () => {
  const seed = {
    Id: 's1',
    Genres: ['Drama'],
    Studios: [{ Name: 'A24' }],
    ProductionYear: 2022,
    UserData: { Likes: true },
  };
  const personMatch = {
    viaPerson: true,
    matchedPersonIds: ['director-1'],
    item: {
      Id: 'c1',
      Genres: ['Horror'],
      Studios: [{ Name: 'A24' }],
      ProductionYear: 2023,
      CommunityRating: 8.2,
    },
  };
  const noMatch = {
    viaPerson: false,
    item: {
      Id: 'c2',
      Genres: ['Comedy'],
      Studios: [{ Name: 'Other' }],
      ProductionYear: 1990,
      CommunityRating: 6.0,
    },
  };

  assert.ok(score(seed, personMatch) > 2.0);
  assert.equal(score(seed, noMatch), 0);
});

test('playback: pickSecondSource returns fallback source and markLocalSourceWarm feeds StreamPicker Ready state', () => {
  const sources = [{ Id: 'src-1' }, { Id: 'src-2' }, { Id: 'src-3' }];
  const second = pickSecondSource(sources, { isBad: (s) => s.Id === 'src-2' });
  assert.equal(second.Id, 'src-3');

  markLocalSourceWarm('item-abc', 'SRC-99-XYZ');
  const warm = getLocalWarmedSources('item-abc');
  assert.ok(warm && typeof warm['src99xyz'] === 'string');
});
