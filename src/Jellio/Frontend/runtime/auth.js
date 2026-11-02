import { requestRowCacheWipe } from './rowcache.js';
import { getAcceptLanguageHeader } from './i18n.js';

export const Jellio = window.Jellio || (window.Jellio = {});

const STORAGE_PREFIX = 'jellio_auth::';
const SERVER_ADDRESS_KEY = STORAGE_PREFIX + 'serverAddress';
const DEVICE_ID_KEY = STORAGE_PREFIX + 'deviceId';
const SESSION_KEY = STORAGE_PREFIX + 'session';
const NATIVE_CREDENTIALS_KEY = 'jellyfin_credentials';

const CLIENT_NAME = 'Jellio';

// What Jellyfin's Devices and Dashboard show: the Mac app's own version
// there, otherwise the plugin's, which the server stamps onto app.js as ?v=.
function clientName() {
  return typeof window !== 'undefined' && window.jellioNative && window.jellioNative.platform === 'macos'
    ? 'Jellio for macOS'
    : CLIENT_NAME;
}

function clientVersion() {
  const native = typeof window !== 'undefined' && window.jellioNative && window.jellioNative.appVersion;
  if (native) return native;
  const script = typeof document !== 'undefined' && document.querySelector('script[src*="/Jellio/frontend/app.js"]');
  if (script) {
    try {
      const version = new URL(script.src, window.location.origin).searchParams.get('v');
      if (version) return version;
    } catch (err) {
      // Fall through.
    }
  }
  return '0.0.0';
}

// "Chrome on Android phone", "Safari on iPad", "Firefox on Windows": enough
// for Now Playing to tell a phone from a PC from a TV.
function describeBrowser() {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser';
  const touchMac = /Macintosh/.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1;
  let platform = '';
  if (/SMART-TV|SmartTV|Tizen|Web0S|webOS|BRAVIA|AFT\w|CrKey|Android TV|GoogleTV/i.test(ua)) platform = 'TV';
  else if (/iPad/.test(ua) || touchMac) platform = 'iPad';
  else if (/iPhone|iPod/.test(ua)) platform = 'iPhone';
  else if (/Android/.test(ua)) platform = /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  else if (/Windows/.test(ua)) platform = 'Windows';
  else if (/CrOS/.test(ua)) platform = 'ChromeOS';
  else if (/Macintosh/.test(ua)) platform = 'Mac';
  else if (/Linux/.test(ua)) platform = 'Linux';
  return platform ? browser + ' on ' + platform : browser;
}

function headerSafe(text) {
  return String(text || '').replace(/[^A-Za-z0-9 ._()-]/g, '').trim() || 'Browser';
}

function getDeviceName() {
  return headerSafe((typeof window !== 'undefined' && window.jellioNative && window.jellioNative.deviceName) || describeBrowser());
}

function readJson(key) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

function writeJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    // A full or blocked localStorage means the session does not survive a
    // reload, not that the app is broken for the rest of this tab's life.
  }
}

// Same origin as the page this script is injected into; Jellio has no
// concept of a separate server address the way a standalone app would.
export function getServerAddress() {
  return window.location.origin;
}

export function getDeviceId() {
  let id = window.localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id =
      'jellio-' +
      Date.now().toString(36) +
      '-' +
      Math.random().toString(36).slice(2, 10);
    try {
      window.localStorage.setItem(DEVICE_ID_KEY, id);
    } catch (err) {
      // Falls back to a fresh id every load, functional, just not stable.
    }
  }
  return id;
}

function getSession() {
  const session = readJson(SESSION_KEY);
  if (session && session.accessToken && session.userId) {
    return session;
  }
  const native = readJson(NATIVE_CREDENTIALS_KEY);
  if (native && Array.isArray(native.Servers)) {
    const server = native.Servers.find(function (s) {
      return s && s.AccessToken && s.UserId;
    }) || native.Servers[0];
    if (server && server.AccessToken && server.UserId) {
      const recovered = {
        accessToken: server.AccessToken,
        userId: server.UserId,
        user: { Id: server.UserId, Name: '' },
        ts: Date.now(),
      };
      writeJson(SESSION_KEY, recovered);
      return recovered;
    }
  }
  return null;
}

export function isAuthenticated() {
  const session = getSession();
  return !!(session && session.accessToken && session.userId);
}

export function getCurrentUserId() {
  const session = getSession();
  return session ? session.userId : null;
}

export function getAccessToken() {
  const session = getSession();
  return session ? session.accessToken : null;
}

export function getCurrentUser() {
  const session = getSession();
  return session ? session.user || null : null;
}

async function syncNativeCredentials(accessToken, user) {
  try {
    const response = await fetch(getServerAddress() + '/System/Info/Public');
    if (!response.ok) return;
    const info = await response.json();
    if (!info || !info.Id) return;

    const existing = readJson(NATIVE_CREDENTIALS_KEY);
    const servers = (existing && Array.isArray(existing.Servers) ? existing.Servers : []).filter(function (
      server,
    ) {
      return server.Id !== info.Id;
    });
    servers.push({
      Id: info.Id,
      AccessToken: accessToken,
      UserId: user.Id,
      ManualAddress: getServerAddress(),
      LocalAddress: getServerAddress(),
      Name: info.ServerName || '',
      DateLastAccessed: Date.now(),
      UserLinkType: 'Linked',
    });
    writeJson(NATIVE_CREDENTIALS_KEY, { Servers: servers });
  } catch (err) {
    // Best effort, see header above.
  }
}

function syncNativeApiClientState(accessToken, user) {
  try {
    if (window.ApiClient && typeof window.ApiClient.setAuthenticationInfo === 'function') {
      window.ApiClient.setAuthenticationInfo(accessToken, user.Id);
      window.ApiClient._deviceId = getDeviceId();
      window.ApiClient._appName = clientName();
      window.ApiClient._deviceName = getDeviceName();
      window.ApiClient._appVersion = clientVersion();
    }
  } catch (err) {
  }
}

export function updateSessionUser(user) {
  const session = readJson(SESSION_KEY);
  if (!session || !user || user.Id !== session.userId) return;
  session.user = Object.assign({}, session.user, user);
  writeJson(SESSION_KEY, session);
  if (session.accessToken) rememberUser(session.accessToken, user);
}

export function setSession(accessToken, user) {
  if (!accessToken || !user || !user.Id) return;
  writeJson(SESSION_KEY, {
    accessToken: accessToken,
    userId: user.Id,
    user: user,
    ts: Date.now(),
  });
  writeJson(SERVER_ADDRESS_KEY, getServerAddress());
  rememberUser(accessToken, user);
  syncNativeCredentials(accessToken, user);
  syncNativeApiClientState(accessToken, user);
}

const REMEMBERED_PREFIX = STORAGE_PREFIX + 'remembered::';

function rememberedKey() {
  return REMEMBERED_PREFIX + getServerAddress();
}

function readRemembered() {
  return readJson(rememberedKey()) || {};
}

function writeRemembered(map) {
  writeJson(rememberedKey(), map);
}

export function getRememberedUsers() {
  return readRemembered();
}

export function rememberUser(accessToken, user) {
  if (!accessToken || !user || !user.Id) return;
  const remembered = readRemembered();
  remembered[user.Id] = {
    accessToken: accessToken,
    name: user.Name || (remembered[user.Id] && remembered[user.Id].name) || '',
    primaryImageTag: user.PrimaryImageTag || null,
    ts: Date.now(),
  };
  writeRemembered(remembered);
}

export function forgetRememberedUser(userId) {
  const remembered = readRemembered();
  delete remembered[userId];
  writeRemembered(remembered);
}

function buildAuthHeaderForToken(token) {
  const parts = [
    'Client="' + clientName() + '"',
    'Device="' + getDeviceName() + '"',
    'DeviceId="' + getDeviceId() + '"',
    'Version="' + clientVersion() + '"',
  ];
  if (token) parts.push('Token="' + token + '"');
  return 'MediaBrowser ' + parts.join(', ');
}

const BYPASS_KEY = STORAGE_PREFIX + 'loginBypass';

export function bypassLoginScreen() {
  try {
    window.sessionStorage.setItem(BYPASS_KEY, '1');
  } catch (err) {
    // Not remembered, the caller still stops rendering the custom
    // screen for this one call either way.
  }
}

export function loginScreenBypassed() {
  try {
    return window.sessionStorage.getItem(BYPASS_KEY) === '1';
  } catch (err) {
    return false;
  }
}

export async function quickSignIn(userId) {
  const remembered = readRemembered();
  const entry = remembered[userId];
  if (!entry) throw new Error('No remembered session for this user');

  let response;
  let attempts = 0;
  while (attempts < 3) {
    attempts++;
    try {
      response = await fetch(getServerAddress() + '/Users/' + userId, {
        headers: { Accept: 'application/json', Authorization: buildAuthHeaderForToken(entry.accessToken) },
      });
      // Stop retrying on 2xx success or client errors (401 Unauthorized, 403 Forbidden, 404 Not Found)
      if (response.ok || (response.status >= 400 && response.status < 500)) {
        break;
      }
    } catch (netErr) {
      if (attempts >= 3) throw netErr;
    }
    if (attempts < 3) {
      await new Promise(function (resolve) {
        setTimeout(resolve, 500 * attempts);
      });
    }
  }

  if (!response || !response.ok) {
    if (response && (response.status === 401 || response.status === 403)) {
      delete remembered[userId];
      writeRemembered(remembered);
    }
    const err = new Error(
      response && (response.status === 401 || response.status === 403)
        ? 'Remembered session is no longer valid'
        : 'Failed to connect to server: ' + (response ? response.status : 'network error'),
    );
    err.status = response ? response.status : 0;
    throw err;
  }

  const user = await response.json();
  setSession(entry.accessToken, user);
  return user;
}

export function clearSession() {
  try {
    window.localStorage.removeItem(SESSION_KEY);
  } catch (err) {
    // Nothing left to clear if this fails, the key is simply stale.
  }
}

function buildAuthHeader() {
  const token = getAccessToken();
  const parts = [
    'Client="' + clientName() + '"',
    'Device="' + getDeviceName() + '"',
    'DeviceId="' + getDeviceId() + '"',
    'Version="' + clientVersion() + '"',
  ];
  if (token) {
    parts.push('Token="' + token + '"');
  }
  return 'MediaBrowser ' + parts.join(', ');
}

export function getAuthHeaders() {
  return {
    Authorization: buildAuthHeader(),
    'Accept-Language': getAcceptLanguageHeader(),
  };
}

export async function getPublicUsers() {
  const response = await fetch(getServerAddress() + '/Users/Public', {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error('Failed to load public users');
  const result = await response.json();
  return Array.isArray(result) ? result : [];
}

export function pruneHiddenRememberedUsers(publicUsers) {
  const publicById = {};
  publicUsers.forEach(function (user) {
    if (user && user.Id) publicById[user.Id] = user;
  });
  const remembered = readRemembered();
  let changed = false;
  Object.keys(remembered).forEach(function (userId) {
    const live = publicById[userId];
    if (!live) {
      delete remembered[userId];
      changed = true;
      return;
    }

    const freshName = live.Name || '';
    const freshTag = live.PrimaryImageTag || null;
    if (remembered[userId].name !== freshName || remembered[userId].primaryImageTag !== freshTag) {
      remembered[userId].name = freshName;
      remembered[userId].primaryImageTag = freshTag;
      changed = true;
    }
  });
  if (changed) writeRemembered(remembered);
}

export async function authenticateByName(username, password) {
  let response;
  let attempts = 0;
  while (attempts < 3) {
    attempts++;
    try {
      response = await fetch(getServerAddress() + '/Users/AuthenticateByName', {
        method: 'POST',
        headers: Object.assign(
          { 'Content-Type': 'application/json', Accept: 'application/json' },
          getAuthHeaders(),
        ),
        body: JSON.stringify({ Username: username, Pw: password }),
      });
      // Stop retrying on 2xx success or client errors (e.g. 401 Bad password)
      if (response.ok || (response.status >= 400 && response.status < 500)) {
        break;
      }
    } catch (netErr) {
      if (attempts >= 3) throw netErr;
    }
    if (attempts < 3) {
      await new Promise(function (resolve) {
        setTimeout(resolve, 500 * attempts);
      });
    }
  }

  if (!response || !response.ok) {
    const err = new Error('Authentication failed');
    err.status = response ? response.status : 0;
    throw err;
  }

  const result = await response.json();
  setSession(result.AccessToken, result.User);
  return result;
}

export async function requestPasswordReset(username) {
  const response = await fetch(getServerAddress() + '/Users/ForgotPassword', {
    method: 'POST',
    headers: Object.assign(
      { 'Content-Type': 'application/json', Accept: 'application/json' },
      getAuthHeaders(),
    ),
    body: JSON.stringify({ EnteredUsername: username }),
  });
  if (!response.ok) {
    const err = new Error('Could not request a password reset');
    err.status = response.status;
    throw err;
  }
  return response.json();
}

export async function redeemPasswordResetPin(pin) {
  const response = await fetch(getServerAddress() + '/Users/ForgotPassword/Pin', {
    method: 'POST',
    headers: Object.assign(
      { 'Content-Type': 'application/json', Accept: 'application/json' },
      getAuthHeaders(),
    ),
    body: JSON.stringify({ Pin: pin }),
  });
  if (!response.ok) {
    const err = new Error('Could not redeem the reset code');
    err.status = response.status;
    throw err;
  }
  return response.json();
}

export function logout() {
  requestRowCacheWipe(window);
  clearSession();
  try {
    window.localStorage.removeItem('jellyfin_credentials');
  } catch (err) {
    // Nothing left to clear if this fails, the key is simply stale.
  }
  window.location.reload();
}

