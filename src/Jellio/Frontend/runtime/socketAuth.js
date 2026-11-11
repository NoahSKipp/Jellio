// Jellyfin's own ApiClient opens its WebSocket with ?api_key=, which servers
// with legacy authorization off (the default since 10.11) answer with 403.
// SyncPlay rides on that socket, so its URL is rewritten to ?ApiKey=, which
// every supported server accepts.
export function socketUrlWithApiKey(url, base) {
  let parsed;
  try {
    parsed = new URL(url, base);
  } catch (err) {
    return url;
  }
  if (!/\/socket$/i.test(parsed.pathname) || !parsed.searchParams.has('api_key')) return url;
  const key = parsed.searchParams.get('api_key');
  parsed.searchParams.delete('api_key');
  if (!parsed.searchParams.has('ApiKey')) parsed.searchParams.set('ApiKey', key);
  return parsed.toString();
}

export function installSocketAuthFix(target) {
  const scope = target || (typeof window !== 'undefined' ? window : null);
  if (!scope || !scope.WebSocket || scope.WebSocket.__jellioApiKey) return;
  const Native = scope.WebSocket;
  function JellioWebSocket(url, protocols) {
    const fixed = socketUrlWithApiKey(url, scope.location && scope.location.href);
    return protocols === undefined ? new Native(fixed) : new Native(fixed, protocols);
  }
  JellioWebSocket.prototype = Native.prototype;
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (name) {
    JellioWebSocket[name] = Native[name];
  });
  JellioWebSocket.__jellioApiKey = true;
  scope.WebSocket = JellioWebSocket;
}

installSocketAuthFix();
