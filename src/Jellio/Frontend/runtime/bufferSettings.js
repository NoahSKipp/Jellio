// How much the web player loads before it starts, and after it runs dry
// mid-playback, kept per browser. Standard is the old behaviour; More and
// Maximum trade a longer wait for fewer hiccups on big (4K) files.
const KEY = 'jellio_prebuffer';

export const PREBUFFER_LEVELS = {
  standard: { startSeconds: 8, startTimeoutMs: 12000, stallSeconds: 0, stallTimeoutMs: 0 },
  more: { startSeconds: 20, startTimeoutMs: 30000, stallSeconds: 15, stallTimeoutMs: 30000 },
  max: { startSeconds: 45, startTimeoutMs: 60000, stallSeconds: 30, stallTimeoutMs: 60000 },
};

export const PREBUFFER_OPTIONS = [
  { value: 'standard', label: 'Standard' },
  { value: 'more', label: 'More (20 seconds)' },
  { value: 'max', label: 'Maximum (45 seconds)' },
];

export function getPrebufferLevel() {
  try {
    const value = window.localStorage.getItem(KEY);
    if (value && PREBUFFER_LEVELS[value]) return value;
  } catch (err) {}
  return 'standard';
}

export function setPrebufferLevel(value) {
  try {
    window.localStorage.setItem(KEY, PREBUFFER_LEVELS[value] ? value : 'standard');
  } catch (err) {}
}

export function prebufferSettings() {
  return PREBUFFER_LEVELS[getPrebufferLevel()];
}
