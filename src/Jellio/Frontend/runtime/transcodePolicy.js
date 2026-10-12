// The server's "Video transcode policy" (plugin settings) and what this
// browser can decode, for runtime/transcodeClassifier.js. Allow is the old
// behaviour; Avoid and Block keep the server from re-encoding video.
import { classifyVideo, playMethodFor } from './transcodeClassifier.js';

let policy = 'Allow';

export function setVideoTranscodePolicy(value) {
  policy = value === 'Avoid' || value === 'Block' ? value : 'Allow';
}

export function getVideoTranscodePolicy() {
  return policy;
}

// Avoid or Block: anything other than the home default.
export function avoidingVideoTranscodes() {
  return policy !== 'Allow';
}

const answers = new Map();

function canPlayVideo(codecString) {
  if (typeof document === 'undefined') return false;
  if (!answers.has(codecString)) {
    const probe = document.createElement('video');
    const type = 'video/mp4; codecs="' + codecString + '"';
    let supported = typeof probe.canPlayType === 'function' && probe.canPlayType(type) !== '';
    if (!supported && typeof window !== 'undefined' && window.MediaSource && typeof window.MediaSource.isTypeSupported === 'function') {
      supported = window.MediaSource.isTypeSupported(type);
    }
    answers.set(codecString, supported);
  }
  return answers.get(codecString);
}

export function browserCaps() {
  const hdrDisplay = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(dynamic-range: high)').matches;
  return { canPlayVideo: canPlayVideo, hdrDisplay: hdrDisplay };
}

// classifyVideo plus the play method, against this browser.
export function classifySource(mediaSource, directPlayable, options) {
  const classification = classifyVideo(mediaSource, browserCaps(), options);
  return Object.assign({}, classification, { playMethod: playMethodFor(classification, directPlayable) });
}

const REASON_TEXT = {
  codec: 'this browser can’t decode the video',
  'hdr-on-sdr': 'HDR on a non-HDR screen',
  'dolby-vision-5': 'Dolby Vision without a fallback',
  interlaced: 'interlaced video',
  'burn-in': 'an image subtitle',
};

export function describeTranscodeReason(reason) {
  return REASON_TEXT[reason] || reason;
}

const SHORT_REASON = {
  codec: 'a video format this device can’t play',
  'hdr-on-sdr': 'HDR on a non-HDR screen',
  'dolby-vision-5': 'Dolby Vision only',
  interlaced: 'interlaced video',
  'burn-in': 'image subtitles',
};

// What a viewer cares about: will this play smoothly here? tone is good,
// warn (Avoid) or block (Block). Guesses from a stream's name are worded
// less certainly than probed details.
export function playbackOutlook(classification, policy) {
  const current = policy || getVideoTranscodePolicy();
  const guessed = !!classification.guessed;
  const note = guessed ? ' Going by the stream’s name; it hasn’t been checked yet.' : '';
  if (!classification.needsVideoTranscode) {
    return {
      tone: 'good',
      text: guessed ? 'Likely plays smoothly' : 'Plays smoothly',
      title:
        (classification.playMethod === 'DirectPlay'
          ? 'Plays the file as is.'
          : 'The server only repackages it; the picture isn’t converted.') + note,
    };
  }
  const reason = SHORT_REASON[classification.reasons[0]] || 'needs converting';
  const why = 'The server would have to convert the video (' + classification.reasons.map(describeTranscodeReason).join(', ') + ')';
  if (current === 'Block') {
    return {
      tone: 'block',
      text: (guessed ? 'Probably won’t play: ' : 'Won’t play: ') + reason,
      title: why + ', which is turned off on this server.' + note,
    };
  }
  return {
    tone: 'warn',
    text: (guessed ? 'May stutter: ' : 'Likely to stutter: ') + reason,
    title: why + ', which is slow on this server.' + note,
  };
}
