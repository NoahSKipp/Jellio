export function isOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

export function describeNetworkFailure(subject, err) {
  if (isOffline()) {
    return 'You appear to be offline. Reconnect and try again.';
  }
  if (err && err.timedOut) {
    return 'Loading ' + subject + ' timed out. The server may be slow right now, try again in a moment.';
  }
  return 'Could not load ' + subject + '. Check your connection and try again.';
}
