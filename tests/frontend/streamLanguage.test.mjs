import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLanguage, preferredStreamLanguage, orderByLanguage } from '../../src/Jellio/Frontend/runtime/streamLanguage.js';

const langs = (source) => source.langs;

test('two and three letter codes meet', () => {
  assert.equal(normalizeLanguage('de'), 'ger');
  assert.equal(normalizeLanguage('deu'), 'ger');
  assert.equal(normalizeLanguage('de-DE'), 'ger');
  assert.equal(normalizeLanguage(''), '');
});

test('a set audio preference beats the menu language', () => {
  assert.equal(preferredStreamLanguage('eng', 'de'), 'eng');
  assert.equal(preferredStreamLanguage('', 'de'), 'ger');
  assert.equal(preferredStreamLanguage(null, 'en'), 'eng');
});

test('matching streams first, then multi-audio, others only when nothing matches', () => {
  const de = { id: 'de', langs: ['ger', 'eng'] };
  const en = { id: 'en', langs: ['eng'] };
  const multi = { id: 'multi', langs: ['__multi__'] };
  assert.deepEqual(orderByLanguage([en, multi, de], 'de', langs).map((s) => s.id), ['de', 'multi']);
  assert.deepEqual(orderByLanguage([en], 'de', langs).map((s) => s.id), ['en']);
  assert.deepEqual(orderByLanguage([en, de], '', langs).map((s) => s.id), ['en', 'de']);
});
