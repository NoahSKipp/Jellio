const KEY = 'jellio_prebuffer';

const PREBUFFER_LEVELS = {
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

const BUFFER_SWITCH_KEY = 'jellio_buffer_switch';
const BUFFER_SWITCH_VALUES = ['ask', 'auto', 'off'];

// What to do when a stream keeps stopping to buffer.
export function getBufferSwitchMode() {
  try {
    const value = window.localStorage.getItem(BUFFER_SWITCH_KEY);
    if (BUFFER_SWITCH_VALUES.indexOf(value) !== -1) return value;
  } catch (err) {}
  return 'ask';
}

export function setBufferSwitchMode(value) {
  try {
    window.localStorage.setItem(BUFFER_SWITCH_KEY, BUFFER_SWITCH_VALUES.indexOf(value) !== -1 ? value : 'ask');
  } catch (err) {}
}
