import { readString, writeString } from './storage.js';

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
    const value = readString(KEY);
    if (value && PREBUFFER_LEVELS[value]) return value;
  } catch (err) {}
  return 'standard';
}

export function setPrebufferLevel(value) {
  writeString(KEY, PREBUFFER_LEVELS[value] ? value : 'standard');
}

export function prebufferSettings() {
  return PREBUFFER_LEVELS[getPrebufferLevel()];
}

const STANDARD_START = { targetSeconds: 8, timeoutMs: 12000 };
const CACHED_START = { targetSeconds: 1, timeoutMs: 2500 };
const FAST_START = { targetSeconds: 2, timeoutMs: 5000 };

// How much to buffer before the first play() (and after a reload). A
// raised level is the reader's choice and always wins; on Standard a
// stream the server confirmed cached, or one played as is that is Ready
// (warm) or a local file, starts at a second or two; the stall wait in the
// player still catches one that runs dry.
export function startBufferTarget(prebuffer, source) {
  const level = prebuffer || PREBUFFER_LEVELS.standard;
  const info = source || {};
  if (level.startSeconds > STANDARD_START.targetSeconds) {
    return {
      targetSeconds: level.startSeconds,
      timeoutMs: Math.max(STANDARD_START.timeoutMs, level.startTimeoutMs),
      acceptReadyState: false,
    };
  }
  let start = STANDARD_START;
  if (info.confirmedCached) start = CACHED_START;
  else if (!info.transcoded && (info.ready || info.localFile)) start = FAST_START;
  return { targetSeconds: start.targetSeconds, timeoutMs: start.timeoutMs, acceptReadyState: true };
}

const BUFFER_SWITCH_KEY = 'jellio_buffer_switch';
const BUFFER_SWITCH_VALUES = ['ask', 'auto', 'off'];

// What to do when a stream keeps stopping to buffer.
export function getBufferSwitchMode() {
  try {
    const value = readString(BUFFER_SWITCH_KEY);
    if (BUFFER_SWITCH_VALUES.indexOf(value) !== -1) return value;
  } catch (err) {}
  return 'ask';
}

export function setBufferSwitchMode(value) {
  writeString(BUFFER_SWITCH_KEY, BUFFER_SWITCH_VALUES.indexOf(value) !== -1 ? value : 'ask');
}
