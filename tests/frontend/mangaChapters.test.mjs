import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chapterSource,
  compareChapters,
  mergeStreamChapters,
  sourceMatches,
  splitBySource,
} from '../../src/Jellio/Frontend/runtime/mangaChapters.js';

const file = (source, name) => ({
  Id: 'f-' + source + '-' + name,
  Name: name,
  Type: 'Book',
  Path: '/data/suwayomi/downloads/mangas/' + source + '/Berserk/' + name + '.cbz',
});
const streamed = (source, names) => ({
  MangaId: 7,
  Title: 'Berserk',
  Source: source + ' (EN)',
  SourceName: source,
  Chapters: names.map((name, i) => ({ Id: 's' + i, ChapterId: 100 + i, MangaId: 7, Name: name, Number: i + 1, Scanlator: '', PageCount: 20 })),
});

// What the series page shows: the merged list, and the "Other sources" group.
function seriesPage(files, stream) {
  const split = splitBySource(files, stream);
  return { main: mergeStreamChapters(split.matching, stream), otherSources: split.others };
}

test('downloads from source A and a stream from source B: only B in the list, A behind Other sources', () => {
  const files = [file('MangaDex (EN)', 'Chapter 1'), file('MangaDex (EN)', 'Chapter 2'), file('MangaDex (EN)', 'Chapter 0.01')];
  const page = seriesPage(files, streamed('Comick', ['Chapter 1', 'Chapter 2', 'Chapter 3']));
  assert.deepEqual(page.main.map((c) => c.Id), ['s0', 's1', 's2']);
  assert.ok(page.main.every((c) => c.Stream), 'every main row is a streamed chapter from B');
  assert.equal(page.otherSources.length, 3);
  assert.ok(page.otherSources.every((c) => chapterSource(c) === 'MangaDex (EN)'));
});

test('downloads from the streamed source still merge into it', () => {
  const files = [file('Comick (EN)', 'Chapter 2')];
  const page = seriesPage(files, streamed('Comick', ['Chapter 1', 'Chapter 2']));
  assert.equal(page.main.length, 2);
  const saved = page.main.find((c) => c.Id === 'f-Comick (EN)-Chapter 2');
  assert.ok(saved, 'the saved file stands in for the streamed chapter');
  assert.equal(saved.StreamId, 's1');
  assert.equal(page.otherSources.length, 0);
});

test('without a known stream source, files merge as before', () => {
  const stream = streamed('Comick', ['Chapter 1']);
  delete stream.Source;
  delete stream.SourceName;
  const page = seriesPage([file('MangaDex (EN)', 'Chapter 5')], stream);
  assert.equal(page.main.length, 2);
  assert.equal(page.otherSources.length, 0);
});

test('files outside the mangas/<Source>/ layout count as another source when a stream source is known', () => {
  const loose = { Id: 'x', Name: 'Chapter 4', Type: 'Book', Path: '/media/books/Berserk/Chapter 4.cbz' };
  assert.equal(chapterSource(loose), '');
  const page = seriesPage([loose], streamed('Comick', ['Chapter 1']));
  assert.equal(page.main.length, 1);
  assert.deepEqual(page.otherSources.map((c) => c.Id), ['x']);
});

test('source names match with or without the language', () => {
  assert.ok(sourceMatches('MangaDex (EN)', 'MangaDex'));
  assert.ok(sourceMatches('mangadex', 'MangaDex (EN)'));
  assert.ok(!sourceMatches('Manga', 'MangaDex'));
});

test('Prologue N sorts in its own range, before Chapter 1 and apart from Chapter N', () => {
  const names = ['Chapter 2', 'Prologue 2', 'Chapter 1', 'Prologue 1', 'Chapter 0.01'];
  const sorted = names.map((name) => ({ Name: name })).sort(compareChapters).map((c) => c.Name);
  assert.deepEqual(sorted, ['Prologue 1', 'Prologue 2', 'Chapter 0.01', 'Chapter 1', 'Chapter 2']);
});
