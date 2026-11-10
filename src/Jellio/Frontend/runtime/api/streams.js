import { avoidingVideoTranscodes, browserCaps } from '../transcodePolicy.js';
import { copyableVideoCodecs } from '../transcodeClassifier.js';
import { getAccessToken, getDeviceId, getServerAddress } from '../auth.js';
import { languageName } from '../languages.js';

export const TICKS_PER_SECOND = 10000000;

const MATROSKA_CONTAINERS = new Set(['mkv', 'matroska']);
let matroskaContainerSupport;

function supportsMatroskaContainer() {
  if (matroskaContainerSupport !== undefined) return matroskaContainerSupport;
  if (typeof document === 'undefined') {
    matroskaContainerSupport = false;
    return matroskaContainerSupport;
  }
  const probe = document.createElement('video');
  if (typeof probe.canPlayType !== 'function') {
    matroskaContainerSupport = false;
    return matroskaContainerSupport;
  }
  const support = probe.canPlayType('video/x-matroska; codecs="avc1.640028, mp4a.40.2"');
  matroskaContainerSupport = support === 'probably' || support === 'maybe';
  return matroskaContainerSupport;
}

function normalizeStreamContainer(rawContainer) {
  const container = String(rawContainer || '').toLowerCase();
  if (container === 'mov') return 'mp4';
  return MATROSKA_CONTAINERS.has(container) ? 'mkv' : container;
}

export function supportsNativeHls() {
  if (typeof document === 'undefined') return false;
  const probe = document.createElement('video');
  if (typeof probe.canPlayType !== 'function') return false;
  const support = probe.canPlayType('application/vnd.apple.mpegurl');
  return support === 'probably' || support === 'maybe';
}

const LEGACY_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);
const LEGACY_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

const CONTAINER_MIME = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/mp4',
  webm: 'video/webm',
};

const H264_PROFILES = {
  baseline: '42',
  'constrained baseline': '42',
  extended: '58',
  main: '4d',
  high: '64',
  'high 10': '6e',
  'high 4:2:2': '7a',
  'high 4:4:4 predictive': 'f4',
};

function hex2(value) {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
}

// The codec string a canPlayType() query takes, or null for a codec no
// engine here plays.
function videoCodecString(stream) {
  const codec = String(stream.Codec || '').toLowerCase();
  const depth = Number(stream.BitDepth) || 8;
  const level = Number(stream.Level) || 0;
  const profile = String(stream.Profile || '').toLowerCase();
  if (codec === 'h264') return 'avc1.' + (H264_PROFILES[profile] || '64') + '00' + hex2(level || 40);
  if (codec === 'hevc') return 'hvc1.' + (depth > 8 || profile === 'main 10' ? '2.4' : '1.6') + '.L' + (level || 153) + '.B0';
  if (codec === 'vp9') return depth > 8 ? 'vp09.02.10.10' : 'vp09.00.10.08';
  if (codec === 'av1') return 'av01.0.13M.' + (depth > 8 ? '10' : '08');
  if (codec === 'vp8') return 'vp8';
  return null;
}

function audioCodecString(stream) {
  const codec = String(stream.Codec || '').toLowerCase();
  if (codec === 'aac') return /he-aac/i.test(String(stream.Profile || '')) ? 'mp4a.40.5' : 'mp4a.40.2';
  return { mp3: 'mp3', opus: 'opus', vorbis: 'vorbis', flac: 'flac', ac3: 'ac-3', eac3: 'ec-3', alac: 'alac' }[codec] || null;
}

const playTypeAnswers = new Map();

function enginePlays(mime, codecs) {
  const type = mime + '; codecs="' + codecs.join(', ') + '"';
  if (!playTypeAnswers.has(type)) {
    const probe = document.createElement('video');
    playTypeAnswers.set(type, probe.canPlayType(type) !== '');
  }
  return playTypeAnswers.get(type);
}

export function canBrowserDirectPlay(mediaSource) {
  if (!mediaSource) return false;
  if (mediaSource.SupportsDirectPlay === false && mediaSource.SupportsDirectStream === false) {
    return false;
  }
  const container = normalizeStreamContainer(mediaSource.Container);
  const streams = mediaSource.MediaStreams || [];
  const video = streams.filter(function (stream) {
    return stream.Type === 'Video';
  })[0];
  // The track that plays by default, not just the first one listed.
  const audio =
    streams.filter(function (stream) {
      return stream.Type === 'Audio' && stream.Index === mediaSource.DefaultAudioStreamIndex;
    })[0] ||
    streams.filter(function (stream) {
      return stream.Type === 'Audio';
    })[0];

  const canProbe = typeof document !== 'undefined' && typeof document.createElement('video').canPlayType === 'function';
  if (!canProbe) {
    const legacyMatroska = MATROSKA_CONTAINERS.has(container) && supportsMatroskaContainer();
    if (!['mp4', 'webm', 'm4v'].includes(container) && !legacyMatroska) return false;
    if (video && !LEGACY_VIDEO_CODECS.has(String(video.Codec || '').toLowerCase())) return false;
    if (audio && !LEGACY_AUDIO_CODECS.has(String(audio.Codec || '').toLowerCase())) return false;
    return true;
  }

  const mime = CONTAINER_MIME[container];
  if (!mime) return false;
  // Dolby Vision profile 5 has no HDR10 layer to fall back to, so it
  // shows with wrong colours anywhere but a player built for it.
  if (video && video.VideoRangeType === 'DOVI') return false;
  const codecs = [];
  if (video) {
    const codec = videoCodecString(video);
    if (!codec) return false;
    codecs.push(codec);
  }
  if (audio) {
    const codec = audioCodecString(audio);
    if (!codec) return false;
    codecs.push(codec);
  }
  if (!codecs.length) return false;
  // Each stream has to be playable on its own as well as together, so a
  // video the engine plays isn't held back by an audio track it can't.
  return enginePlays(mime, codecs) && codecs.every((codec) => enginePlays(mime, [codec]));
}

const FALLBACK_VIDEO_BITRATE = 20000000;

function estimateVideoBitrate(mediaSource) {
  const streams = (mediaSource && mediaSource.MediaStreams) || [];
  const video = streams.filter(function (stream) {
    return stream.Type === 'Video';
  })[0];
  if (video && video.BitRate) return video.BitRate;
  if (mediaSource && mediaSource.Bitrate) return mediaSource.Bitrate;
  return FALLBACK_VIDEO_BITRATE;
}

export function getAudioStreams(mediaSource) {
  return (mediaSource.MediaStreams || []).filter(function (stream) {
    return stream.Type === 'Audio';
  });
}

export function matchAudioStreamIndex(mediaSource, languagePreference) {
  if (!languagePreference) return null;
  const wanted = languageName(languagePreference);
  const streams = getAudioStreams(mediaSource);
  const match = streams.find(function (stream) {
    return stream.Language && languageName(stream.Language) === wanted;
  });
  return match ? match.Index : null;
}

export function matchSubtitleStream(mediaSource, languagePreference) {
  if (!languagePreference) return null;
  const wanted = languageName(languagePreference);
  const streams = getSubtitleStreams(mediaSource).filter(function (stream) {
    return stream.Language && languageName(stream.Language) === wanted;
  });
  if (!streams.length) return null;
  return streams.find(function (stream) {
    return stream.IsTextSubtitleStream;
  }) || null;
}

export function buildStreamUrl(itemId, mediaSource, startTimeTicks, options) {
  const opts = options || {};
  const token = getAccessToken();
  const mediaSourceId = (mediaSource && mediaSource.Id) || itemId;
  const forceTranscode =
    !!opts.forceTranscode ||
    opts.burnInSubtitleStreamIndex != null ||
    (opts.audioStreamIndex != null && opts.audioStreamIndex !== mediaSource.DefaultAudioStreamIndex);
  const directPlay = !forceTranscode && canBrowserDirectPlay(mediaSource);
  const useHls = !directPlay && supportsNativeHls();
  const container = directPlay ? normalizeStreamContainer(mediaSource && mediaSource.Container) || 'mp4' : 'mp4';

  const params = new URLSearchParams({
    MediaSourceId: mediaSourceId,
    DeviceId: getDeviceId(),
    ApiKey: token || '',
  });
  if (!useHls) {
    params.set('StartTimeTicks', String(startTimeTicks || 0));
  }
  if (opts.playSessionId) {
    params.set('PlaySessionId', opts.playSessionId);
  }
  if (directPlay) {
    params.set('Static', 'true');
  } else if (avoidingVideoTranscodes()) {
    const codecs = copyableVideoCodecs(browserCaps());
    params.set('VideoCodec', codecs.join(','));
    params.set('AudioCodec', 'aac');
    params.set('AudioBitRate', '192000');
    params.set('AllowVideoStreamCopy', 'true');
    params.set('AllowAudioStreamCopy', 'true');
    codecs.filter((codec) => codec !== 'h264').forEach(function (codec) {
      params.set(codec + '-videorangetype', 'SDR,HDR10,HDR10Plus,HLG,DOVIWithHDR10,DOVIWithHLG,DOVIWithSDR,DOVIWithHDR10Plus');
    });
    if (useHls) params.set('SegmentContainer', 'mp4');
  } else {
    params.set('VideoCodec', 'h264');
    params.set('AudioCodec', 'aac');
    params.set('VideoBitRate', String(estimateVideoBitrate(mediaSource)));
    params.set('AudioBitRate', '192000');
  }
  if (opts.audioStreamIndex != null) {
    params.set('AudioStreamIndex', String(opts.audioStreamIndex));
  }
  if (opts.burnInSubtitleStreamIndex != null) {
    params.set('SubtitleStreamIndex', String(opts.burnInSubtitleStreamIndex));
    params.set('SubtitleMethod', 'Encode');
  }
  const path = useHls ? '/Videos/' + itemId + '/master.m3u8' : '/Videos/' + itemId + '/stream.' + container;
  return getServerAddress() + path + '?' + params.toString();
}

export function buildCastStreamUrl(itemId, mediaSource, startTimeTicks, options) {
  const opts = options || {};
  const token = getAccessToken();
  const mediaSourceId = (mediaSource && mediaSource.Id) || itemId;

  const params = new URLSearchParams({
    MediaSourceId: mediaSourceId,
    DeviceId: getDeviceId(),
    ApiKey: token || '',
    Static: 'false',
    VideoCodec: 'h264',
    AudioCodec: 'aac',
    AudioBitRate: '192000',
    AllowVideoStreamCopy: 'true',
    AllowAudioStreamCopy: 'true',
    StartTimeTicks: String(startTimeTicks || 0),
  });

  if (opts.audioStreamIndex != null) {
    params.set('AudioStreamIndex', String(opts.audioStreamIndex));
  }
  if (opts.subtitleStreamIndex != null) {
    params.set('SubtitleStreamIndex', String(opts.subtitleStreamIndex));
    params.set('SubtitleMethod', 'Encode');
  }

  return getServerAddress() + '/Videos/' + itemId + '/stream.mp4?' + params.toString();
}

export function getSubtitleStreams(mediaSource) {
  return (mediaSource.MediaStreams || []).filter(function (stream) {
    return stream.Type === 'Subtitle';
  });
}

export function buildSubtitleUrl(itemId, mediaSourceId, stream) {
  const token = getAccessToken();
  return (
    getServerAddress() +
    '/Videos/' + itemId + '/' + mediaSourceId + '/Subtitles/' + stream.Index + '/Stream.vtt' +
    (token ? '?ApiKey=' + encodeURIComponent(token) : '')
  );
}
