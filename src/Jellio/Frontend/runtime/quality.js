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
