import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  linkChannelId,
  parseLinkChannelId,
  flattenStreamLinks,
  groupStreamLinks,
  streamLinkErrorKey,
  playableInBrowser,
} from '../../src/Jellio/Frontend/runtime/streamLinks.js';
import { filterChannels } from '../../src/Jellio/Frontend/runtime/liveTv.js';

const LINKS = [
  { Id: 'a1', Name: 'Red Bull TV', SourceUrl: 'https://rb.example/live', Kind: 'stream', Entries: [], Description: 'Extreme sports', SiteName: 'Red Bull', Quality: '1080p', ImageUrl: 'http://rb.example/i.png', Health: 'failing' },
  {
    Id: 'p1',
    Name: 'Free channels',
    SourceUrl: 'https://pl.example/list.m3u',
    Kind: 'playlist',
    Entries: [
      { Name: 'Sport1 Germany', Url: 'https://a/1.m3u8', Group: 'Sports', Logo: 'https://a/1.png' },
      { Name: 'France 24', Url: 'https://a/2.m3u8', Group: 'News' },
    ],
  },
  { Name: 'missing id' },
];

test('channel ids round trip', () => {
  assert.equal(linkChannelId('a1', null), 'link:a1');
  assert.equal(linkChannelId('p1', 3), 'link:p1:3');
  assert.deepEqual(parseLinkChannelId('link:a1'), { linkId: 'a1', entry: null });
  assert.deepEqual(parseLinkChannelId('link:p1:3'), { linkId: 'p1', entry: 3 });
  assert.deepEqual(parseLinkChannelId('link:p1:x'), { linkId: 'p1', entry: null });
  assert.equal(parseLinkChannelId('dlhd.1'), null);
  assert.equal(parseLinkChannelId('link:'), null);
  assert.equal(parseLinkChannelId(undefined), null);
});

test('flattening expands playlists in order and classifies by name and group', () => {
  const flat = flattenStreamLinks(LINKS);
  assert.deepEqual(flat.map((c) => c.id), ['link:a1', 'link:p1:0', 'link:p1:1']);
  assert.equal(flat[0].group, 'Red Bull');
  assert.equal(flat[0].description, 'Extreme sports');
  assert.equal(flat[0].quality, '1080p');
  assert.equal(flat[0].failing, true);
  // Plain http images are not shown.
  assert.equal(flat[0].logoUrl, null);
  assert.equal(flat[1].failing, false);
  assert.equal(flat[1].kind, 'sports');
  assert.equal(flat[1].language, 'German');
  assert.equal(flat[1].logoUrl, 'https://a/1.png');
  assert.equal(flat[2].group, 'News');
  assert.ok(flat.every((c) => c.userStream && !c.favorite && c.now === null));
});

test('search matches the group as well as the name', () => {
  const flat = flattenStreamLinks(LINKS);
  assert.deepEqual(filterChannels(flat, 'news', {}).map((c) => c.name), ['France 24']);
  assert.deepEqual(filterChannels(flat, '', { kind: 'sports' }).map((c) => c.name), ['Sport1 Germany']);
});

test('grouping keeps singles apart from playlists and narrows to what is visible', () => {
  const all = groupStreamLinks(LINKS, null);
  assert.equal(all.singles.length, 1);
  assert.equal(all.playlists.length, 1);
  assert.equal(all.playlists[0].channels.length, 2);
  const narrowed = groupStreamLinks(LINKS, ['link:p1:1']);
  assert.equal(narrowed.singles.length, 0);
  assert.deepEqual(narrowed.playlists[0].channels.map((c) => c.name), ['France 24']);
});

test('errors map to sentences and only browser formats play on web', () => {
  assert.equal(streamLinkErrorKey('blocked_address'), 'live_link_error_blocked');
  assert.equal(streamLinkErrorKey('no_stream_found'), 'live_link_error_none');
  assert.equal(streamLinkErrorKey('whatever'), 'live_link_error_failed');
  assert.equal(playableInBrowser('hls'), true);
  assert.equal(playableInBrowser('mp4'), true);
  assert.equal(playableInBrowser('ts'), false);
});
