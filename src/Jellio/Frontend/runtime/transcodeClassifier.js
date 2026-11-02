
const H264_PROFILE_IDS = {
  baseline: '42',
  'constrained baseline': '42',
  extended: '58',
  main: '4d',
  high: '64',
  'high 10': '6e',
  'high 4:2:2': '7a',
  'high 4:4:4 predictive': 'f4',
};

const HDR_RANGES = new Set(['HDR10', 'HDR10Plus', 'HLG', 'DOVI', 'DOVIWithHDR10', 'DOVIWithHLG', 'DOVIWithHDR10Plus', 'DOVIWithEL', 'DOVIWithELHDR10Plus', 'DOVIInvalid']);

function hex2(value) {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
}

function videoStreamOf(mediaSource) {
  const streams = (mediaSource && mediaSource.MediaStreams) || [];
  return streams.filter((stream) => stream.Type === 'Video')[0] || null;
}

export function videoHintFromName(name) {
  const text = ' ' + String(name || '').replace(/[|·•,()[\]{}/_\n\r\t-]+/g, ' ') + ' ';
  let codec = null;
  if (/\s(hevc|[xh]\.?265)\s/i.test(text)) codec = 'hevc';
  else if (/\sav1\s/i.test(text)) codec = 'av1';
  else if (/\svp9\s/i.test(text)) codec = 'vp9';
  else if (/\s(avc|[xh]\.?264)\s/i.test(text)) codec = 'h264';
  const dv = /\s(dv|dovi|dolby\s?vision)\s/i.test(text);
  let range = null;
  if (/hdr10(\+|plus)/i.test(text)) range = 'HDR10Plus';
  else if (/\shdr(10)?\s/i.test(text)) range = 'HDR10';
  else if (/\shlg\s/i.test(text)) range = 'HLG';
  if (dv) range = range === 'HDR10Plus' ? 'DOVIWithHDR10Plus' : range === 'HDR10' ? 'DOVIWithHDR10' : range === 'HLG' ? 'DOVIWithHLG' : 'DOVI';
  if (!codec && !range) return null;
  const tenBit = range !== null || /\s10\s?bit\s/i.test(text);
  return { Type: 'Video', Codec: codec, BitDepth: tenBit ? 10 : 8, VideoRangeType: range || 'SDR' };
}

export function videoInfoOf(mediaSource) {
  const real = videoStreamOf(mediaSource);
  if (real) return { stream: real, guessed: false };
  const hinted = videoHintFromName(mediaSource && mediaSource.Name);
  return hinted ? { stream: hinted, guessed: true } : null;
}

// The codecs string a browser is asked about for this video stream.
export function videoCodecString(stream) {
  const codec = String(stream.Codec || '').toLowerCase();
  const depth = Number(stream.BitDepth) || 8;
  const level = Number(stream.Level) || 0;
  const profile = String(stream.Profile || '').toLowerCase();
  if (codec === 'h264') {
    // 10-bit H.264 is "High 10" whatever the profile field says.
    let id = H264_PROFILE_IDS[profile] || '64';
    if (depth > 8 && id === '64') id = '6e';
    return 'avc1.' + id + '00' + hex2(level || 40);
  }
  if (codec === 'hevc') return 'hvc1.' + (depth > 8 || profile === 'main 10' ? '2.4' : '1.6') + '.L' + (level || 153) + '.B0';
  if (codec === 'vp9') return depth > 8 ? 'vp09.02.10.10' : 'vp09.00.10.08';
  if (codec === 'av1') return 'av01.0.13M.' + (depth > 8 ? '10' : '08');
  if (codec === 'vp8') return 'vp8';
  return null;
}

function isDolbyVisionOnly(stream) {
  // Profile 5 has no HDR10 or SDR base layer to fall back to.
  const range = String(stream.VideoRangeType || '');
  if (range === 'DOVI' || range === 'DOVIInvalid') return true;
  return Number(stream.DvProfile) === 5;
}

export function classifyVideo(mediaSource, caps, options) {
  const opts = options || {};
  const reasons = [];
  const info = videoInfoOf(mediaSource);
  if (opts.burnInSubtitle) reasons.push('burn-in');
  if (!info) return { needsVideoTranscode: reasons.length > 0, reasons, guessed: false };
  const video = info.stream;

  // A name without a codec says nothing about decoding it.
  if (!(info.guessed && !video.Codec)) {
    const codecString = videoCodecString(video);
    if (!codecString || !caps.canPlayVideo(codecString)) reasons.push('codec');
  }

  if (isDolbyVisionOnly(video)) {
    reasons.push('dolby-vision-5');
  } else if (HDR_RANGES.has(String(video.VideoRangeType || '')) && !caps.hdrDisplay) {
    reasons.push('hdr-on-sdr');
  }

  if (video.IsInterlaced) reasons.push('interlaced');

  return { needsVideoTranscode: reasons.length > 0, reasons, guessed: info.guessed };
}

// "DirectPlay" (the file as is), "Remux" (video copied, container or audio
// converted) or "Transcode" (video re-encoded).
export function playMethodFor(classification, directPlayable) {
  if (classification.needsVideoTranscode) return 'Transcode';
  return directPlayable ? 'DirectPlay' : 'Remux';
}

export function copyableVideoCodecs(caps) {
  const list = ['h264'];
  if (caps.canPlayVideo('hvc1.1.6.L153.B0') || caps.canPlayVideo('hvc1.2.4.L153.B0')) list.push('hevc');
  if (caps.canPlayVideo('av01.0.13M.08')) list.push('av1');
  if (caps.canPlayVideo('vp09.00.10.08')) list.push('vp9');
  return list;
}
