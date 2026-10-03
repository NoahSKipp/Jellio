import { getMangaSeriesCoverUrl, getStreamCoverUrl } from '../runtime/api.js';

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
  // A chapter saved to the server may have been read while streamed.
  const own = progress[idKey(item.Id)];
  const streamed = item.StreamId ? progress[idKey(item.StreamId)] : null;
  const record = own && streamed ? (own.Progress >= streamed.Progress ? own : streamed) : own || streamed;
  if (!record || !record.Progress) return { read: false, started: false, record: null };
  return { read: record.Progress >= FINISHED, started: record.Progress < FINISHED, record: record };
}

// Where to pick a series back up: a chapter left part way through after
// the furthest one finished, else the first unread chapter after it.
// lastRead is the latest progress time in the series (0 if never read).
export function resumePoint(chapters, progress, duplicatesAsOne) {
  let furthestRead = -1;
  let lastRead = 0;
  let readCount = 0;
  const readNumbers = duplicatesAsOne !== false ? new Set() : null;
  chapters.forEach(function (item, index) {
    const state = chapterState(item, progress);
    if (state.record) lastRead = Math.max(lastRead, Date.parse(state.record.UpdatedAt) || 0);
    if (state.read) {
      furthestRead = index;
      if (duplicatesAsOne !== false) {
        const num = chapterNumberOf(item);
        if (num >= 0) {
          if (!readNumbers.has(num)) {
            readNumbers.add(num);
            readCount += 1;
          }
        } else {
          readCount += 1;
        }
      } else {
        readCount += 1;
      }
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
export function useSeriesCover(img, chapter, onMissing, streamMangaId) {
  const fallback = img.getAttribute('src');
  img.addEventListener('error', function onError() {
    img.removeEventListener('error', onError);
    if (fallback) img.src = fallback;
    else if (onMissing) onMissing();
  });
  img.src = chapter && !chapter.Stream ? getMangaSeriesCoverUrl(chapter.Id) : getStreamCoverUrl(streamMangaId || chapter.Stream.MangaId);
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

// A series' chapter settings (Mihon's): its own where it has set them,
// else the reader's defaults. An older single filter (unread or
// bookmarked) still counts until the new ones are set.
export function chapterSettings(own, defaults) {
  const mine = own || {};
  const base = defaults || {};
  const pick = (key) => (mine[key] != null ? mine[key] : base[key] != null ? base[key] : null);
  const hasNewFilters = ['FilterUnread', 'FilterBookmarked', 'FilterDownloaded'].some((key) => mine[key] != null);
  const legacy = !hasNewFilters && mine.ChapterFilter ? mine.ChapterFilter : null;
  return {
    descending: !!pick('ChapterDescending'),
    sort: pick('ChapterSort') || 'number',
    display: pick('ChapterDisplay') || 'title',
    unread: pick('FilterUnread') || (legacy === 'unread' ? 'include' : null),
    bookmarked: pick('FilterBookmarked') || (legacy === 'bookmarked' ? 'include' : null),
    downloaded: pick('FilterDownloaded'),
  };
}

// Whether a chapter passes the series' include/exclude filters.
export function passesChapterFilters(item, settings, read, bookmarked) {
  const test = (mode, value) => mode == null || (mode === 'include' ? value : !value);
  const downloaded = !item.Stream || !!item.IsDownloaded;
  return test(settings.unread, !read) && test(settings.bookmarked, bookmarked) && test(settings.downloaded, downloaded);
}

// The chapters oldest first by the chosen sort (then reversed for newest
// first). Source order is the order the source lists them in, oldest
// first as Suwayomi numbers it.
export function sortChapters(chapters, settings) {
  const indexed = chapters.map((chapter, index) => ({ chapter: chapter, index: index }));
  const number = (item) => (chapterNumberOf(item) < 0 ? Number.MAX_SAFE_INTEGER : chapterNumberOf(item));
  const date = (item) => (item.DateCreated ? Date.parse(item.DateCreated) || 0 : 0);
  const compare = {
    number: (a, b) => number(a.chapter) - number(b.chapter) || a.index - b.index,
    source: (a, b) => (a.chapter.SourceOrder ?? a.index) - (b.chapter.SourceOrder ?? b.index) || a.index - b.index,
    date: (a, b) => date(a.chapter) - date(b.chapter) || a.index - b.index,
    title: (a, b) => String(a.chapter.Name || '').localeCompare(String(b.chapter.Name || ''), undefined, { numeric: true, sensitivity: 'base' }) || a.index - b.index,
  }[settings.sort] || ((a, b) => a.index - b.index);
  const sorted = indexed.sort(compare).map((entry) => entry.chapter);
  return settings.descending ? sorted.reverse() : sorted;
}

// "Chapter 12.5" for the number display, the source's title otherwise.
export function chapterLabelFor(item, settings) {
  const number = chapterNumberOf(item);
  if (settings.display === 'number' && number >= 0) return 'Chapter ' + String(Math.round(number * 1000) / 1000);
  return item.Name;
}

// The chapter number, or -1 when the source gave none.
export function chapterNumberOf(item) {
  return typeof item.ChapterNumber === 'number' && item.ChapterNumber >= 0 ? item.ChapterNumber : -1;
}

// The groups that scanlated a series' chapters, with how many each did.
export function listScanlators(chapters) {
  const counts = new Map();
  chapters.forEach(function (chapter) {
    if (chapter.Scanlator) counts.set(chapter.Scanlator, (counts.get(chapter.Scanlator) || 0) + 1);
  });
  return Array.from(counts, ([name, count]) => ({ name: name, count: count })).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );
}

// Mihon's excluded scanlators: the chapters left once those groups are
// hidden. Hiding every group would leave nothing to read, so then none
// are hidden.
export function applyScanlatorFilter(chapters, excluded) {
  if (!excluded || !excluded.length) return chapters;
  const hidden = new Set(excluded.map((name) => name.toLowerCase()));
  const shown = chapters.filter((chapter) => !chapter.Scanlator || !hidden.has(chapter.Scanlator.toLowerCase()));
  return shown.length ? shown : chapters;
}

// The chapters either side of the one being read, Mihon's way: the
// series' scanlator filter applies, and the same chapter number from
// several groups counts once, taking the one being read, else the same
// group's copy, else the first. current: { id, name } of the open
// chapter; chapters are the streamed series' own, in reading order.
export function chapterNeighbors(chapters, current, excluded, skipRead) {
  const nameKey = chapterNameKey(current.name);
  const here =
    chapters.find((chapter) => chapter.Id === current.id) ||
    chapters.find((chapter) => chapterNameKey(chapter.Name) === nameKey);
  if (!here) return { prev: null, next: null };
  const shown = applyScanlatorFilter(chapters, excluded);
  const pool = shown.indexOf(here) === -1 ? chapters.filter((chapter) => chapter === here || shown.indexOf(chapter) !== -1) : shown;
  const groups = new Map();
  const order = [];
  pool.forEach(function (chapter) {
    const number = typeof chapter.Number === 'number' ? chapter.Number : -1;
    if (number < 0) {
      order.push([chapter]);
      return;
    }
    if (!groups.has(number)) {
      groups.set(number, []);
      order.push(groups.get(number));
    }
    groups.get(number).push(chapter);
  });
  const list = order.map(
    (group) =>
      group.find((chapter) => chapter === here) ||
      (here.Scanlator ? group.find((chapter) => chapter.Scanlator === here.Scanlator) : null) ||
      group[0],
  );
  // Optionally leave out chapters already read (the open one stays).
  const walk = skipRead ? list.filter((chapter) => chapter === here || !skipRead(chapter)) : list;
  const index = walk.indexOf(here);
  return {
    prev: index > 0 ? walk[index - 1] : null,
    next: index !== -1 && index < walk.length - 1 ? walk[index + 1] : null,
  };
}

// The same chapter number from several groups is one chapter: once any
// copy is read, the others count as read (Mihon's mark duplicate chapters
// read). Returns progress with those extra reads added, stored progress
// untouched.
export function withDuplicateReads(chapters, progress) {
  const finished = new Map();
  chapters.forEach(function (chapter) {
    const number = chapterNumberOf(chapter);
    if (number < 0) return;
    const state = chapterState(chapter, progress);
    if (state.read && !finished.has(number)) finished.set(number, state.record);
  });
  if (!finished.size) return progress;
  const extended = Object.assign({}, progress);
  chapters.forEach(function (chapter) {
    const number = chapterNumberOf(chapter);
    if (number < 0 || !finished.has(number) || chapterState(chapter, progress).read) return;
    extended[idKey(chapter.Id)] = finished.get(number);
  });
  return extended;
}

function chapterNameKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
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
