// node --test tests/frontend
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isUnreleasedItem,
  episodeReleaseLabel,
  filterReleasedItems,
  seasonEpisodeReleaseLabels,
  MS_PER_DAY,
  SENTINEL_YEAR,
} from '../../src/Jellio/Frontend/runtime/releaseDate.js';

const FIXED_NOW = Date.UTC(2026, 10, 5, 12, 0, 0); // 2026-11-05T12:00:00Z

test('isUnreleasedItem and episodeReleaseLabel for past dates', () => {
  const item = {
    Id: 'ep-past',
    PremiereDate: '2026-11-01T00:00:00Z',
  };
  assert.equal(isUnreleasedItem(item, FIXED_NOW), false);
  assert.equal(episodeReleaseLabel(item, FIXED_NOW), '');
});

test('isUnreleasedItem and episodeReleaseLabel for today', () => {
  const item = {
    Id: 'ep-today',
    PremiereDate: '2026-11-05T20:00:00Z',
  };
  assert.equal(isUnreleasedItem(item, FIXED_NOW), false);
  assert.equal(episodeReleaseLabel(item, FIXED_NOW), '');
});

test('isUnreleasedItem and episodeReleaseLabel for tomorrow', () => {
  const item = {
    Id: 'ep-tomorrow',
    PremiereDate: '2026-11-06T18:00:00Z',
  };
  assert.equal(isUnreleasedItem(item, FIXED_NOW), true);
  assert.equal(episodeReleaseLabel(item, FIXED_NOW), 'Tomorrow');
});

test('isUnreleasedItem and episodeReleaseLabel in 5 days', () => {
  const item = {
    Id: 'ep-5days',
    PremiereDate: '2026-11-10T18:00:00Z',
  };
  assert.equal(isUnreleasedItem(item, FIXED_NOW), true);
  assert.equal(episodeReleaseLabel(item, FIXED_NOW), 'In 5 days');
});

test('isUnreleasedItem and episodeReleaseLabel 14 days out', () => {
  const item = {
    Id: 'ep-14days',
    PremiereDate: '2026-11-19T18:00:00Z',
  };
  assert.equal(isUnreleasedItem(item, FIXED_NOW), true);
  const expectedLabel = new Date(item.PremiereDate).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  assert.equal(episodeReleaseLabel(item, FIXED_NOW), expectedLabel);
});

test('isUnreleasedItem and episodeReleaseLabel with sentinel EndDate (no PremiereDate)', () => {
  const item = {
    Id: 'ep-sentinel-end',
    EndDate: '9999-01-01T00:00:00Z',
  };
  assert.equal(isUnreleasedItem(item, FIXED_NOW), true);
  assert.equal(episodeReleaseLabel(item, FIXED_NOW), 'Coming soon');
});

test('isUnreleasedItem and episodeReleaseLabel with sentinel PremiereDate', () => {
  const item = {
    Id: 'ep-sentinel-premiere',
    PremiereDate: '9999-01-01T00:00:00Z',
  };
  assert.equal(isUnreleasedItem(item, FIXED_NOW), true);
  assert.equal(episodeReleaseLabel(item, FIXED_NOW), 'Coming soon');
});

test('isUnreleasedItem and episodeReleaseLabel for played or in-progress items', () => {
  const playedItem = {
    Id: 'ep-played',
    PremiereDate: '2026-11-10T00:00:00Z',
    UserData: { Played: true },
  };
  assert.equal(isUnreleasedItem(playedItem, FIXED_NOW), false);
  assert.equal(episodeReleaseLabel(playedItem, FIXED_NOW), '');

  const inProgressItem = {
    Id: 'ep-resume',
    PremiereDate: '2026-11-10T00:00:00Z',
    UserData: { PlaybackPositionTicks: 1200000000 },
  };
  assert.equal(isUnreleasedItem(inProgressItem, FIXED_NOW), false);
  assert.equal(episodeReleaseLabel(inProgressItem, FIXED_NOW), '');
});

test('isUnreleasedItem and episodeReleaseLabel for normal released episodes without PremiereDate', () => {
  const normalItem = {
    Id: 'ep-normal',
    RunTimeTicks: 25000000000,
    LocationType: 'FileSystem',
  };
  assert.equal(isUnreleasedItem(normalItem, FIXED_NOW), false);
  assert.equal(episodeReleaseLabel(normalItem, FIXED_NOW), '');
});

test('isUnreleasedItem for virtual item without runtime', () => {
  const virtualItem = {
    Id: 'ep-virtual',
    LocationType: 'Virtual',
  };
  assert.equal(isUnreleasedItem(virtualItem, FIXED_NOW), true);
  assert.equal(episodeReleaseLabel(virtualItem, FIXED_NOW), 'Coming soon');
});

test('isUnreleasedItem handles invalid or empty inputs gracefully', () => {
  assert.equal(isUnreleasedItem(null), false);
  assert.equal(isUnreleasedItem(undefined), false);
  assert.equal(isUnreleasedItem('not-an-object'), false);
  assert.equal(episodeReleaseLabel(null), '');
});

test('filterReleasedItems removes unreleased episodes from Next Up lists', () => {
  const items = [
    { Id: 'ep-1', Name: 'Ep 1', PremiereDate: '2026-10-01T00:00:00Z' },
    { Id: 'ep-2', Name: 'Ep 2', PremiereDate: '2026-11-05T00:00:00Z' },
    { Id: 'ep-3', Name: 'Ep 3', PremiereDate: '2026-11-06T00:00:00Z' },
    { Id: 'ep-4', Name: 'Ep 4', PremiereDate: '2026-11-12T00:00:00Z' },
    { Id: 'ep-5', Name: 'Ep 5', EndDate: '9999-01-01T00:00:00Z' },
    { Id: 'ep-6', Name: 'Ep 6', LocationType: 'Virtual' },
  ];

  const released = filterReleasedItems(items, FIXED_NOW);
  assert.equal(released.length, 2);
  assert.equal(released[0].Id, 'ep-1');
  assert.equal(released[1].Id, 'ep-2');
});

test('seasonEpisodeReleaseLabels marks trailing unannounced episodes after an unreleased episode as Coming soon', () => {
  const episodes = [
    { Id: 'ep-1', IndexNumber: 1, PremiereDate: '2026-10-25T00:00:00Z', RunTimeTicks: 1000 },
    { Id: 'ep-2', IndexNumber: 2, PremiereDate: '2026-11-05T00:00:00Z', RunTimeTicks: 1000 },
    { Id: 'ep-3', IndexNumber: 3, PremiereDate: '2026-11-06T00:00:00Z' },
    { Id: 'ep-4', IndexNumber: 4 }, // No PremiereDate, not played, no runtime
    { Id: 'ep-5', IndexNumber: 5 }, // No PremiereDate, not played, no runtime
    { Id: 'ep-6', IndexNumber: 6, RunTimeTicks: 1200 }, // Has runtime (available)
    { Id: 'ep-7', IndexNumber: 7, UserData: { Played: true } }, // Played
  ];

  const labels = seasonEpisodeReleaseLabels(episodes, FIXED_NOW);
  assert.equal(labels['ep-1'], undefined);
  assert.equal(labels['ep-2'], undefined);
  assert.equal(labels['ep-3'], 'Tomorrow');
  assert.equal(labels['ep-4'], 'Coming soon');
  assert.equal(labels['ep-5'], 'Coming soon');
  assert.equal(labels['ep-6'], undefined);
  assert.equal(labels['ep-7'], undefined);

  // Check index access as well
  assert.equal(labels[2], 'Tomorrow');
  assert.equal(labels[3], 'Coming soon');
  assert.equal(labels[4], 'Coming soon');
});
