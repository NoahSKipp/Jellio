import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map([['jellio_display_language', 'en']]);
store.set('jellio_auth::session', JSON.stringify({ userId: 'u1', accessToken: 'tok' }));
const events = [];
globalThis.window = {
  Jellio: {},
  localStorage: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  },
  location: { origin: 'http://server', hash: '' },
  addEventListener: () => {},
  removeEventListener: () => {},
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clearTimeout: (id) => clearTimeout(id),
  dispatchEvent: () => true,
};
globalThis.document = {
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: (event) => {
    events.push(event.type);
    return true;
  },
  createElement: () => ({}),
  querySelector: () => null,
};

const calls = [];
let handler = () => ({ status: 200, body: {} });
globalThis.fetch = async (url, init) => {
  calls.push({ url, init: init || {} });
  const { status, body } = handler(url, init || {});
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    status,
    ok: status < 400,
    text: async () => text,
    json: async () => JSON.parse(text),
    headers: { get: () => null },
  };
};

const api = await import('../../src/Jellio/Frontend/runtime/api.js');
const helpers = await import('../../src/Jellio/Frontend/runtime/friendsHelpers.js');
const reading = await import('../../src/Jellio/Frontend/runtime/readingListHelpers.js');
const { t } = await import('../../src/Jellio/Frontend/runtime/i18n.js');

function last() {
  return calls[calls.length - 1];
}

const GUID = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9';
const PLAIN = '0a1b2c3d4e5f60718293a4b5c6d7e8f9';

test('keys: items use their plain id, series the s: prefix, works the w: prefix', () => {
  assert.equal(reading.itemReadingKey(GUID.toUpperCase()), 'i:' + PLAIN);
  assert.equal(reading.seriesReadingKey('berserk'), 's:berserk');
  assert.equal(reading.seriesReadingKey('s:berserk'), 's:berserk');
  assert.equal(reading.workReadingKey('hc:12345'), 'w:hc:12345');
});

test('a book, audiobook or comic file becomes an i: target; streamed chapters and videos do not', () => {
  const book = reading.readingTargetForItem({ Id: GUID, Type: 'Book', Name: 'Dune', AlbumArtist: 'Herbert' });
  assert.deepEqual(book, { Key: 'i:' + PLAIN, Kind: 'ebook', ItemId: PLAIN, Title: 'Dune', Author: 'Herbert' });
  assert.equal(reading.readingTargetForItem({ Id: GUID, Type: 'AudioBook', Name: 'Dune' }, true).Kind, 'audiobook');
  assert.equal(reading.readingTargetForItem({ Id: GUID, Type: 'Book', Name: 'Ch 1' }, true).Kind, 'manga');
  assert.equal(reading.readingTargetForItem({ Id: 'stream12', Type: 'Book', Name: 'Ch 1' }, true), null);
  assert.equal(reading.readingTargetForItem({ Id: GUID, Type: 'Movie', Name: 'Heat' }), null);
  assert.equal(reading.readingTargetForItem(null), null);
});

test('a manga series target keeps only what the server accepts', () => {
  const target = reading.readingTargetForSeries({
    key: 'berserk',
    title: 'Berserk',
    author: 'Miura',
    coverUrl: 'https://img.example/b.jpg',
    mangaId: 42,
    itemId: GUID,
  });
  assert.deepEqual(target, {
    Key: 's:berserk',
    Kind: 'manga',
    Title: 'Berserk',
    Author: 'Miura',
    CoverUrl: 'https://img.example/b.jpg',
    MangaId: 42,
    ItemId: PLAIN,
  });
  const bare = reading.readingTargetForSeries({ key: 'x', title: 'X', coverUrl: 'http://insecure/x.jpg', mangaId: 0, itemId: 'stream9' });
  assert.deepEqual(bare, { Key: 's:x', Kind: 'manga', Title: 'X' });
  assert.equal(reading.readingTargetForSeries({ key: '', title: 'X' }), null);
});

test('a Discover book becomes a w: target of the browsed kind', () => {
  const book = { WorkId: 'hc:77', Title: 'Dune', Author: 'Herbert', CoverUrl: 'https://c.example/d.jpg' };
  assert.deepEqual(reading.readingTargetForWork(book, 'audiobook'), {
    Key: 'w:hc:77',
    Kind: 'audiobook',
    Title: 'Dune',
    Author: 'Herbert',
    CoverUrl: 'https://c.example/d.jpg',
  });
  assert.equal(reading.readingTargetForWork(book, 'ebook').Kind, 'ebook');
  assert.equal(reading.readingTargetForWork({ Title: 'No id' }, 'ebook'), null);
});

test('the watchlist screen splits Reading (books and manga) from Listening (audiobooks)', () => {
  const entries = [
    { Key: 'i:a', Kind: 'ebook' },
    { Key: 'i:b', Kind: 'audiobook' },
    { Key: 's:c', Kind: 'manga' },
    { Key: 'w:d', Kind: 'audiobook' },
  ];
  const split = reading.splitReadingEntries(entries);
  assert.deepEqual(split.reading.map((e) => e.Key), ['i:a', 's:c']);
  assert.deepEqual(split.listening.map((e) => e.Key), ['i:b', 'w:d']);
  assert.deepEqual(reading.splitReadingEntries(null), { reading: [], listening: [] });
});

test('an entry opens its item, its series, or looks the book up', () => {
  assert.deepEqual(reading.readingEntryRoute({ Key: 'i:' + PLAIN, ItemId: PLAIN }), { type: 'item', hash: '#/item?id=' + PLAIN });
  assert.deepEqual(reading.readingEntryRoute({ Key: 's:one punch man' }), { type: 'series', seriesKey: 'one punch man' });
  assert.deepEqual(reading.readingEntryRoute({ Key: 'w:hc:1', Title: 'Dune' }), { type: 'work', title: 'Dune' });
});

test('cover sources get the token only when they are server paths', () => {
  assert.equal(reading.readingCoverSrc('/Jellio/books/item/ab/cover', 'http://s', 'tok'), 'http://s/Jellio/books/item/ab/cover?ApiKey=tok');
  assert.equal(reading.readingCoverSrc('/Jellio/manga/thumbnail/7?title=A', 'http://s', 't k'), 'http://s/Jellio/manga/thumbnail/7?title=A&ApiKey=t%20k');
  assert.equal(reading.readingCoverSrc('https://c.example/1.jpg', 'http://s', 'tok'), 'https://c.example/1.jpg');
  assert.equal(reading.readingCoverSrc(null, 'http://s', 'tok'), '');
});

test('entry cards carry the added-by friends and the signature notices changes', () => {
  const entry = { Key: 'i:a', Kind: 'audiobook', ItemId: 'a', Title: 'T', AddedBy: [{ UserName: 'Al' }] };
  const card = reading.readingCardItem(entry);
  assert.equal(card.Type, 'AudioBook');
  assert.equal(card.AddedBy.length, 1);
  assert.equal(reading.readingCardItem({ Key: 's:x', Kind: 'manga', Title: 'X', AddedBy: [] }).AddedBy, undefined);
  assert.notEqual(
    reading.readingEntriesSignature([entry]),
    reading.readingEntriesSignature([{ ...entry, AddedBy: [] }]),
  );
  assert.equal(reading.readingEntriesSignature([]), '');
});

test('titles are matched without case, accents or punctuation', () => {
  assert.equal(reading.sameTitle('Les Misérables', 'les miserables'), true);
  assert.equal(reading.sameTitle('Dune: Part One', 'Dune Part One'), true);
  assert.equal(reading.sameTitle('Dune', 'Dune Messiah'), false);
  assert.equal(reading.sameTitle('', ''), false);
});

test('add errors map to calm messages', () => {
  assert.equal(reading.readingErrorKey({ status: 409, body: { Error: 'list_full' } }), 'reading_toast_full');
  assert.equal(reading.readingErrorKey({ status: 400, body: { Error: 'invalid_key' } }), 'reading_toast_error');
  assert.equal(reading.readingErrorKey(new Error('x')), 'reading_toast_error');
});

test('the keys probe feeds the toggle state and a 404 turns the feature off', async () => {
  calls.length = 0;
  handler = () => ({ status: 200, body: { Keys: ['i:a', 's:b'], Count: 2, Max: 500 } });
  const keys = await api.loadReadingListKeys();
  assert.equal(last().url, 'http://server/Jellio/reading-list/keys');
  assert.equal(api.readingListSupported(), true);
  assert.equal(api.isOnReadingList('s:b'), true);
  assert.equal(api.isOnReadingList('s:zzz'), false);
  assert.equal(keys.size, 2);
  await api.loadReadingListKeys();
  assert.equal(calls.length, 1);

  handler = () => ({ status: 404, body: undefined });
  await assert.rejects(api.loadReadingListKeys(true));
  assert.equal(api.readingListSupported(), false);
});

test('add and remove use the contract paths, bodies and keep the key set in step', async () => {
  calls.length = 0;
  handler = () => ({ status: 200, body: { Added: true, Item: { Key: 's:berserk' } } });
  await api.addToReadingList({ Key: 's:berserk', Kind: 'manga', Title: 'Berserk' });
  assert.equal(last().url, 'http://server/Jellio/reading-list');
  assert.equal(last().init.method, 'POST');
  assert.deepEqual(JSON.parse(last().init.body), { Key: 's:berserk', Kind: 'manga', Title: 'Berserk' });
  assert.equal(api.isOnReadingList('s:berserk'), true);

  handler = () => ({ status: 200, body: { Removed: true } });
  await api.removeFromReadingList('s:berserk');
  assert.equal(last().url, 'http://server/Jellio/reading-list?key=s%3Aberserk');
  assert.equal(last().init.method, 'DELETE');
  assert.equal(api.isOnReadingList('s:berserk'), false);
});

test('a refused add keeps the status and the JSON error', async () => {
  handler = () => ({ status: 409, body: { Error: 'list_full' } });
  await assert.rejects(api.addToReadingList({ Key: 'w:hc:1', Kind: 'ebook', Title: 'A' }), (err) => {
    assert.equal(err.status, 409);
    assert.equal(err.body.Error, 'list_full');
    assert.equal(reading.readingErrorKey(err), 'reading_toast_full');
    return true;
  });
  assert.equal(api.isOnReadingList('w:hc:1'), false);
});

test('the list loads, replaces the key set and sharing posts the target with the users', async () => {
  handler = () => ({ status: 200, body: { Items: [{ Key: 'i:x' }, { Key: 's:y' }], Count: 2, Max: 500 } });
  const items = await api.getReadingList();
  assert.equal(items.length, 2);
  assert.equal(api.isOnReadingList('i:x'), true);
  assert.equal(api.isOnReadingList('s:berserk'), false);

  calls.length = 0;
  handler = () => ({ status: 200, body: { Results: [{ UserId: 'a', Result: 'added' }] } });
  const results = await api.addReadingToFriends({ Key: 's:berserk', Kind: 'manga', Title: 'Berserk' }, ['a']);
  assert.equal(last().url, 'http://server/Jellio/watchlist/friends');
  assert.deepEqual(JSON.parse(last().init.body), { Key: 's:berserk', Kind: 'manga', Title: 'Berserk', UserIds: ['a'] });
  assert.deepEqual(results, [{ UserId: 'a', Result: 'added' }]);
});

test('books are looked up among the library by title', async () => {
  calls.length = 0;
  handler = () => ({ status: 200, body: { Items: [{ Id: 'x', Type: 'Book', Name: 'Dune' }] } });
  const found = await api.searchBooksByTitle('Dune');
  assert.match(last().url, /\/Users\/u1\/Items\?.*IncludeItemTypes=Book%2CAudioBook/);
  assert.equal(found.length, 1);
  assert.deepEqual(await api.searchBooksByTitle(''), []);
});

test('friend notifications about reading items say reading list and open the right place', () => {
  const book = {
    Kind: 'watchlist_added', Type: 'Book', Name: 'Dune', ItemId: GUID, Detail: '1', FromUserName: 'Al', ReadingKey: 'i:' + PLAIN,
  };
  assert.equal(helpers.isReadingNotification(book), true);
  assert.deepEqual(helpers.notificationText(book), { key: 'friends_notice_added_reading_one', params: { name: 'Al', title: 'Dune' } });
  assert.equal(helpers.notificationTarget(book), '#/item?id=' + GUID);
  assert.equal(helpers.readingNotificationTypeKey(book), 'reading_kind_ebook');
  assert.equal(helpers.notificationSeriesKey(book), null);

  const manga = { ...book, Type: 'Manga', Name: 'Berserk', ItemId: '00000000-0000-0000-0000-000000000000', ReadingKey: 's:berserk' };
  assert.equal(helpers.readingNotificationTypeKey(manga), 'reading_kind_manga');
  assert.equal(helpers.notificationSeriesKey(manga), 'berserk');
  assert.equal(helpers.notificationTarget(manga), '#/home?tab=1');

  const audio = { ...book, Type: 'AudioBook', ReadingKey: 'w:hc:1', ItemId: '00000000-0000-0000-0000-000000000000' };
  assert.equal(helpers.readingNotificationTypeKey(audio), 'reading_kind_audiobook');
  assert.equal(helpers.notificationTarget(audio), '#/home?tab=1');

  // Several titles, or a notification from before reading items: as it was.
  assert.equal(helpers.notificationTarget({ ...book, Detail: '3' }), '#/home?tab=1');
  assert.deepEqual(helpers.notificationText({ ...book, Detail: '3' }), { key: 'friends_notice_added_many', params: { name: 'Al', count: 3 } });
  const movie = { Kind: 'watchlist_added', Type: 'Movie', Name: 'Heat', ItemId: GUID, Detail: '1', FromUserName: 'Al' };
  assert.equal(helpers.isReadingNotification(movie), false);
  assert.equal(helpers.notificationText(movie).key, 'friends_notice_added_one');
  assert.equal(helpers.notificationTarget(movie), '#/item?id=' + GUID);
});

test('the startup toast for one friend add of a book uses the reading wording and target', () => {
  const book = { Id: 'n1', Read: false, Kind: 'watchlist_added', Type: 'Book', Name: 'Dune', ItemId: GUID, Detail: '1', FromUserName: 'Al', ReadingKey: 'i:' + PLAIN };
  const summary = helpers.startupSummary([book], '');
  assert.equal(summary.text.key, 'friends_notice_added_reading_one');
  assert.equal(summary.target, '#/item?id=' + GUID);
});

test('the picker says reading list for the results that differ', () => {
  assert.equal(helpers.resultMessageKey('added', true), 'reading_result_added');
  assert.equal(helpers.resultMessageKey('not_visible', true), 'reading_result_not_visible');
  assert.equal(helpers.resultMessageKey('unsupported', true), 'reading_result_unsupported');
  assert.equal(helpers.resultMessageKey('muted', true), 'friends_result_muted');
  assert.equal(helpers.resultMessageKey('added'), 'friends_result_added');
  assert.equal(helpers.resultMessageKey('not_visible'), 'friends_result_not_visible');
});

test('every reading string exists', () => {
  [
    'reading_list', 'reading_section_reading', 'reading_section_listening', 'reading_kind_ebook', 'reading_kind_audiobook',
    'reading_kind_manga', 'reading_add', 'reading_remove', 'reading_toast_added', 'reading_toast_removed',
    'reading_toast_error', 'reading_toast_full', 'reading_menu_add_to_friend', 'reading_picker_title',
    'reading_result_added', 'reading_result_not_visible', 'reading_result_unsupported', 'friends_notice_added_reading_one',
  ].forEach((key) => assert.notEqual(t(key), key, key));
  assert.equal(t('reading_remove_item', { title: 'Dune' }), 'Remove Dune from your reading list');
  assert.equal(t('reading_not_in_library', { title: 'Dune' }), "Dune isn't in your library yet");
});

test('every web language translates the reading strings', async () => {
  const { readFileSync } = await import('node:fs');
  const dir = new URL('../../src/Jellio/Frontend/runtime/', import.meta.url);
  const keysIn = (file) =>
    new Set([...readFileSync(new URL(file, dir), 'utf8').matchAll(/^\s*((?:reading_|friends_notice_added_reading)\w*):/gm)].map((m) => m[1]));
  const english = keysIn('i18n.js');
  assert.ok(english.size >= 19);
  for (const lang of ['de', 'es', 'fr', 'it', 'pl', 'pt']) {
    const found = keysIn('strings-' + lang + '.js');
    assert.deepEqual([...english].filter((key) => !found.has(key)), [], lang);
  }
});

test('comic files and manga sources read as manga, plain books in a folder do not', () => {
  assert.equal(reading.isMangaItem({ Type: 'Book', Path: '/media/books/Berserk/Ch 1.cbz' }), true);
  assert.equal(reading.isMangaItem({ Type: 'Book', Path: '/media/Manga/Berserk/vol1.epub' }), true);
  assert.equal(reading.isMangaItem({ Type: 'Book', Stream: { MangaId: 3 } }), true);
  assert.equal(reading.isMangaItem({ Type: 'Book', MangaId: 3 }), true);
  assert.equal(reading.isMangaItem({ Type: 'Book', SeriesName: 'Dune Chronicles', Path: '/media/books/Dune/Dune.epub' }), false);
  assert.equal(reading.isMangaItem(null), false);
});
