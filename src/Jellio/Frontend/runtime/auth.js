// Jellio's own session state, independent of native jellyfin-web ApiClient.
// Real architecture reference: JMSFusion (github.com/G-grbz/Jellyfin-MonWUI-Plugin,
// RuntimeModules/auth.js), read before writing anything here, not guessed at.
//
// Why this exists at all rather than reading window.ApiClient.isLoggedIn():
// that flag is a plain in-memory boolean jellyfin-apiclient-javascript only
// sets from inside its own connect()/validateAuthentication cycle, on its own
// schedule, using request formats this plugin does not control and has
// already seen rejected by at least one real deployment. A reskin has to
// live with that because it only ever augments native pages. This codebase
// does not, so it keeps its own record of who is signed in, updated the
// moment a real login response is seen, not on native code's timetable.
export const Jellio = window.Jellio || (window.Jellio = {});

const STORAGE_PREFIX = 'jellio_auth::';
const SERVER_ADDRESS_KEY = STORAGE_PREFIX + 'serverAddress';
const DEVICE_ID_KEY = STORAGE_PREFIX + 'deviceId';
const SESSION_KEY = STORAGE_PREFIX + 'session';

const CLIENT_NAME = 'Jellio';
const CLIENT_VERSION = '0.1.0';

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

// Real, stable per browser id, generated once and kept for the lifetime of
// this storage, the same role jellyfin-apiclient-javascript's own deviceId
// plays, not shared with it: this runtime's sessions are its own.
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
  return readJson(SESSION_KEY);
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

// The one real completion signal a login can give this runtime: a
// server response carrying a fresh AccessToken and User. Called either
// after this runtime's own direct authenticateByName call, or by the
// console.log interception below when native login handled it instead.
export function setSession(accessToken, user) {
  if (!accessToken || !user || !user.Id) return;
  writeJson(SESSION_KEY, {
    accessToken: accessToken,
    userId: user.Id,
    user: user,
    ts: Date.now(),
  });
  writeJson(SERVER_ADDRESS_KEY, getServerAddress());
}

export function clearSession() {
  try {
    window.localStorage.removeItem(SESSION_KEY);
  } catch (err) {
    // Nothing left to clear if this fails, the key is simply stale.
  }
}

// Full Authorization header, the same shape every native jellyfin-web
// request already sends (MediaBrowser Client/Device/DeviceId/Version/Token),
// never the bare X-Emby-Token/X-MediaBrowser-Token shorthand: that shorthand
// is only honoured when a server's own EnableLegacyAuthorization setting is
// on (Jellyfin.Server.Implementations/Security/AuthorizationContext.cs, real
// source, version matched against a live deployment during the reskin
// codebase's own quick sign-in work), and at least one real deployment had
// it rejected. The full header has no such dependency.
export function buildAuthHeader() {
  const token = getAccessToken();
  const parts = [
    'Client="' + CLIENT_NAME + '"',
    'Device="Browser"',
    'DeviceId="' + getDeviceId() + '"',
    'Version="' + CLIENT_VERSION + '"',
  ];
  if (token) {
    parts.push('Token="' + token + '"');
  }
  return 'MediaBrowser ' + parts.join(', ');
}

export function getAuthHeaders() {
  return { Authorization: buildAuthHeader() };
}

// Real Jellyfin endpoint, checked against apps/legacy/controllers/session/
// login/index.js before writing this: POST /Users/AuthenticateByName with
// {Username, Pw}, response carries {AccessToken, User}. No native ApiClient
// involved at all, this runtime authenticates itself directly.
export async function authenticateByName(username, password) {
  const response = await fetch(getServerAddress() + '/Users/AuthenticateByName', {
    method: 'POST',
    headers: Object.assign(
      { 'Content-Type': 'application/json', Accept: 'application/json' },
      getAuthHeaders(),
    ),
    body: JSON.stringify({ Username: username, Pw: password }),
  });

  if (!response.ok) {
    const err = new Error('Authentication failed');
    err.status = response.status;
    throw err;
  }

  const result = await response.json();
  setSession(result.AccessToken, result.User);
  return result;
}

// Clears this runtime's own session and native jellyfin-web's own
// credential store ('jellyfin_credentials', the real localStorage key
// jellyfin-apiclient-javascript's own credentials.js writes to), then
// reloads so both land back on native's own sign in screen rather than
// the two disagreeing about who is signed in.
export function logout() {
  clearSession();
  try {
    window.localStorage.removeItem('jellyfin_credentials');
  } catch (err) {
    // Nothing left to clear if this fails, the key is simply stale.
  }
  window.location.reload();
}

// Fallback capture path: if a real login ever happens through native
// jellyfin-web instead of this runtime's own authenticateByName (a stock
// login screen shown while this codebase has not migrated that route yet),
// jellyfin-apiclient-javascript's own Credentials.initialize() logs
// "Stored JSON credentials: {...}" on every boot, real source
// (lib/jellyfin-apiclient's own credentials.js), confirmed during the
// reskin codebase's own login work, not guessed at. Real technique,
// confirmed against JMSFusion's own real source (RuntimeModules/auth.js),
// not invented here: intercepting console.log is the only way an injected
// script reaches that value, jellyfin-apiclient-javascript's own module
// internals are never exposed on window.
(function interceptNativeCredentialLog() {
  const marker = 'Stored JSON credentials:';
  const originalLog = console.log;
  console.log = function () {
    try {
      for (let i = 0; i < arguments.length; i++) {
        const arg = arguments[i];
        if (typeof arg === 'string' && arg.indexOf(marker) === 0) {
          const parsed = JSON.parse(arg.slice(marker.length).trim());
          const server =
            parsed && parsed.Servers && parsed.Servers[0];
          if (server && server.AccessToken && server.UserId) {
            fetch(getServerAddress() + '/Users/' + server.UserId, {
              headers: { 'X-Emby-Token': server.AccessToken },
            })
              .then(function (res) {
                return res.ok ? res.json() : null;
              })
              .then(function (user) {
                if (user) setSession(server.AccessToken, user);
              })
              .catch(function () {
                // A failed capture just means native login's own token
                // stays out of this runtime's session, not a crash.
              });
          }
        }
      }
    } catch (err) {
      // Never let a parsing failure here break console.log itself.
    }
    return originalLog.apply(console, arguments);
  };
})();
