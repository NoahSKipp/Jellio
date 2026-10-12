// node --test tests/frontend
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyVideo, copyableVideoCodecs, playMethodFor, videoCodecString } from '../../src/Jellio/Frontend/runtime/transcodeClassifier.js';

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
