import { getMangaSeriesCoverUrl } from '../runtime/api.js';

// Manga arrives as one file per chapter or volume (Suwayomi saves each
// chapter as its own CBZ), so the Manga shelf groups files into series:
// Jellyfin's SeriesName when it has one, otherwise the folder the files
// sit in, which is how Suwayomi and most manga libraries are laid out.

// The last number in a chapter's name, e.g. "Chapter 0.06" -> 0.06,
// "Vol. 3 Ch. 21.5" -> 21.5. Compared as numbers so 0.06 sorts before
// 0.1 and 9 before 10.
function chapterNumber(item) {
  const match = /(\d+(?:\.\d+)?)(?!.*\d)/.exec(item.Name || '');
  return match ? parseFloat(match[1]) : NaN;
}

export function compareChapters(a, b) {
  const x = chapterNumber(a);
  const y = chapterNumber(b);
  if (!isNaN(x) && !isNaN(y) && x !== y) return x - y;
  return (a.SortName || a.Name || '').localeCompare(b.SortName || b.Name || '', undefined, { numeric: true });
}

function folderName(path) {
  const parts = String(path || '').split(/[\\/]/).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : '';
}

export function mangaSeriesTitle(item) {
  return item.SeriesName || folderName(item.Path) || '';
}

export function mangaSeriesKey(title) {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// [{ key, title, chapters (in reading order) }], plus the files that
// don't share a series with anything (shown on their own).
export function groupMangaSeries(items) {
  const groups = new Map();
  items.forEach(function (item) {
    const title = mangaSeriesTitle(item);
    const key = title ? mangaSeriesKey(title) : '';
    if (!key) return;
    if (!groups.has(key)) groups.set(key, { key: key, title: title, chapters: [] });
    groups.get(key).chapters.push(item);
  });
  const series = [];
  const inSeries = new Set();
  groups.forEach(function (group) {
    if (group.chapters.length < 2) return;
    group.chapters.sort(compareChapters);
    group.chapters.forEach((item) => inSeries.add(item));
    series.push(group);
  });
  return { series: series, singles: items.filter((item) => !inSeries.has(item)) };
}

function idKey(id) {
  return String(id).replace(/-/g, '');
}

const FINISHED = 0.98;

export function chapterState(item, progress) {
  const record = progress[idKey(item.Id)];
  if (!record || !record.Progress) return { read: false, started: false, record: null };
  return { read: record.Progress >= FINISHED, started: record.Progress < FINISHED, record: record };
}

// Where to pick a series back up: a chapter left part way through after
// the furthest one finished, else the first unread chapter after it.
// lastRead is the latest progress time in the series (0 if never read).
export function resumePoint(chapters, progress) {
  let furthestRead = -1;
  let lastRead = 0;
  let readCount = 0;
  chapters.forEach(function (item, index) {
    const state = chapterState(item, progress);
    if (state.record) lastRead = Math.max(lastRead, Date.parse(state.record.UpdatedAt) || 0);
    if (state.read) {
      furthestRead = index;
      readCount += 1;
    }
  });
  let resume = chapters.findIndex(function (item, index) {
    return index > furthestRead && chapterState(item, progress).started;
  });
  if (resume === -1) resume = chapters.findIndex((item, index) => index > furthestRead && !chapterState(item, progress).read);
  return {
    chapter: resume === -1 ? null : chapters[resume],
    index: resume,
    readCount: readCount,
    lastRead: lastRead,
    finished: resume === -1 && readCount > 0,
  };
}

// Shows the series' real cover (a cover image in its folder, Suwayomi's,
// or AniList's) on an <img>, falling back to the chapter image it had.
export function useSeriesCover(img, chapter, onMissing) {
  const fallback = img.getAttribute('src');
  img.addEventListener('error', function onError() {
    img.removeEventListener('error', onError);
    if (fallback) img.src = fallback;
    else if (onMissing) onMissing();
  });
  img.src = getMangaSeriesCoverUrl(chapter.Id);
}
