import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rawEditionTag,
  getAvailableEditions,
  detectSourceEdition,
  groupSourcesByEdition,
  getPreferredEdition,
  setPreferredEdition,
} from '../../src/Jellio/Frontend/runtime/editions.js';

test('rawEditionTag identifies monochrome and cut tags', () => {
  assert.equal(rawEditionTag({ Name: 'Logan Noir 2017 1080p' }), 'Noir / B&W');
  assert.equal(rawEditionTag({ Name: 'Mad Max Fury Road Black & Chrome' }), 'Noir / B&W');
  assert.equal(rawEditionTag({ Name: 'Godzilla Minus One Minus Color 2023' }), 'Noir / B&W');
  assert.equal(rawEditionTag({ Name: "Zack Snyder's Justice League Justice Is Gray" }), 'Noir / B&W');
  assert.equal(rawEditionTag({ Name: 'Parasite B&W Edition 2019' }), 'Noir / B&W');
  assert.equal(rawEditionTag({ Name: 'In Black and White Remaster' }), 'Noir / B&W');

  assert.equal(rawEditionTag({ Name: 'Gladiator Extended Edition 2000' }), 'Extended');
  assert.equal(rawEditionTag({ Name: 'Blade Runner Final Cut 1982' }), 'Final Cut');
  assert.equal(rawEditionTag({ Name: "Apocalypse Now Director's Cut 1979" }), "Director's Cut");
  assert.equal(rawEditionTag({ Name: 'Watchmen DC 2009' }), "Director's Cut");
  assert.equal(rawEditionTag({ Name: 'Avatar Theatrical Cut 2009' }), 'Theatrical');
  assert.equal(rawEditionTag({ Name: 'The Wolf of Wall Street Unrated' }), 'Unrated');
  assert.equal(rawEditionTag({ Name: 'Apocalypse Now Redux 2001' }), 'Redux');
  assert.equal(rawEditionTag({ Name: 'Dune IMAX Enhanced 2021' }), 'IMAX');
  assert.equal(rawEditionTag({ Name: 'Inception 2010 1080p BluRay' }), null);
});

test('activation threshold: returns empty array when fewer than 2 editions exist', () => {
  const singleStandard = [
    { Name: 'Inception 2010 1080p' },
    { Name: 'Inception 2010 4K' },
  ];
  assert.deepEqual(getAvailableEditions(singleStandard), []);

  const singleEditionOnly = [
    { Name: 'Logan Noir 1080p' },
    { Name: 'Logan Noir 4K' },
  ];
  assert.deepEqual(getAvailableEditions(singleEditionOnly), []);
});

test('monochrome pairing: defaults non-monochrome streams to Color', () => {
  const sources = [
    { Id: '1', Name: 'Logan 2017 4K HDR' },
    { Id: '2', Name: 'Logan Noir 2017 1080p BluRay' },
  ];
  const editions = getAvailableEditions(sources);
  assert.deepEqual(editions, ['Color', 'Noir / B&W']);
  assert.equal(detectSourceEdition(sources[0], sources), 'Color');
  assert.equal(detectSourceEdition(sources[1], sources), 'Noir / B&W');
});

test('cuts pairing: defaults unlabelled streams to Theatrical when alternate cut exists', () => {
  const sources = [
    { Id: '1', Name: 'Gladiator 2000 1080p' },
    { Id: '2', Name: 'Gladiator Extended Edition 2000 4K' },
  ];
  const editions = getAvailableEditions(sources);
  assert.deepEqual(editions, ['Theatrical', 'Extended']);
  assert.equal(detectSourceEdition(sources[0], sources), 'Theatrical');
  assert.equal(detectSourceEdition(sources[1], sources), 'Extended');
});

test('multiple cuts: correctly detects Theatrical, Extended, and Directors Cut', () => {
  const sources = [
    { Id: '1', Name: 'Kingdom of Heaven Theatrical 2005' },
    { Id: '2', Name: "Kingdom of Heaven Director's Cut 2005" },
    { Id: '3', Name: 'Kingdom of Heaven Extended 2005' },
  ];
  const editions = getAvailableEditions(sources);
  assert.deepEqual(editions, ['Theatrical', 'Extended', "Director's Cut"]);
  assert.equal(detectSourceEdition(sources[0], sources), 'Theatrical');
  assert.equal(detectSourceEdition(sources[1], sources), "Director's Cut");
  assert.equal(detectSourceEdition(sources[2], sources), 'Extended');
});

test('groupSourcesByEdition partitions sources accurately', () => {
  const sources = [
    { Id: '1', Name: 'Blade Runner 1982 1080p' },
    { Id: '2', Name: 'Blade Runner Final Cut 1982 4K' },
    { Id: '3', Name: "Blade Runner Director's Cut 1992 1080p" },
  ];
  const grouped = groupSourcesByEdition(sources);
  assert.equal(grouped.size, 3);
  assert.equal(grouped.get('Theatrical').length, 1);
  assert.equal(grouped.get('Theatrical')[0].Id, '1');
  assert.equal(grouped.get('Final Cut').length, 1);
  assert.equal(grouped.get('Final Cut')[0].Id, '2');
  assert.equal(grouped.get("Director's Cut").length, 1);
  assert.equal(grouped.get("Director's Cut")[0].Id, '3');
});

test('preference get and set handles localStorage gracefully', () => {
  globalThis.window = {
    localStorage: {
      _store: {},
      getItem(k) { return this._store[k] || null; },
      setItem(k, v) { this._store[k] = String(v); },
    },
  };

  const itemId = 'item-123';
  const editions = ['Color', 'Noir / B&W'];

  // Default to first available when no preference exists
  assert.equal(getPreferredEdition(itemId, editions), 'Color');

  // Save preference
  setPreferredEdition(itemId, 'Noir / B&W');
  assert.equal(getPreferredEdition(itemId, editions), 'Noir / B&W');

  // Return first available if stored preference is not in available editions
  assert.equal(getPreferredEdition(itemId, ['Theatrical', 'Extended']), 'Theatrical');
});
