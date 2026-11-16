import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map([['jellio_display_language', 'en']]);
store.set('jellio_auth::session', JSON.stringify({ userId: 'u1', accessToken: 'tok' }));

globalThis.window = {
  Jellio: {},
  localStorage: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  },
  location: { origin: 'http://server', pathname: '/index.html', hash: '' },
  addEventListener: () => {},
  removeEventListener: () => {},
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clearTimeout: (id) => clearTimeout(id),
  dispatchEvent: () => true,
  open: () => {},
};

globalThis.document = {
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
  createElement: (tag) => {
    const el = {
      tagName: tag.toUpperCase(),
      className: '',
      textContent: '',
      style: {},
      attributes: {},
      children: [],
      type: tag === 'button' ? 'button' : 'text',
      value: '',
      checked: false,
      disabled: false,
      setAttribute(k, v) { this.attributes[k] = String(v); },
      getAttribute(k) { return this.attributes[k] || null; },
      removeAttribute(k) { delete this.attributes[k]; },
      appendChild(child) { this.children.push(child); return child; },
      insertBefore(child) { this.children.unshift(child); return child; },
      addEventListener() {},
      removeEventListener() {},
      classList: {
        add(c) { if (!el.className.includes(c)) el.className += ' ' + c; },
        remove(c) { el.className = el.className.replace(c, '').trim(); },
        contains(c) { return el.className.includes(c); },
      },
    };
    return el;
  },
  querySelector: () => null,
};

const calls = [];
let handler = () => ({ status: 200, body: {} });
globalThis.fetch = async (url, init) => {
  calls.push({ url, init: init || {} });
  const { status, body } = handler(url, init || {});
  const text = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  return {
    status,
    ok: status < 400,
    text: async () => text,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    headers: { get: () => null },
  };
};

const {
  normalizeAniSyncService,
  normalizeAniSyncSettings,
  getAniSyncSettings,
  saveAniSyncPreferences,
  connectAniSync,
  disconnectAniSync,
  testAniSyncConnection,
  syncAniSyncNow,
  startAniSyncOAuth,
  startSimklPin,
  pollSimklPin,
} = await import('../../src/Jellio/Frontend/runtime/api.js');

test('normalizeAniSyncService handles service aliases and case', () => {
  assert.equal(normalizeAniSyncService('AniList'), 'anilist');
  assert.equal(normalizeAniSyncService('AL'), 'anilist');
  assert.equal(normalizeAniSyncService('MyAnimeList'), 'myanimelist');
  assert.equal(normalizeAniSyncService('MAL'), 'myanimelist');
  assert.equal(normalizeAniSyncService('Shikimori'), 'shikimori');
  assert.equal(normalizeAniSyncService('shiki'), 'shikimori');
  assert.equal(normalizeAniSyncService('Simkl'), 'simkl');
  assert.equal(normalizeAniSyncService(null), null);
  assert.equal(normalizeAniSyncService(''), null);
});

test('normalizeAniSyncSettings parses PascalCase backend payload correctly', () => {
  const backendPayload = {
    SelectedService: 'MyAnimeList',
    Enabled: true,
    SyncAllConnected: false,
    OnlyAnimeItems: true,
    Services: [
      {
        Id: 'myanimelist',
        Name: 'MyAnimeList',
        Connected: true,
        Username: 'otaku99',
        MaskedCredential: '****abcd',
        HasRefreshToken: true,
        HasCustomClientId: false,
        ServerClientId: 'mal_server_id',
        SupportsPinAuth: false,
        UpdatedAtUtc: '2026-11-16T12:00:00Z',
        LastSyncAtUtc: '2026-11-16T13:30:00Z',
        LastSyncedTitle: 'Frieren: Beyond Journey\'s End',
        LastError: null,
      },
      {
        Id: 'simkl',
        Name: 'Simkl',
        Connected: false,
        Username: null,
        MaskedCredential: null,
        HasRefreshToken: false,
        HasCustomClientId: false,
        ServerClientId: 'simkl_id',
        SupportsPinAuth: true,
        UpdatedAtUtc: null,
        LastSyncAtUtc: null,
        LastSyncedTitle: null,
        LastError: null,
      },
    ],
    RecentLogs: [
      {
        TimestampUtc: '2026-11-16T13:30:00Z',
        Service: 'myanimelist',
        ItemTitle: 'Frieren: Beyond Journey\'s End',
        EpisodeNumber: 28,
        Success: true,
        Message: 'Updated episode 28 to Completed',
      },
    ],
  };

  const parsed = normalizeAniSyncSettings(backendPayload);
  assert.equal(parsed.selectedService, 'myanimelist');
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.syncAllConnected, false);
  assert.equal(parsed.onlyAnimeItems, true);
  assert.equal(parsed.services.length, 2);
  assert.equal(parsed.services[0].id, 'myanimelist');
  assert.equal(parsed.services[0].connected, true);
  assert.equal(parsed.services[0].username, 'otaku99');
  assert.equal(parsed.services[0].maskedCredential, '****abcd');
  assert.equal(parsed.services[1].supportsPinAuth, true);
  assert.equal(parsed.recentLogs.length, 1);
  assert.equal(parsed.recentLogs[0].episodeNumber, 28);
  assert.equal(parsed.recentLogs[0].success, true);
});

test('getAniSyncSettings calls GET /Jellio/anisync/settings', async () => {
  calls.length = 0;
  handler = (url) => {
    assert.match(url, /\/Jellio\/anisync\/settings$/);
    return {
      status: 200,
      body: {
        SelectedService: 'AniList',
        Enabled: true,
        SyncAllConnected: true,
        OnlyAnimeItems: true,
        Services: [],
        RecentLogs: [],
      },
    };
  };

  const res = await getAniSyncSettings();
  assert.equal(res.selectedService, 'anilist');
  assert.equal(res.syncAllConnected, true);
  assert.equal(calls.length, 1);
});

test('saveAniSyncPreferences sends PUT with PascalCase payload and returns updated settings', async () => {
  calls.length = 0;
  handler = (url, init) => {
    assert.match(url, /\/Jellio\/anisync\/preferences$/);
    assert.equal(init.method, 'PUT');
    const body = JSON.parse(init.body);
    assert.equal(body.SelectedService, 'shikimori');
    assert.equal(body.Enabled, false);
    assert.equal(body.SyncAllConnected, true);
    assert.equal(body.OnlyAnimeItems, false);
    return {
      status: 200,
      body: {
        SelectedService: 'Shikimori',
        Enabled: false,
        SyncAllConnected: true,
        OnlyAnimeItems: false,
        Services: [],
        RecentLogs: [],
      },
    };
  };

  const updated = await saveAniSyncPreferences({
    selectedService: 'shikimori',
    enabled: false,
    syncAllConnected: true,
    onlyAnimeItems: false,
  });

  assert.equal(updated.selectedService, 'shikimori');
  assert.equal(updated.enabled, false);
  assert.equal(updated.onlyAnimeItems, false);
});

test('connectAniSync sends POST with PascalCase credentials', async () => {
  calls.length = 0;
  handler = (url, init) => {
    assert.match(url, /\/Jellio\/anisync\/connect$/);
    assert.equal(init.method, 'POST');
    const body = JSON.parse(init.body);
    assert.equal(body.Service, 'anilist');
    assert.equal(body.AccessToken, 'secret_token_12345');
    assert.equal(body.Username, 'animefan');
    return {
      status: 200,
      body: {
        Connected: true,
        Service: 'anilist',
        Username: 'animefan',
        Settings: {
          SelectedService: 'AniList',
          Enabled: true,
          Services: [{ Id: 'anilist', Name: 'AniList', Connected: true, Username: 'animefan' }],
          RecentLogs: [],
        },
      },
    };
  };

  const res = await connectAniSync({
    service: 'anilist',
    accessToken: 'secret_token_12345',
    username: 'animefan',
  });

  assert.equal(res.connected, true);
  assert.equal(res.service, 'anilist');
  assert.equal(res.username, 'animefan');
  assert.equal(res.settings.services[0].connected, true);
});

test('disconnectAniSync sends DELETE to /Jellio/anisync/disconnect?service={service}', async () => {
  calls.length = 0;
  handler = (url, init) => {
    assert.match(url, /\/Jellio\/anisync\/disconnect\?service=anilist$/);
    assert.equal(init.method, 'DELETE');
    return {
      status: 200,
      body: {
        SelectedService: 'AniList',
        Enabled: true,
        Services: [{ Id: 'anilist', Name: 'AniList', Connected: false }],
        RecentLogs: [],
      },
    };
  };

  const res = await disconnectAniSync('anilist');
  assert.equal(res.services[0].connected, false);
});

test('testAniSyncConnection and syncAniSyncNow call respective endpoints', async () => {
  calls.length = 0;
  handler = (url, init) => {
    if (url.includes('/test')) {
      const body = JSON.parse(init.body);
      assert.equal(body.Service, 'simkl');
      return { status: 200, body: { Ok: true, Message: 'Simkl connection OK.' } };
    }
    if (url.includes('/sync-now')) {
      const body = JSON.parse(init.body);
      assert.equal(body.Service, 'simkl');
      assert.equal(body.Limit, 10);
      return { status: 200, body: { SyncedCount: 3, FailedCount: 0, Message: 'Synced 3 items.' } };
    }
    return { status: 404 };
  };

  const testRes = await testAniSyncConnection('simkl');
  assert.equal(testRes.ok, true);
  assert.equal(testRes.message, 'Simkl connection OK.');

  const syncRes = await syncAniSyncNow({ service: 'simkl', limit: 10 });
  assert.equal(syncRes.syncedCount, 3);
  assert.equal(syncRes.failedCount, 0);
});

test('startAniSyncOAuth formats query params and parses start response', async () => {
  calls.length = 0;
  handler = (url) => {
    assert.match(url, /\/Jellio\/anisync\/oauth\/start\?service=myanimelist&redirectUri=http%3A%2F%2Fserver%2Fcallback&clientId=cid123/);
    return {
      status: 200,
      body: {
        Service: 'myanimelist',
        AuthorizeUrl: 'https://myanimelist.net/v1/oauth2/authorize?state=xyz',
        State: 'xyz',
        RedirectUri: 'http://server/callback',
        HasClientId: true,
      },
    };
  };

  const res = await startAniSyncOAuth('myanimelist', 'http://server/callback', 'cid123');
  assert.equal(res.service, 'myanimelist');
  assert.equal(res.authorizeUrl, 'https://myanimelist.net/v1/oauth2/authorize?state=xyz');
  assert.equal(res.hasClientId, true);
});

test('startSimklPin and pollSimklPin wrap Simkl PIN authentication flow', async () => {
  calls.length = 0;
  handler = (url, init) => {
    if (url.includes('/simkl/pin/poll')) {
      const body = JSON.parse(init.body);
      assert.equal(body.UserCode, 'CODE99');
      return {
        status: 200,
        body: {
          Approved: true,
          Pending: false,
          Username: 'simklUser',
          Settings: {
            SelectedService: 'Simkl',
            Enabled: true,
            Services: [{ Id: 'simkl', Name: 'Simkl', Connected: true, Username: 'simklUser' }],
            RecentLogs: [],
          },
        },
      };
    }
    if (url.includes('/simkl/pin')) {
      return {
        status: 200,
        body: {
          UserCode: 'CODE99',
          VerificationUrl: 'https://simkl.com/pin',
          ExpiresIn: 900,
          Interval: 5,
        },
      };
    }
    return { status: 404 };
  };

  const startRes = await startSimklPin();
  assert.equal(startRes.userCode, 'CODE99');
  assert.equal(startRes.verificationUrl, 'https://simkl.com/pin');

  const pollRes = await pollSimklPin('CODE99');
  assert.equal(pollRes.approved, true);
  assert.equal(pollRes.username, 'simklUser');
  assert.equal(pollRes.settings.services[0].connected, true);
});

test('connectAniSync surfaces 400 error body on err.serverMessage', async () => {
  calls.length = 0;
  handler = () => ({
    status: 400,
    body: 'AniList rejected that token or could not be reached.',
  });

  await assert.rejects(
    () => connectAniSync({ service: 'anilist', accessToken: 'bad-token-123456' }),
    (err) => {
      assert.equal(err.status, 400);
      assert.equal(err.serverMessage, 'AniList rejected that token or could not be reached.');
      return true;
    },
  );
});

