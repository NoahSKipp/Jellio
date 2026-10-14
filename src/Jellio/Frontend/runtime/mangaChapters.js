// Pure chapter-list logic for the manga series page, without the DOM or
// the API, so it can be tested on its own.

// "Prologue N" gets a range of its own below 0.01 (0.0001 per prologue),
// the same as the server's ChapterNumbers, so it never takes the number of
// "Chapter N". A bare "Prologue" is the first.
const PROLOGUE = /^\s*(?:vol(?:ume)?\.?\s*\d+\s*[-:]?\s*)?prologue\b\s*(?:#?(\d+))?/i;
export const PROLOGUE_STEP = 0.0001;

export function isPrologue(name) {
  return PROLOGUE.test(String(name || ''));
}

function prologueNumber(name) {
  const match = PROLOGUE.exec(String(name || ''));
  if (!match) return NaN;
  const n = match[1] ? parseInt(match[1], 10) : 1;
  return Math.min(Math.max(n, 1), 99) * PROLOGUE_STEP;
}

// The last number in a chapter's name, e.g. "Chapter 0.06" -> 0.06,
// "Vol. 3 Ch. 21.5" -> 21.5. Compared as numbers so 0.06 sorts before
// 0.1 and 9 before 10.
function chapterNumber(item) {
  const prologue = prologueNumber(item.Name);
  if (!isNaN(prologue)) return prologue;
  const match = /(\d+(?:\.\d+)?)(?!.*\d)/.exec(item.Name || '');
  return match ? parseFloat(match[1]) : NaN;
}

export function compareChapters(a, b) {
  const x = chapterNumber(a);
  const y = chapterNumber(b);
  if (!isNaN(x) && !isNaN(y) && x !== y) return x - y;
  return (a.SortName || a.Name || '').localeCompare(b.SortName || b.Name || '', undefined, { numeric: true });
}

// A chapter read straight from its source (MangaStreamController), shaped
// like a library item so the shelf, reader and downloads treat it alike.
export function streamChapterItem(chapter, seriesTitle) {
  return {
    Id: chapter.Id,
    Name: chapter.Name,
    SortName: chapter.Name,
    Type: 'Book',
    SeriesName: seriesTitle,
    DateCreated: chapter.UploadDate ? new Date(chapter.UploadDate).toISOString() : null,
    ImageTags: {},
    UserData: {},
    Stream: { ChapterId: chapter.ChapterId, MangaId: chapter.MangaId, PageCount: chapter.PageCount },
    ChapterNumber: chapter.Number,
    Scanlator: chapter.Scanlator || '',
    SourceOrder: chapter.SourceOrder,
    IsDownloaded: !!chapter.IsDownloaded,
  };
}

export function chapterNameKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Where a saved chapter file came from: Suwayomi saves downloads under
// .../mangas/<Source>/<Series>/<chapter>, so the folder after "mangas" is
// the source. '' when the file isn't laid out that way.
export function chapterSource(item) {
  if (item && item.MangaSource) return item.MangaSource;
  const parts = String((item && item.Path) || '').split(/[\\/]/).filter(Boolean);
  for (let i = parts.length - 3; i >= 0; i--) {
    if (parts[i].toLowerCase() === 'mangas') return parts[i + 1];
  }
  return '';
}

function sourceKey(name) {
  return String(name || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join(' ');
}

// "MangaDex (EN)" and "MangaDex" are the same source.
export function sourceMatches(folder, source) {
  const a = sourceKey(folder);
  const b = sourceKey(source);
  if (!a || !b) return false;
  return a === b || a.startsWith(b + ' ') || b.startsWith(a + ' ');
}

// Saved files split by whether they come from the streamed entry's source.
// Only those are merged into the chapter list; the rest go under "Other
// sources". Without a stream, or a stream whose source isn't known, every
// file belongs to the list as before.
export function splitBySource(libraryChapters, streamSeries) {
  const known = streamSeries && (streamSeries.Source || streamSeries.SourceName);
  if (!known) return { matching: libraryChapters.slice(), others: [] };
  const matching = [];
  const others = [];
  libraryChapters.forEach(function (item) {
    const folder = chapterSource(item);
    const same = folder && (sourceMatches(folder, streamSeries.Source) || sourceMatches(folder, streamSeries.SourceName));
    (same ? matching : others).push(item);
  });
  return { matching: matching, others: others.sort(compareChapters) };
}

// A series' chapters from both places: the library's files (saved to the
// server) win, carrying the streamed chapter's id for its progress;
// everything else streams.
export function mergeStreamChapters(libraryChapters, streamSeries) {
  if (!streamSeries) return libraryChapters.slice().sort(compareChapters);
  const byName = new Map();
  libraryChapters.forEach((item) => byName.set(chapterNameKey(item.Name), item));
  const used = new Set();
  const merged = streamSeries.Chapters.map(function (chapter) {
    const key = chapterNameKey(chapter.Name);
    let saved = byName.get(key);
    if (!saved) {
      for (const [name, item] of byName) {
        if (!used.has(item) && (name.endsWith(' ' + key) || key.endsWith(' ' + name))) {
          saved = item;
          break;
        }
      }
    }
    if (saved && !used.has(saved)) {
      used.add(saved);
      return Object.assign({}, saved, {
        StreamId: chapter.Id,
        ChapterNumber: chapter.Number,
        Scanlator: chapter.Scanlator || '',
        SourceOrder: chapter.SourceOrder,
        IsDownloaded: !!chapter.IsDownloaded,
      });
    }
    return streamChapterItem(chapter, streamSeries.Title);
  });
  libraryChapters.forEach((item) => {
    if (!used.has(item)) merged.push(item);
  });
  return merged.sort(compareChapters);
}

// Whether an item is a manga/comic chapter (CBZ/CBR/stream or folder chapter)
// rather than a regular standalone book, to decide reading order and cover fallbacks.
export function isMangaChapter(item) {
  if (!item) return false;
  if (item.Type !== 'Book' && item.Type !== 'AudioBook') return false;
  if (item.Stream && item.Stream.MangaId) return true;
  if (item.MangaId) return true;
  if (typeof item.ChapterNumber === 'number' && item.ChapterNumber >= 0) return true;
  if (item.SeriesName) return true;
  const name = item.Name || '';
  if (isPrologue(name)) return true;
  if (/^\s*(?:chapter|ch\.|c\.|vol\.|volume|v\.|ep\.|episode|oneshot|one-shot)\b/i.test(name)) return true;
  if (/\b(?:chapter|ch\.)\s*\d+/i.test(name)) return true;
  const path = item.Path || '';
  if (/(?:[\\/]|^)(?:mangas?|comics?|manhwa|manhua|webtoons?)(?:[\\/]|$)/i.test(path)) return true;
  return false;
}
