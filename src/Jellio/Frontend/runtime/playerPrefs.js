const VOLUME_KEY = 'jellioPlayerVolume';

export function loadVolumePreference() {
  try {
    const raw = window.localStorage.getItem(VOLUME_KEY);
    if (!raw) return { volume: 1, muted: false };
    const parsed = JSON.parse(raw);
    const volume = typeof parsed.volume === 'number' && parsed.volume >= 0 && parsed.volume <= 1 ? parsed.volume : 1;
    return { volume: volume, muted: !!parsed.muted };
  } catch (err) {
    return { volume: 1, muted: false };
  }
}

export function saveVolumePreference(volume, muted) {
  try {
    window.localStorage.setItem(VOLUME_KEY, JSON.stringify({ volume: volume, muted: muted }));
  } catch (err) {
    // A private/full storage quota is not worth surfacing here, the
    // chosen volume still applies for the rest of this playback session.
  }
}

const SUBTITLE_STYLE_KEY = 'jellioSubtitleStyle';

export const SUBTITLE_SIZES = [
  { value: 'small', label: 'Small', rem: 1 },
  { value: 'medium', label: 'Medium', rem: 1.3 },
  { value: 'large', label: 'Large', rem: 1.7 },
  { value: 'xlarge', label: 'Extra large', rem: 2.1 },
];

export const SUBTITLE_BACKGROUNDS = [
  { value: 'none', label: 'None', color: 'transparent' },
  { value: 'semi', label: 'Semi', color: 'rgb(0 0 0 / 0.5)' },
  { value: 'solid', label: 'Solid', color: 'rgb(0 0 0 / 0.9)' },
];

const DEFAULT_SUBTITLE_STYLE = { size: 'medium', background: 'semi' };

export function loadSubtitleStyle() {
  try {
    const raw = window.localStorage.getItem(SUBTITLE_STYLE_KEY);
    if (!raw) return Object.assign({}, DEFAULT_SUBTITLE_STYLE);
    const parsed = JSON.parse(raw);
    return {
      size: SUBTITLE_SIZES.some((s) => s.value === parsed.size) ? parsed.size : DEFAULT_SUBTITLE_STYLE.size,
      background: SUBTITLE_BACKGROUNDS.some((b) => b.value === parsed.background)
        ? parsed.background
        : DEFAULT_SUBTITLE_STYLE.background,
    };
  } catch (err) {
    return Object.assign({}, DEFAULT_SUBTITLE_STYLE);
  }
}

export function saveSubtitleStyle(style) {
  try {
    window.localStorage.setItem(SUBTITLE_STYLE_KEY, JSON.stringify(style));
  } catch (err) {
    // A private/full storage quota is not worth surfacing here, the
    // style still applies for the rest of this playback session.
  }
  try {
    import('./api.js').then(function (api) {
      if (api && typeof api.postJson === 'function') {
        api.postJson('/Jellio/profile/subtitles', style).catch(function () {});
      }
    }).catch(function () {});
  } catch (err) {}
}

export function applyServerSubtitleStyle(serverStyle) {
  if (!serverStyle) return;
  const current = loadSubtitleStyle();
  const merged = {
    size: SUBTITLE_SIZES.some((s) => s.value === serverStyle.size) ? serverStyle.size : current.size,
    background: SUBTITLE_BACKGROUNDS.some((b) => b.value === serverStyle.background)
      ? serverStyle.background
      : current.background,
  };
  try {
    window.localStorage.setItem(SUBTITLE_STYLE_KEY, JSON.stringify(merged));
  } catch (err) {}
  if (subtitleStyleTag) {
    applySubtitleStyle(null, merged);
  }
}

export let subtitleStyleTag = null;

export function applySubtitleStyle(video, style) {
  const size = SUBTITLE_SIZES.filter((s) => s.value === style.size)[0] || SUBTITLE_SIZES[1];
  const background = SUBTITLE_BACKGROUNDS.filter((b) => b.value === style.background)[0] || SUBTITLE_BACKGROUNDS[1];
  if (!subtitleStyleTag) {
    subtitleStyleTag = document.createElement('style');
    document.head.appendChild(subtitleStyleTag);
  }
  subtitleStyleTag.textContent =
    '.jellio-player-video::cue { font-size: ' +
    size.rem +
    'rem !important; background-color: ' +
    background.color +
    ' !important; }';
}
