// node --test tests/frontend
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSearchQuery,
  expandSearchQueryVariants,
  damerauLevenshtein,
  fuzzyScoreTitle,
} from '../../src/Jellio/Frontend/runtime/searchNormalizer.js';

test('searchNormalizer: strips diacritics, smart quotes, punctuation, and normalizes ampersand', () => {
  assert.equal(normalizeSearchQuery("Am\u00e9lie"), 'amelie');
  assert.equal(normalizeSearchQuery("Schindler\u2019s List"), 'schindlers list');
  assert.equal(normalizeSearchQuery('Fast & Furious: Hobbs & Shaw'), 'fast and furious hobbs and shaw');
});

test('searchNormalizer: expands initialisms, compound words, and number/Roman variants', () => {
  const b99 = expandSearchQueryVariants('b99');
  assert.equal(b99[0], 'Brooklyn Nine-Nine');

  const lotr = expandSearchQueryVariants('lotr');
  assert.equal(lotr[0], 'The Lord of the Rings');

  const spider = expandSearchQueryVariants('spiderman');
  assert.ok(spider.includes('spider-man'));
  assert.ok(spider.includes('spider man'));

  const rocky = expandSearchQueryVariants('rocky 4');
  assert.ok(rocky.includes('rocky iv'));
  assert.ok(rocky.includes('rocky four'));
});

test('searchNormalizer: Restricted Damerau-Levenshtein treats adjacent transposition as distance 1', () => {
  assert.equal(damerauLevenshtein('bda', 'bad'), 1);
  assert.equal(damerauLevenshtein('titna', 'titan'), 1);
  assert.equal(damerauLevenshtein('breaking bda', 'breaking bad'), 1);
});

test('searchNormalizer: fuzzyScoreTitle ranks close typo matches strongly above unrelated titles', () => {
  const badScore = fuzzyScoreTitle('Breaking Bda', 'Breaking Bad');
  const unrelatedScore = fuzzyScoreTitle('Breaking Bda', 'The Godfather');
  assert.ok(badScore > 0.75, `expected high score for transposition, got ${badScore}`);
  assert.ok(badScore > unrelatedScore);

  const initialsScore = fuzzyScoreTitle('b99', 'Brooklyn Nine Nine');
  assert.ok(initialsScore >= 0.85);
});
