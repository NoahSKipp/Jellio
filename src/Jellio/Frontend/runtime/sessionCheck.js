// Decides whether a 401 means the session is really gone. A single 401
// (a plugin endpoint with a stricter policy, a proxy hiccup, a token being
// rotated) is confirmed with one cheap authenticated call first; only a
// second 401 from that call ends the session.

export const RECHECK_INTERVAL_MS = 60000;

const AUTH_ENDPOINT_RE = /^\/?(?:Users\/AuthenticateByName|Users\/AuthenticateWithQuickConnect|Users\/ForgotPassword|QuickConnect\/)/i;

export function isAuthEndpoint(path) {
  return AUTH_ENDPOINT_RE.test(String(path || ''));
}

// A 401 worth confirming: from the user's own server and not one of the
// sign-in endpoints, where 401 just means wrong credentials.
export function shouldConfirmUnauthorized(url, path, serverAddress) {
  if (!serverAddress || typeof url !== 'string') return false;
  const base = String(serverAddress).replace(/\/+$/, '');
  if (url !== base && url.indexOf(base + '/') !== 0) return false;
  const rel = path || url.slice(base.length);
  return !isAuthEndpoint(rel);
}

// 'expired' only on a 401. Network errors, timeouts, 403 and 5xx say
// nothing about the token.
export function classifyProbe(statusOrError) {
  if (typeof statusOrError === 'number') {
    if (statusOrError === 401) return 'expired';
    if (statusOrError >= 200 && statusOrError < 300) return 'valid';
  }
  return 'unknown';
}

// probe(token) resolves to an HTTP status (or rejects on network errors);
// onExpired(token) runs at most once per confirmed loss.
export function createSessionGuard(options) {
  const probe = options.probe;
  const onExpired = options.onExpired;
  const now = options.now || Date.now;
  const interval = options.recheckIntervalMs || RECHECK_INTERVAL_MS;
  const inFlight = new Map();
  const lastChecked = new Map();

  function report(token) {
    if (!token) return Promise.resolve('unknown');
    const pending = inFlight.get(token);
    if (pending) return pending;
    const last = lastChecked.get(token);
    if (last && now() - last.at < interval) return Promise.resolve(last.result);

    const check = Promise.resolve()
      .then(function () {
        return probe(token);
      })
      .then(classifyProbe, function () {
        return 'unknown';
      })
      .then(function (result) {
        inFlight.delete(token);
        lastChecked.set(token, { at: now(), result: result });
        if (result === 'expired') onExpired(token);
        return result;
      });
    inFlight.set(token, check);
    return check;
  }

  return { report: report };
}
