// Pure helpers for the reading list (books, audiobooks and manga kept apart
// from the watchlist): no DOM, no network, so they test under node.
// The server contract is READING_LIST_CONTRACT.md.

export const READING_LIST_MAX = 500;

const KINDS = ['ebook', 'audiobook', 'manga'];

export function isReadingKind(kind) {
  return KINDS.indexOf(kind) !== -1;
}

// Book and AudioBook items are the only Jellyfin types that go on the list.
export function isReadingType(type) {
  return type === 'Book' || type === 'AudioBook';
}

function plainId(id) {
  return String(id || '').replace(/-/g, '').toLowerCase();
}

// Library items have GUID ids; a chapter streamed from a source does not.
export function isLibraryItemId(id) {
  return /^[0-9a-f]{32}$/.test(plainId(id));
}

export function itemReadingKey(itemId) {
  return 'i:' + plainId(itemId);
}

// `seriesKey` is the shelf series key, with or without the "s:" prefix.
export function seriesReadingKey(seriesKey) {
  const key = String(seriesKey || '');
  return key.indexOf('s:') === 0 ? key : 's:' + key;
}

export function workReadingKey(workId) {
  return 'w:' + String(workId || '');
}

function httpsOnly(url) {
  return typeof url === 'string' && url.indexOf('https://') === 0 && url.length <= 300 ? url : undefined;
}

function compact(target) {
  Object.keys(target).forEach(function (field) {
    if (target[field] === undefined || target[field] === null || target[field] === '') delete target[field];
  });
  return target;
}

// A comic file or a chapter read from a manga source, as opposed to a book
// that merely sits in a folder (Jellyfin gives those a SeriesName too).
export function isMangaItem(item) {
  if (!item) return false;
  if ((item.Stream && item.Stream.MangaId) || item.MangaId) return true;
  const path = String(item.Path || '');
  if (/\.(?:cbz|cbr|cb7|cbt)$/i.test(path)) return true;
  return /(?:[\\/]|^)(?:mangas?|comics?|manhwa|manhua|webtoons?)(?:[\\/]|$)/i.test(path);
}

// A Jellyfin Book or AudioBook. `manga` says a Book is a comic file.
// The server reads the title and author from the item itself.
export function readingTargetForItem(item, manga) {
  if (!item || !isReadingType(item.Type) || !isLibraryItemId(item.Id)) return null;
  const kind = item.Type === 'AudioBook' ? 'audiobook' : manga ? 'manga' : 'ebook';
  return compact({
    Key: itemReadingKey(item.Id),
    Kind: kind,
    ItemId: plainId(item.Id),
    Title: item.Name,
    Author: item.AlbumArtist,
  });
}

// A manga series by its shelf key; `mangaId` is the Suwayomi id when known
// and `itemId` a local chapter file to draw the cover from.
export function readingTargetForSeries(series) {
  if (!series || !series.key || !series.title) return null;
  return compact({
    Key: seriesReadingKey(series.key),
    Kind: 'manga',
    Title: series.title,
    Author: series.author,
    CoverUrl: httpsOnly(series.coverUrl),
    MangaId: series.mangaId > 0 ? series.mangaId : undefined,
    ItemId: series.itemId && isLibraryItemId(series.itemId) ? plainId(series.itemId) : undefined,
  });
}

// A Discover book that is not a library item.
export function readingTargetForWork(book, kind) {
  if (!book || !book.WorkId || !book.Title) return null;
  return compact({
    Key: workReadingKey(book.WorkId),
    Kind: kind === 'audiobook' ? 'audiobook' : 'ebook',
    Title: book.Title,
    Author: book.Author,
    CoverUrl: httpsOnly(book.CoverUrl),
  });
}

// The "Reading" section holds books and manga, "Listening" audiobooks.
export function splitReadingEntries(entries) {
  const reading = [];
  const listening = [];
  (entries || []).forEach(function (entry) {
    (entry.Kind === 'audiobook' ? listening : reading).push(entry);
  });
  return { reading: reading, listening: listening };
}

export function readingKindLabelKey(kind) {
  if (kind === 'audiobook') return 'reading_kind_audiobook';
  if (kind === 'manga') return 'reading_kind_manga';
  return 'reading_kind_ebook';
}

// What tapping an entry opens: a Jellyfin item page, a manga series (the
// caller resolves the shelf), or nothing yet (a book that is not in the
// library, looked up by title).
export function readingEntryRoute(entry) {
  const key = String((entry && entry.Key) || '');
  if (key.indexOf('i:') === 0 && entry.ItemId) return { type: 'item', hash: '#/item?id=' + entry.ItemId };
  if (key.indexOf('s:') === 0) return { type: 'series', seriesKey: key.slice(2) };
  return { type: 'work', title: entry && entry.Title };
}

// An entry shaped like a card item, so it can share the card styling.
export function readingCardItem(entry) {
  return {
    Id: entry.ItemId || entry.Key,
    Name: entry.Title,
    Type: entry.Kind === 'audiobook' ? 'AudioBook' : 'Book',
    AddedBy: entry.AddedBy && entry.AddedBy.length ? entry.AddedBy : undefined,
  };
}

// Server-relative covers (`/Jellio/...`) need the token on the URL for an
// <img>; absolute https covers load as they are.
export function readingCoverSrc(cover, serverAddress, token) {
  if (!cover) return '';
  if (cover.charAt(0) !== '/') return cover;
  return (serverAddress || '') + cover + (cover.indexOf('?') === -1 ? '?' : '&') + 'ApiKey=' + encodeURIComponent(token || '');
}

// A signature of what the Watchlist screen shows, to skip repainting when
// a poll finds nothing new.
export function readingEntriesSignature(entries) {
  return (entries || [])
    .map(function (entry) {
      return entry.Key + ':' + ((entry.AddedBy && entry.AddedBy.length) || 0);
    })
    .join('|');
}

// Whether a title found by search is this entry (same normalised words).
export function sameTitle(a, b) {
  function fold(text) {
    return String(text || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }
  const left = fold(a);
  return left !== '' && left === fold(b);
}

// The message key for an add refusal from the server.
export function readingErrorKey(err) {
  const code = err && err.body && err.body.Error;
  if (err && err.status === 409 && code === 'list_full') return 'reading_toast_full';
  return 'reading_toast_error';
}
