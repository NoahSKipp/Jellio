// How much the seasonal effects move, per browser: Full, Reduced (fewer
// pieces, lower frame rate), Still (the scenery without animation) or Off.
// Auto follows the system's reduced motion setting.
const KEY = 'jellioSeasonalMotion';
const EVENT = 'jellio-motion-change';

export const MOTION_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'full', label: 'Full' },
  { value: 'reduced', label: 'Reduced' },
  { value: 'still', label: 'Still (no animation)' },
  { value: 'off', label: 'Off' },
];

const LEVELS = ['full', 'reduced', 'still', 'off'];

export function getMotionPreference() {
  try {
    const value = window.localStorage.getItem(KEY);
    return LEVELS.indexOf(value) !== -1 ? value : 'auto';
  } catch (err) {
    return 'auto';
  }
}

export function setMotionPreference(value) {
  try {
    if (value === 'auto') window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, value);
  } catch (err) {
    // Not persisted, this tab still uses it until reload.
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function resolveMotionLevel(preference, prefersReducedMotion) {
  if (LEVELS.indexOf(preference) !== -1) return preference;
  return prefersReducedMotion ? 'still' : 'full';
}

export function getMotionLevel() {
  const reduced = Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  return resolveMotionLevel(getMotionPreference(), reduced);
}

export function onMotionChange(listener) {
  window.addEventListener(EVENT, listener);
  window.addEventListener('storage', function (event) {
    if (event.key === KEY) listener();
  });
  if (window.matchMedia) {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (query.addEventListener) query.addEventListener('change', listener);
  }
}
