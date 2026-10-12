import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labelQuality, sourceQuality } from '../../src/Jellio/Frontend/runtime/quality.js';

const named = (name, video) => ({ Name: name, MediaStreams: video ? [Object.assign({ Type: 'Video' }, video)] : [] });

const cases = [
  ['🚀 FHD\nShow.S01E01.1080p.WEB-DL', null, 'FHD'],
  ['🚀 HD\nShow.S01E01.720p.WEB-DL', null, 'HD'],
  ['🚀 HD\nShow.S01E01.WEB-DL', { Height: 1080, Width: 1920 }, 'HD'],
  ['Full HD', null, 'FHD'],
  ['Ultra HD HDR', null, '4K'],
  ['4K HDR10 DV', null, '4K'],
  ['HDR10 x265', null, null],
  ['HDTV', null, null],
  ['WEB-DL\nShow.720p', null, 'HD'],
  ['Torrentio', { Height: 800, Width: 1920 }, 'FHD'],
  ['SD', null, 'SD'],
];

for (const [name, video, expected] of cases) {
  test('quality of ' + JSON.stringify(name), () => {
    assert.equal(sourceQuality(named(name, video)), expected);
  });
}

test('label quality only reads the first line', () => {
  assert.equal(labelQuality(named('Torrentio\nShow.1080p')), null);
  assert.equal(labelQuality(named('⚡ HD (720p)')), 'HD');
});
