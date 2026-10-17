import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labelQuality, sourceQuality, hasStreamInfo, filterPlayableSources } from '../../src/Jellio/Frontend/runtime/quality.js';

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

test('filterPlayableSources only drops a single stream when it has no quality/audio/video/size info at all', () => {
  // 1 stream with no info at all -> empty ("No streams available")
  assert.deepEqual(filterPlayableSources([{ Id: 'stub-1', Name: 'Some Movie Title', MediaStreams: [] }]), []);
  assert.deepEqual(
    filterPlayableSources([
      {
        Id: 'stub-re',
        Name: 'Resident Evil',
        Size: 128,
        Bitrate: 1000,
        MediaStreams: [{ Type: 'Video', VideoRange: 'Unknown', VideoRangeType: 'Unknown' }],
      },
    ]),
    [],
  );

  // 1 stream with quality/audio/video/size info -> kept
  const withQuality = [{ Id: 's1', Name: 'Movie_1080p_WEB-DL', MediaStreams: [] }];
  assert.deepEqual(filterPlayableSources(withQuality), withQuality);

  const withAudio = [{ Id: 's2', Name: 'Stream', MediaStreams: [{ Type: 'Audio', Codec: 'aac', Channels: 2 }] }];
  assert.deepEqual(filterPlayableSources(withAudio), withAudio);

  const withFlag = [{ Id: 's3', Name: '⚡ Instant 🇬🇧', MediaStreams: [] }];
  assert.deepEqual(filterPlayableSources(withFlag), withFlag);

  const withSize = [{ Id: 's4', Name: 'Some Movie Title', Size: 1500000000, MediaStreams: [] }];
  assert.deepEqual(filterPlayableSources(withSize), withSize);

  // Multiple streams -> never dropped even if individual names have no parsed tags
  const multiple = [
    { Id: 'm1', Name: 'Some Movie Title', MediaStreams: [] },
    { Id: 'm2', Name: 'Another Source', MediaStreams: [] },
  ];
  assert.deepEqual(filterPlayableSources(multiple), multiple);
  assert.equal(hasStreamInfo(multiple[0]), false);
  assert.equal(hasStreamInfo(withQuality[0]), true);
});

test('filterPlayableSources deduplicates multi-line sync clones and keeps newest row with probed streams', () => {
  const clones = [
    { Id: 'old-sync', Name: '🚀 FHD\nShow.S01E01.1080p\n💾 1 GB', MediaStreams: [] },
    {
      Id: 'probed-sync',
      Name: '🚀 FHD\nShow.S01E01.1080p\n💾 1 GB',
      MediaStreams: [{ Type: 'Video', Codec: 'h264' }],
      Size: 1073741824,
    },
    { Id: 'newest-sync', Name: '🚀 FHD\nShow.S01E01.1080p\n💾 1 GB', MediaStreams: [] },
    { Id: 'other-release', Name: '🚀 4K\nShow.S01E01.2160p\n💾 4 GB', MediaStreams: [] },
  ];
  const deduped = filterPlayableSources(clones);
  assert.equal(deduped.length, 2);
  assert.equal(deduped[0].Id, 'newest-sync');
  assert.equal(deduped[0].MediaStreams.length, 1);
  assert.equal(deduped[0].Size, 1073741824);
  assert.equal(deduped[1].Id, 'other-release');
});

