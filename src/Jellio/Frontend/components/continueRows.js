import { getContinueListening, getContinueReading } from '../runtime/apiBooks.js';
import { itemShelfKey, loadShelf, seriesShelfKey } from '../runtime/shelf.js';
import { withoutHiddenContinue } from '../runtime/readerContinue.js';
import { isMangaItem } from '../runtime/readingListHelpers.js';
import { mangaSeriesKey, mangaSeriesTitle } from './mangaSeries.js';

// The shelf key of the series a comic chapter belongs to, or ''.
export function chapterSeriesKey(item) {
  const title = item && isMangaItem(item) ? mangaSeriesTitle(item) : '';
  const key = title ? mangaSeriesKey(title) : '';
  return key ? seriesShelfKey(key) : '';
}

// The home rows' Continue reading and listening, without what the reader
// removed from their library or took out of Continue reading on any device.
// The shelf answers the same for every kind.
export function loadVisibleContinueReading(limit) {
  return Promise.all([getContinueReading(limit), loadShelf('ebook')]).then(function (results) {
    return withoutHiddenContinue(results[0], results[1], chapterSeriesKey, itemShelfKey);
  });
}

export function loadVisibleContinueListening(limit) {
  return Promise.all([getContinueListening(limit), loadShelf('audiobook')]).then(function (results) {
    return withoutHiddenContinue(results[0], results[1], () => '', itemShelfKey);
  });
}
