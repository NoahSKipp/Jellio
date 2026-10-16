// A stream's quality tier for the stream picker's badges and filter chips.
// Pure, so tests/frontend/quality.test.mjs can run it.

// Quality buckets, best first. A source counts towards one bucket only,
// so 'FHD' plus a language narrows to the 1080p streams in that language.
export const QUALITY_ORDER = ['4K', 'QHD', 'FHD', 'HD', 'SD'];
const QUALITY_NAME_PATTERNS = [
  // Names say "720p" or just "HD", "Full HD", "Ultra HD"; HDR and HDTV
  // aren't resolutions.
  ['4K', /(^|[^a-z0-9])(2160p|4k|uhd|ultra[ .-]?hd)([^a-z0-9+]|$)/i],
  ['QHD', /(^|[^a-z0-9])(1440p|qhd|2k)([^a-z0-9+]|$)/i],
  ['FHD', /(^|[^a-z0-9])(1080[pi]|fhd|full[ .-]?hd)([^a-z0-9+]|$)/i],
  ['HD', /(^|[^a-z0-9])(720p|hd)([^a-z0-9+]|$)/i],
  ['SD', /(^|[^a-z0-9])(576p|540p|480p|360p|240p|sd|dvdrip)([^a-z0-9+]|$)/i],
];

function matchName(text) {
  for (let i = 0; i < QUALITY_NAME_PATTERNS.length; i++) {
    if (QUALITY_NAME_PATTERNS[i][1].test(text)) return QUALITY_NAME_PATTERNS[i][0];
  }
  return null;
}

// The tier the addon's own label (the name's first line, e.g. "HD (720p)")
// states, or null.
export function labelQuality(source) {
  return matchName(String((source && source.Name) || '').split('\n')[0]);
}

// The addon's label first: it's parsed from the actual file, while the
// probe details Gelato attaches can belong to another version of the
// title. Then probed dimensions (width matters for cropped widescreen, a
// 3840x1600 file is still 4K), then anything in the release name.
export function sourceQuality(source) {
  const labelled = labelQuality(source);
  if (labelled) return labelled;
  const video = (source.MediaStreams || []).filter(function (stream) {
    return stream.Type === 'Video';
  })[0];
  if (video && (video.Height || video.Width)) {
    const height = video.Height || 0;
    const width = video.Width || 0;
    if (height >= 2000 || width >= 3200) return '4K';
    if (height >= 1300 || width >= 2400) return 'QHD';
    if (height >= 900 || width >= 1800) return 'FHD';
    if (height >= 650 || width >= 1200) return 'HD';
    return 'SD';
  }
  return matchName(String(source.Name || ''));
}

const STREAM_INFO_NAME_PATTERN =
  /(^|[^a-z0-9])(2160p|1440p|1080[pi]|720p|576p|540p|480p|360p|240p|4k|uhd|qhd|2k|fhd|hd|sd|dvdrip|web-?dl|web-?rip|bluray|blu-ray|bdrip|brrip|remux|hdtv|hevc|[xh]\.?265|[xh]\.?264|avc|av1|vp9|hdr10?\+?|dv|dovi|dolby|hlg|10\s?bit|aac|e?-?ac-?3|ddp|dd\+|dts(-?hd|-?x)?|truehd|atmos|flac|opus|mp3|l?pcm|[257]\.[01]|stereo|mono|multi|dual([-.\s]?audio)?|\d+(\.\d+)?\s*(gb|mb|gib|mib|mbps|kbps))([^a-z0-9]|$)/i;

function hasFlagEmoji(text) {
  const chars = Array.from(text || '');
  for (let i = 0; i < chars.length - 1; i++) {
    const a = chars[i].codePointAt(0);
    const b = chars[i + 1].codePointAt(0);
    if (a >= 0x1f1e6 && a <= 0x1f1ff && b >= 0x1f1e6 && b <= 0x1f1ff) {
      return true;
    }
  }
  return false;
}

// True if a MediaSource carries any discernible quality, video, audio, or
// size/bitrate info (from probed MediaStreams, file size/bitrate, or release
// labels/flags in its Name). A bare unprobed placeholder stub has none.
export function hasStreamInfo(source) {
  if (!source) return false;
  if (sourceQuality(source)) return true;
  if ((source.Size || 0) > 0 || (source.Bitrate || 0) > 0) return true;

  const streams = source.MediaStreams || [];
  const hasProbedStream = streams.some(function (s) {
    if (!s) return false;
    if (s.Type === 'Video') {
      return (s.Width || 0) > 0 || (s.Height || 0) > 0 || !!s.Codec || (s.BitRate || 0) > 0 || !!s.VideoRange || !!s.VideoRangeType;
    }
    if (s.Type === 'Audio') {
      return !!s.Codec || (s.Channels || 0) > 0 || !!s.Language || (s.BitRate || 0) > 0;
    }
    return s.Type === 'Subtitle';
  });
  if (hasProbedStream) return true;

  const name = String(source.Name || '');
  if (STREAM_INFO_NAME_PATTERN.test(name)) return true;
  if (hasFlagEmoji(name)) return true;

  return false;
}

// Only treat a MediaSources list as empty ("No streams available") when it
// contains a single entry and that entry carries no quality, audio, video, or
// size info at all.
export function filterPlayableSources(sources) {
  const list = Array.isArray(sources) ? sources.filter(Boolean) : [];
  if (list.length === 1 && !hasStreamInfo(list[0])) {
    return [];
  }
  return list;
}
