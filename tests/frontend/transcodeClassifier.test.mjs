// node --test tests/frontend
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyVideo, copyableVideoCodecs, playMethodFor, videoCodecString, videoHintFromName } from '../../src/Jellio/Frontend/runtime/transcodeClassifier.js';

// A browser that decodes H.264 8-bit, HEVC (8 and 10-bit) and VP9, but not
// AV1 or 10-bit H.264: roughly Safari or Chrome with hardware HEVC.
const hevcBrowser = {
  canPlayVideo: (codec) => /^avc1\.(42|4d|64)/.test(codec) || codec.startsWith('hvc1.') || codec.startsWith('vp09.'),
  hdrDisplay: false,
};
// Chrome on hardware without HEVC: H.264 8-bit, VP9 and AV1.
const plainBrowser = {
  canPlayVideo: (codec) => /^avc1\.(42|4d|64)/.test(codec) || codec.startsWith('vp09.') || codec.startsWith('av01.'),
  hdrDisplay: false,
};

function source(video, extra) {
  return { MediaStreams: [Object.assign({ Type: 'Video' }, video), { Type: 'Audio', Codec: 'eac3' }], ...extra };
}

const cases = [
  // [label, video stream, caps, hdr display, expected needs, expected reasons]
  ['h264 8-bit SDR', { Codec: 'h264', Profile: 'High', BitDepth: 8, VideoRangeType: 'SDR' }, plainBrowser, false, false, []],
  ['h264 10-bit', { Codec: 'h264', Profile: 'High 10', BitDepth: 10, VideoRangeType: 'SDR' }, plainBrowser, false, true, ['codec']],
  ['h264 10-bit, profile says High', { Codec: 'h264', Profile: 'High', BitDepth: 10 }, plainBrowser, false, true, ['codec']],
  ['hevc on a browser without hevc', { Codec: 'hevc', Profile: 'Main', BitDepth: 8, VideoRangeType: 'SDR' }, plainBrowser, false, true, ['codec']],
  ['hevc on a browser with hevc', { Codec: 'hevc', Profile: 'Main', BitDepth: 8, VideoRangeType: 'SDR' }, hevcBrowser, false, false, []],
  ['hevc 10-bit HDR10 on SDR display', { Codec: 'hevc', Profile: 'Main 10', BitDepth: 10, VideoRangeType: 'HDR10' }, hevcBrowser, false, true, ['hdr-on-sdr']],
  ['hevc 10-bit HDR10 on HDR display', { Codec: 'hevc', Profile: 'Main 10', BitDepth: 10, VideoRangeType: 'HDR10' }, hevcBrowser, true, false, []],
  ['HLG on SDR display', { Codec: 'hevc', Profile: 'Main 10', BitDepth: 10, VideoRangeType: 'HLG' }, hevcBrowser, false, true, ['hdr-on-sdr']],
  ['DV with HDR10 base on HDR display', { Codec: 'hevc', Profile: 'Main 10', BitDepth: 10, VideoRangeType: 'DOVIWithHDR10' }, hevcBrowser, true, false, []],
  ['DV with HDR10 base on SDR display', { Codec: 'hevc', Profile: 'Main 10', BitDepth: 10, VideoRangeType: 'DOVIWithHDR10' }, hevcBrowser, false, true, ['hdr-on-sdr']],
  ['DV profile 5 on HDR display', { Codec: 'hevc', Profile: 'Main 10', BitDepth: 10, VideoRangeType: 'DOVI' }, hevcBrowser, true, true, ['dolby-vision-5']],
  ['DV profile 5 by DvProfile', { Codec: 'hevc', BitDepth: 10, VideoRangeType: 'DOVIWithHDR10', DvProfile: 5 }, hevcBrowser, true, true, ['dolby-vision-5']],
  ['av1 on a browser with av1', { Codec: 'av1', BitDepth: 10, VideoRangeType: 'SDR' }, plainBrowser, false, false, []],
  ['av1 on a browser without av1', { Codec: 'av1', BitDepth: 8, VideoRangeType: 'SDR' }, hevcBrowser, false, true, ['codec']],
  ['interlaced h264', { Codec: 'h264', Profile: 'High', BitDepth: 8, IsInterlaced: true }, plainBrowser, false, true, ['interlaced']],
  ['mpeg2', { Codec: 'mpeg2video', BitDepth: 8 }, plainBrowser, false, true, ['codec']],
  ['hevc HDR10 without hevc on SDR', { Codec: 'hevc', Profile: 'Main 10', BitDepth: 10, VideoRangeType: 'HDR10' }, plainBrowser, false, true, ['codec', 'hdr-on-sdr']],
];

for (const [label, video, caps, hdrDisplay, needs, reasons] of cases) {
  test(label, () => {
    const result = classifyVideo(source(video), { canPlayVideo: caps.canPlayVideo, hdrDisplay });
    assert.equal(result.needsVideoTranscode, needs);
    assert.deepEqual(result.reasons, reasons);
  });
}

test('image subtitle burn-in needs a video transcode', () => {
  const result = classifyVideo(source({ Codec: 'h264', Profile: 'High', BitDepth: 8 }), plainBrowser, { burnInSubtitle: true });
  assert.equal(result.needsVideoTranscode, true);
  assert.deepEqual(result.reasons, ['burn-in']);
});

test('audio-only source needs nothing', () => {
  const result = classifyVideo({ MediaStreams: [{ Type: 'Audio', Codec: 'aac' }] }, plainBrowser);
  assert.equal(result.needsVideoTranscode, false);
});

test('play method', () => {
  assert.equal(playMethodFor({ needsVideoTranscode: false }, true), 'DirectPlay');
  assert.equal(playMethodFor({ needsVideoTranscode: false }, false), 'Remux');
  assert.equal(playMethodFor({ needsVideoTranscode: true }, true), 'Transcode');
});

test('copyable codecs follow what the browser plays, h264 first', () => {
  assert.deepEqual(copyableVideoCodecs(hevcBrowser), ['h264', 'hevc', 'vp9']);
  assert.deepEqual(copyableVideoCodecs(plainBrowser), ['h264', 'av1', 'vp9']);
});

test('codec strings', () => {
  assert.equal(videoCodecString({ Codec: 'h264', Profile: 'High', Level: 41 }), 'avc1.640029');
  assert.equal(videoCodecString({ Codec: 'h264', Profile: 'High 10', BitDepth: 10, Level: 41 }), 'avc1.6e0029');
  assert.equal(videoCodecString({ Codec: 'hevc', Profile: 'Main 10', BitDepth: 10, Level: 150 }), 'hvc1.2.4.L150.B0');
});

// Unprobed Gelato sources: the AIOStreams name stands in for MediaStreams.
const nameCases = [
  // [name, expected hint (null: nothing to go on)]
  ['⚡ RD 2160p\nHEVC | DV | HDR10', { Codec: 'hevc', BitDepth: 10, VideoRangeType: 'DOVIWithHDR10' }],
  ['4K WEB-DL DV x265', { Codec: 'hevc', BitDepth: 10, VideoRangeType: 'DOVI' }],
  ['1080p BluRay x264', { Codec: 'h264', BitDepth: 8, VideoRangeType: 'SDR' }],
  ['2160p HDR10+ H.265', { Codec: 'hevc', BitDepth: 10, VideoRangeType: 'HDR10Plus' }],
  ['1080p AV1 10bit', { Codec: 'av1', BitDepth: 10, VideoRangeType: 'SDR' }],
  ['Dolby Vision HDR', { Codec: null, BitDepth: 10, VideoRangeType: 'DOVIWithHDR10' }],
  ['Torrentio 1080p', null],
  ['', null],
];

for (const [name, expected] of nameCases) {
  test('name hint: ' + JSON.stringify(name), () => {
    const hint = videoHintFromName(name);
    if (expected === null) return assert.equal(hint, null);
    assert.deepEqual(hint, Object.assign({ Type: 'Video' }, expected));
  });
}

test('unprobed source is classified from its name', () => {
  const dv5 = classifyVideo({ Name: 'WEB-DL DV HEVC', MediaStreams: [] }, hevcBrowser);
  assert.deepEqual([dv5.needsVideoTranscode, dv5.reasons, dv5.guessed], [true, ['dolby-vision-5'], true]);
  const hevc = classifyVideo({ Name: '1080p HEVC', MediaStreams: [] }, plainBrowser);
  assert.deepEqual([hevc.needsVideoTranscode, hevc.reasons, hevc.guessed], [true, ['codec'], true]);
  const h264 = classifyVideo({ Name: '1080p x264' }, plainBrowser);
  assert.deepEqual([h264.needsVideoTranscode, h264.guessed], [false, true]);
  const hdrNoCodec = classifyVideo({ Name: 'HDR' }, plainBrowser);
  assert.deepEqual(hdrNoCodec.reasons, ['hdr-on-sdr']);
});

test('probed streams win over the name', () => {
  const result = classifyVideo({ Name: 'HEVC DV', MediaStreams: [{ Type: 'Video', Codec: 'h264', Profile: 'High', BitDepth: 8 }] }, plainBrowser);
  assert.deepEqual([result.needsVideoTranscode, result.guessed], [false, false]);
});
