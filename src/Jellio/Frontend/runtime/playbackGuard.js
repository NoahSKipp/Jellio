// Keeps playback reports honest: no Progress after a Stopped for the same
// item, and a paused player goes quiet, then stops its session.

export const PAUSE_IDLE_STOP_MS = 10 * 60 * 1000;

const stoppedKeys = new Set();

function key(itemId, mediaSourceId) {
  return String(itemId) + '|' + String(mediaSourceId || '');
}

export function markPlaybackStarted(itemId, mediaSourceId) {
  stoppedKeys.delete(key(itemId, mediaSourceId));
}

export function markPlaybackStopped(itemId, mediaSourceId) {
  stoppedKeys.add(key(itemId, mediaSourceId));
}

export function canReportProgress(itemId, mediaSourceId) {
  return !stoppedKeys.has(key(itemId, mediaSourceId));
}

// Decides what one progress tick should do: 'progress' while playing, a
// single 'progress' when a pause begins, 'skip' while it lasts, and 'stop'
// once it has lasted idleMs.
export function createPauseGate(idleMs) {
  const limit = idleMs || PAUSE_IDLE_STOP_MS;
  let pausedSince = null;
  let stopped = false;
  return {
    tick(paused, now) {
      if (!paused) {
        pausedSince = null;
        stopped = false;
        return 'progress';
      }
      if (stopped) return 'skip';
      if (pausedSince == null) {
        pausedSince = now;
        return 'progress';
      }
      if (now - pausedSince >= limit) {
        stopped = true;
        return 'stop';
      }
      return 'skip';
    },
    reset() {
      pausedSince = null;
      stopped = false;
    },
  };
}

// One progress timer per page: starting a new one clears any left behind.
let activeTimer = null;

export function startProgressTimer(fn, ms) {
  stopProgressTimer();
  activeTimer = window.setInterval(fn, ms);
  return activeTimer;
}

export function stopProgressTimer(id) {
  if (id != null && id !== activeTimer) {
    window.clearInterval(id);
    return;
  }
  if (activeTimer != null) window.clearInterval(activeTimer);
  activeTimer = null;
}
