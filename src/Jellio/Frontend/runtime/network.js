// Nuvio's own real NetworkStatusRepository (core/network/NetworkStatusRepository.kt,
// confirmed against its real source before writing this) treats "no
// internet at all" and "online but the server is unreachable" as two
// separate real conditions, not one generic "offline": a reader whose
// own wifi is fine but whose Jellyfin server, or whatever Gelato itself
// depends on, is what is actually down gets pointed at fixing
// something that was never broken. navigator.onLine is a real signal
// for the first case (a browser only ever reports it false when the OS
// itself has no route out at all), timedOut on the caught error
// (runtime/api.js's own AbortController timeout) is a real signal for
// the second: an online connection that still could not get an answer
// inside a generous real window.
export function isOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

// subject is always a lowercase noun phrase ("this title", "playback"),
// dropped into the middle of every sentence below so callers never have
// to think about capitalization at the call site.
export function describeNetworkFailure(subject, err) {
  if (isOffline()) {
    return 'You appear to be offline. Reconnect and try again.';
  }
  if (err && err.timedOut) {
    return 'Loading ' + subject + ' timed out. The server may be slow right now, try again in a moment.';
  }
  return 'Could not load ' + subject + '. Check your connection and try again.';
}
