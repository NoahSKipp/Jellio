// Screens that change what Home shows (playback, reading, settings) mark
// its sections stale here rather than importing screens/home.js.
const listeners = new Set();

export function onHomeInvalidate(listener) {
  listeners.add(listener);
  return function () {
    listeners.delete(listener);
  };
}

// all: every section, not only the cheap personal rows.
export function invalidateHome(all) {
  listeners.forEach(function (listener) {
    listener(!!all);
  });
}
