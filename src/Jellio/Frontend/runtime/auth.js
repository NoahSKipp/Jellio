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
const NATIVE_CREDENTIALS_KEY = 'jellyfin_credentials';

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

// A login this runtime's own authenticateByName/quickSignIn handles
// never touches native jellyfin-web's own ApiClient at all (this
// file's own header explains why), which left native with no session
// of its own: the very next unmigrated route, or a plain reload before
// this runtime's own bootstrap took over, found native's own
// 'jellyfin_credentials' store empty and asked to sign in a second
// time, reported live on a cold cache. Real shape, read from
// jellyfin-apiclient-javascript's own credentials.js (addOrUpdateServer)
// before writing this, not guessed at: a Servers array keyed by each
// server's own real Id, AccessToken/UserId making an entry "signed in"
// the moment connectionManager.connect() finds it. Best effort: a
// failed /System/Info/Public call here only loses native's own free
// ride, not this runtime's own real session, which setSession below
// has already committed by the time this runs.
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

// syncNativeCredentials above only ever helps a native reconnect that
// has not happened yet: real jellyfin-apiclient-javascript source
// (src/apiClient.js), read before writing this, keeps its own actual
// "am I logged in" state in a plain in-memory flag on the ApiClient
// instance itself (_loggedIn, set by setAuthenticationInfo), read once
// at that instance's own construction and never re-polled from
// localStorage afterward. Writing jellyfin_credentials after the fact
// changes nothing about a native ApiClient instance already sitting in
// memory since this page's own load, real bug found live: signing in
// here still bounced straight into native's own login/select-user
// screen on the very next real navigation, since window.Emby.Page.show()
// (runtime/router.js's own navigateTo, used for every real navigation
// so native's own click handlers still work) runs through native's own
// route guard, which reads that same stale in-memory flag, not
// anything this runtime writes to storage. setAuthenticationInfo is a
// plain property assignment, no network request, so this carries none
// of the real risk a full native reconnect already showed on this
// exact codebase's own prior attempt at this (this file's own header,
// "the exact mechanism that later got pulled"): that risk was
// specifically in re-running validateAuthentication() over the
// network, which this never does.
function syncNativeApiClientState(accessToken, user) {
  try {
    if (window.ApiClient && typeof window.ApiClient.setAuthenticationInfo === 'function') {
      window.ApiClient.setAuthenticationInfo(accessToken, user.Id);
    }
  } catch (err) {
    // Native's own guard stays wrong for the rest of this page's life
    // if this fails, not this runtime's own real session.
  }
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
  rememberUser(accessToken, user);
  syncNativeCredentials(accessToken, user);
  syncNativeApiClientState(accessToken, user);
}

// This runtime's own {userId: {accessToken, name, primaryImageTag, ts}}
// map, separate from the one slot SESSION_KEY holds for whoever is
// currently signed in. Real architecture reference: JMSFusion
// (Resources/slider/modules/profileChooser.js), read before writing this,
// not guessed at. Native jellyfin-web's own credential store only ever
// holds one user per server too, so remembering more than one on a
// shared device needs a second store regardless of which runtime does
// it.
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
    'Client="' + CLIENT_NAME + '"',
    'Device="Browser"',
    'DeviceId="' + getDeviceId() + '"',
    'Version="' + CLIENT_VERSION + '"',
  ];
  if (token) parts.push('Token="' + token + '"');
  return 'MediaBrowser ' + parts.join(', ');
}

// screens/login.js only covers real username/password sign in, the one
// case every server has. Quick Connect, a no-password public user grid
// and "forgot password" are all real native login page features it
// does not reimplement, so a way back to native's own login page stays
// available rather than stranding anyone who needs one of those behind
// a screen that cannot help them, the same native fallback discipline
// every unmigrated route already gets. sessionStorage rather than this
// module's own localStorage: the point is only to skip the custom
// screen for the rest of this tab's life, not to remember the choice
// on the next real visit.
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

// Quick sign-in: reuse a remembered AccessToken an earlier real login on
// this device already produced, no password asked again. The original
// codebase's own version of this trusted a remembered token blindly and
// leaned on a native reload to find out, live, whether it still worked,
// which is the exact mechanism that later got pulled ("keeps bouncing
// back to the login screen") once that reload turned out to send a bare
// legacy header a real deployment rejected. This runtime has no such
// reload step and no native validateAuthentication() in the path at
// all, so instead it spends one real GET on the candidate token first:
// a revoked or expired token is caught here and the remembered entry is
// dropped, rather than silently committing a session that the very next
// request would fail.
export async function quickSignIn(userId) {
  const remembered = readRemembered();
  const entry = remembered[userId];
  if (!entry) throw new Error('No remembered session for this user');

  const response = await fetch(getServerAddress() + '/Users/' + userId, {
    headers: { Accept: 'application/json', Authorization: buildAuthHeaderForToken(entry.accessToken) },
  });
  if (!response.ok) {
    delete remembered[userId];
    writeRemembered(remembered);
    const err = new Error('Remembered session is no longer valid');
    err.status = response.status;
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

// Real, unauthenticated Jellyfin endpoint (GET /Users/Public,
// Jellyfin.Api/Controllers/UserController.cs's own GetPublicUsers,
// read before writing this): a real admin's own per-user "Display
// this user on the login screen" toggle (UserPolicy.IsHidden) is
// already enforced server side, this runtime only has to render
// whatever comes back, not filter anything itself. The one real case
// this covers that remembered sign-in cannot: a device that has never
// signed in here before still gets a real profile grid instead of a
// bare username field, the same first-run experience native's own
// login page already gives every user who opted into it.
export async function getPublicUsers() {
  const response = await fetch(getServerAddress() + '/Users/Public', {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) return [];
  const result = await response.json();
  return Array.isArray(result) ? result : [];
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

// Real Jellyfin endpoint, checked against Jellyfin.Api/Controllers/
// UserController.cs's own ForgotPassword action before writing this:
// POST /Users/ForgotPassword with {EnteredUsername}. The real
// response's own Action field (ForgotPasswordAction, real source
// again) is deliberately the same PinCode value whether or not the
// username exists at all, ContactAdmin/InNetworkRequired are both
// marked Obsolete on the server's own side over exactly that "returning
// different actions represents a security concern", so this runtime
// has to give the same generic "check your email" message regardless
// of the real result too, or it would leak back out the exact thing
// the server itself stopped leaking. A real pin file only gets written
// server side when the account is real; jfa-go (already configured
// server side, real reference: github.com/hrfee/jfa-go's own
// pwreset.go, validatePWR watches for exactly that file) is what
// turns a real one into a real email, no separate jfa-go API call
// from here at all.
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

// Real Jellyfin endpoint, checked against the same controller's own
// ForgotPasswordPin action: POST /Users/ForgotPassword/Pin with {Pin},
// response carries a real Success boolean (PinRedeemResult, real
// source, no guessed field name). A real redeem clears the account's
// own password server side rather than setting the one this runtime
// would want it to end on, real Jellyfin behaviour, not a choice made
// here: screens/login.js's own forgot password flow signs back in
// with a blank password immediately after a real Success, then calls
// updateUserPassword to set the reader's own real new one, the same
// two real calls the stock profile page's own "forgot password" flow
// already makes for the same reason.
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

// The console.log interception this runtime used to install here was
// always too late to matter: jellyfin-apiclient-javascript's own
// Credentials.initialize() logs "Stored JSON credentials: {...}" exactly
// once, synchronously, during the one real ConnectionManager construction
// that happens inside jellyfin-web's own main bundle, itself a deferred
// script. This bootstrap module is also deferred and sits last in the
// document (IndexHtmlPatchService's own injected block), so by the time
// any code in this file ever ran, that log had already fired and was
// gone. Real bug, found on a live install: this whole runtime silently
// never saw a session, ever, on every load. The capture now happens in a
// plain (non-deferred, non-module) inline script IndexHtmlPatchService
// injects ahead of this one, which always runs first regardless of
// document position, writing the same session shape setSession below
// does. Nothing here needs to read jellyfin_credentials or hook
// console.log itself anymore, only find what that earlier script already
// wrote.
