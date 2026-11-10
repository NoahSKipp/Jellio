import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLanguage, preferredStreamLanguage, orderByLanguage } from '../../src/Jellio/Frontend/runtime/streamLanguage.js';
import { languageName } from '../../src/Jellio/Frontend/runtime/languages.js';

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

test('every ISO 639-1, 639-2/B and 639-2/T form meets on one code', () => {
  for (const code of ['cs', 'cze', 'ces', 'CS-cz', 'Czech']) assert.equal(normalizeLanguage(code), 'cze', code);
  for (const code of ['hi', 'hin', 'Hindi']) assert.equal(normalizeLanguage(code), 'hin', code);
  for (const code of ['fa', 'per', 'fas', 'Farsi', 'Persian']) assert.equal(normalizeLanguage(code), 'per', code);
  for (const code of ['nl', 'dut', 'nld', 'Flemish']) assert.equal(normalizeLanguage(code), 'dut', code);
  for (const code of ['el', 'gre', 'ell', 'Greek']) assert.equal(normalizeLanguage(code), 'gre', code);
  for (const code of ['zh', 'zh-TW', 'chi', 'zho', 'Chinese']) assert.equal(normalizeLanguage(code), 'chi', code);
  for (const code of ['uk', 'ukr', 'Ukrainian']) assert.equal(normalizeLanguage(code), 'ukr', code);
  for (const code of ['he', 'iw', 'heb']) assert.equal(normalizeLanguage(code), 'heb', code);
  assert.equal(normalizeLanguage('pt_BR'), 'por');
  assert.equal(normalizeLanguage('Portuguese (Brazil)'), 'por');
  assert.equal(normalizeLanguage('Norwegian Bokmal'), 'nob');
});

test('codes outside the table pass through lower-cased', () => {
  assert.equal(normalizeLanguage('XYZ'), 'xyz');
  assert.equal(normalizeLanguage('__multi__'), '__multi__');
  assert.equal(normalizeLanguage('fil'), 'fil');
});

test('streams in languages beyond the common few still match', () => {
  const cz = { id: 'cz', langs: ['ces'] };
  const en = { id: 'en', langs: ['eng'] };
  assert.deepEqual(orderByLanguage([en, cz], 'cs', langs).map((s) => s.id), ['cz']);
  const hi = { id: 'hi', langs: ['hin'] };
  assert.deepEqual(orderByLanguage([en, hi], 'hi-IN', langs).map((s) => s.id), ['hi']);
});

test('languageName shares the table', () => {
  assert.equal(languageName('ces'), 'Czech');
  assert.equal(languageName('cze'), 'Czech');
  assert.equal(languageName('de'), 'German');
  assert.equal(languageName('deu'), 'German');
  assert.equal(languageName('__multi__'), 'Multi-Audio');
  assert.equal(languageName(''), 'Unknown');
  assert.equal(languageName('qqq'), 'QQQ');
});
