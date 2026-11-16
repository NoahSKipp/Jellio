import { getJson, postJson, putJson, deleteJson } from './core.js';

// Per-user Ani-Sync settings and provider sync client (matching AniSyncController.cs).
// Jellyfin serializes C# records in PascalCase; we normalize to consistent camelCase/PascalCase friendly objects.

export function normalizeAniSyncService(service) {
  if (!service) return null;
  const s = String(service).trim().toLowerCase();
  if (s === 'anilist' || s === 'al') return 'anilist';
  if (s === 'myanimelist' || s === 'mal') return 'myanimelist';
  if (s === 'shikimori' || s === 'shiki') return 'shikimori';
  if (s === 'simkl') return 'simkl';
  return s;
}

export function normalizeAniSyncSettings(raw) {
  if (!raw) return null;
  const services = (raw.Services || raw.services || []).map(function (svc) {
    return {
      id: svc.Id || svc.id || '',
      name: svc.Name || svc.name || '',
      connected: Boolean(svc.Connected ?? svc.connected),
      username: svc.Username ?? svc.username ?? null,
      maskedCredential: svc.MaskedCredential ?? svc.maskedCredential ?? null,
      hasRefreshToken: Boolean(svc.HasRefreshToken ?? svc.hasRefreshToken),
      hasCustomClientId: Boolean(svc.HasCustomClientId ?? svc.hasCustomClientId),
      serverClientId: svc.ServerClientId ?? svc.serverClientId ?? null,
      hasServerClientSecret: Boolean(svc.HasServerClientSecret ?? svc.hasServerClientSecret),
      supportsPinAuth: Boolean(svc.SupportsPinAuth ?? svc.supportsPinAuth),
      updatedAtUtc: svc.UpdatedAtUtc ?? svc.updatedAtUtc ?? null,
      lastSyncAtUtc: svc.LastSyncAtUtc ?? svc.lastSyncAtUtc ?? null,
      lastSyncedTitle: svc.LastSyncedTitle ?? svc.lastSyncedTitle ?? null,
      lastError: svc.LastError ?? svc.lastError ?? null,
    };
  });

  const recentLogs = (raw.RecentLogs || raw.recentLogs || []).map(function (log) {
    return {
      timestampUtc: log.TimestampUtc ?? log.timestampUtc ?? null,
      service: log.Service || log.service || '',
      itemTitle: log.ItemTitle || log.itemTitle || '',
      episodeNumber: log.EpisodeNumber ?? log.episodeNumber ?? null,
      success: Boolean(log.Success ?? log.success),
      message: log.Message || log.message || '',
    };
  });

  return {
    selectedService: normalizeAniSyncService(raw.SelectedService ?? raw.selectedService) || 'anilist',
    enabled: raw.Enabled != null ? Boolean(raw.Enabled) : (raw.enabled != null ? Boolean(raw.enabled) : true),
    syncAllConnected: Boolean(raw.SyncAllConnected ?? raw.syncAllConnected),
    onlyAnimeItems: raw.OnlyAnimeItems != null ? Boolean(raw.OnlyAnimeItems) : (raw.onlyAnimeItems != null ? Boolean(raw.onlyAnimeItems) : true),
    services: services,
    recentLogs: recentLogs,
  };
}

export async function getAniSyncSettings() {
  const data = await getJson('/Jellio/anisync/settings');
  return normalizeAniSyncSettings(data);
}

export async function saveAniSyncPreferences(preferences) {
  const body = {};
  if (preferences.selectedService != null || preferences.SelectedService != null) {
    body.SelectedService = preferences.selectedService ?? preferences.SelectedService;
  }
  if (preferences.enabled != null || preferences.Enabled != null) {
    body.Enabled = Boolean(preferences.enabled ?? preferences.Enabled);
  }
  if (preferences.syncAllConnected != null || preferences.SyncAllConnected != null) {
    body.SyncAllConnected = Boolean(preferences.syncAllConnected ?? preferences.SyncAllConnected);
  }
  if (preferences.onlyAnimeItems != null || preferences.OnlyAnimeItems != null) {
    body.OnlyAnimeItems = Boolean(preferences.onlyAnimeItems ?? preferences.OnlyAnimeItems);
  }

  const data = await putJson('/Jellio/anisync/preferences', body);
  return normalizeAniSyncSettings(data);
}

export async function connectAniSync(options) {
  const body = {
    Service: options.service ?? options.Service,
    Username: options.username ?? options.Username ?? null,
    AccessToken: options.accessToken ?? options.AccessToken ?? null,
    RefreshToken: options.refreshToken ?? options.RefreshToken ?? null,
    ClientId: options.clientId ?? options.ClientId ?? null,
    ClientSecret: options.clientSecret ?? options.ClientSecret ?? null,
    AuthCode: options.authCode ?? options.AuthCode ?? null,
    RedirectUri: options.redirectUri ?? options.RedirectUri ?? null,
    OAuthState: options.oauthState ?? options.OAuthState ?? null,
  };

  const data = await postJson('/Jellio/anisync/connect', body);
  return {
    connected: Boolean(data && (data.Connected ?? data.connected)),
    service: data && (data.Service || data.service),
    username: data && (data.Username ?? data.username),
    settings: data && (data.Settings || data.settings) ? normalizeAniSyncSettings(data.Settings || data.settings) : null,
  };
}

export async function disconnectAniSync(service) {
  const normalized = normalizeAniSyncService(service);
  const data = await deleteJson('/Jellio/anisync/disconnect?service=' + encodeURIComponent(normalized || service));
  return normalizeAniSyncSettings(data);
}

export async function testAniSyncConnection(service) {
  const body = {
    Service: service ? normalizeAniSyncService(service) : null,
  };
  const data = await postJson('/Jellio/anisync/test', body);
  return {
    ok: Boolean(data && (data.Ok ?? data.ok)),
    message: (data && (data.Message || data.message)) || '',
    settings: data && (data.Settings || data.settings) ? normalizeAniSyncSettings(data.Settings || data.settings) : null,
  };
}

export async function syncAniSyncNow(options) {
  const opts = options || {};
  const body = {
    Service: opts.service ? normalizeAniSyncService(opts.service) : null,
    Limit: typeof opts.limit === 'number' ? opts.limit : 5,
    Range: opts.range || null,
  };
  const data = await postJson('/Jellio/anisync/sync-now', body);
  return {
    syncedCount: Number(data && (data.SyncedCount ?? data.syncedCount)) || 0,
    failedCount: Number(data && (data.FailedCount ?? data.failedCount)) || 0,
    message: (data && (data.Message || data.message)) || '',
    settings: data && (data.Settings || data.settings) ? normalizeAniSyncSettings(data.Settings || data.settings) : null,
  };
}

export async function startAniSyncOAuth(service, redirectUri, clientId) {
  const normalized = normalizeAniSyncService(service);
  const params = new URLSearchParams({ service: normalized || service });
  if (redirectUri) params.set('redirectUri', redirectUri);
  if (clientId) params.set('clientId', clientId);
  const data = await getJson('/Jellio/anisync/oauth/start?' + params.toString());
  return {
    service: data && (data.Service || data.service),
    authorizeUrl: (data && (data.AuthorizeUrl || data.authorizeUrl)) || '',
    state: (data && (data.State || data.state)) || '',
    redirectUri: (data && (data.RedirectUri || data.redirectUri)) || '',
    hasClientId: Boolean(data && (data.HasClientId ?? data.hasClientId)),
  };
}

export async function startSimklPin(clientId) {
  const body = {
    ClientId: clientId || null,
  };
  const data = await postJson('/Jellio/anisync/simkl/pin', body);
  return {
    userCode: (data && (data.UserCode || data.userCode)) || '',
    verificationUrl: (data && (data.VerificationUrl || data.verificationUrl)) || 'https://simkl.com/pin',
    expiresIn: Number(data && (data.ExpiresIn ?? data.expiresIn)) || 900,
    interval: Number(data && (data.Interval ?? data.interval)) || 5,
  };
}

export async function pollSimklPin(userCode, clientId) {
  const body = {
    UserCode: userCode,
    ClientId: clientId || null,
  };
  const data = await postJson('/Jellio/anisync/simkl/pin/poll', body);
  return {
    approved: Boolean(data && (data.Approved ?? data.approved)),
    pending: Boolean(data && (data.Pending ?? data.pending)),
    username: (data && (data.Username ?? data.username)) || null,
    message: (data && (data.Message || data.message)) || '',
    settings: data && (data.Settings || data.settings) ? normalizeAniSyncSettings(data.Settings || data.settings) : null,
  };
}
