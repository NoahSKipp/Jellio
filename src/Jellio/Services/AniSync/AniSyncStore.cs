using System;
using System.Collections.Generic;
using System.Linq;
using MediaBrowser.Common.Configuration;

namespace Jellio.Services.AniSync;

public static class AniSyncServices
{
    public const string AniList = "anilist";
    public const string MyAnimeList = "myanimelist";
    public const string Shikimori = "shikimori";
    public const string Simkl = "simkl";

    public static readonly string[] All = [AniList, MyAnimeList, Shikimori, Simkl];

    public static string? Normalize(string? service)
    {
        if (string.IsNullOrWhiteSpace(service))
        {
            return null;
        }

        return service.Trim().ToLowerInvariant() switch
        {
            "anilist" or "al" => AniList,
            "myanimelist" or "mal" => MyAnimeList,
            "shikimori" or "shiki" => Shikimori,
            "simkl" => Simkl,
            _ => null,
        };
    }

    public static string DisplayName(string service) => service switch
    {
        AniList => "AniList",
        MyAnimeList => "MyAnimeList",
        Shikimori => "Shikimori",
        Simkl => "Simkl",
        _ => service,
    };
}

public class AniSyncEncryptedProviderRecord
{
    public string? Username { get; set; }

    public string? ExternalUserId { get; set; }

    public string? MaskedCredential { get; set; }

    public string? EncryptedAccessToken { get; set; }

    public string? EncryptedRefreshToken { get; set; }

    public string? EncryptedClientId { get; set; }

    public string? EncryptedClientSecret { get; set; }

    public DateTime? TokenExpiresAtUtc { get; set; }

    public DateTime? UpdatedAtUtc { get; set; }

    public DateTime? LastSyncAtUtc { get; set; }

    public string? LastSyncedTitle { get; set; }

    public string? LastError { get; set; }
}

public class AniSyncLogEntry
{
    public DateTime TimestampUtc { get; set; }

    public string Service { get; set; } = string.Empty;

    public string ItemTitle { get; set; } = string.Empty;

    public int? EpisodeNumber { get; set; }

    public bool Success { get; set; }

    public string Message { get; set; } = string.Empty;
}

public class AniSyncUserRecord
{
    public string SelectedService { get; set; } = AniSyncServices.AniList;

    public bool Enabled { get; set; } = true;

    public bool SyncAllConnected { get; set; }

    public bool OnlyAnimeItems { get; set; } = true;

    public Dictionary<string, AniSyncEncryptedProviderRecord> Providers { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    // Maps "seriesKey:service" -> remote numeric/string media id to skip repeat lookups.
    public Dictionary<string, string> MediaLinks { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    public List<AniSyncLogEntry> RecentLogs { get; set; } = [];
}

public record AniSyncDecryptedCredentials(
    string Service,
    string? Username,
    string? ExternalUserId,
    string? AccessToken,
    string? RefreshToken,
    string? ClientId,
    string? ClientSecret,
    DateTime? TokenExpiresAtUtc);

public class AniSyncStore(IApplicationPaths applicationPaths, AniSyncSecretProtector protector)
{
    private const int MaxLogEntries = 20;

    private readonly JsonUserStore<AniSyncUserRecord> _store =
        new(applicationPaths, "anisync", () => new AniSyncUserRecord());

    public AniSyncUserRecord Load(Guid userId) => _store.Load(userId);

    public AniSyncUserRecord Update(Guid userId, Action<AniSyncUserRecord> mutate) => _store.Update(userId, mutate);

    public void SaveProviderCredentials(
        Guid userId,
        string service,
        string? username,
        string? externalUserId,
        string accessToken,
        string? refreshToken,
        string? clientId,
        string? clientSecret,
        DateTime? expiresAtUtc,
        bool makeActive = true)
    {
        var normalized = AniSyncServices.Normalize(service)
            ?? throw new ArgumentException("Unsupported Ani-Sync service", nameof(service));

        _store.Update(userId, record =>
        {
            if (makeActive)
            {
                record.SelectedService = normalized;
            }

            if (!record.Providers.TryGetValue(normalized, out var existing))
            {
                existing = new AniSyncEncryptedProviderRecord();
            }

            existing.Username = string.IsNullOrWhiteSpace(username) ? existing.Username : username.Trim();
            existing.ExternalUserId = string.IsNullOrWhiteSpace(externalUserId) ? existing.ExternalUserId : externalUserId.Trim();
            existing.MaskedCredential = AniSyncSecretProtector.MaskSecret(accessToken);
            existing.EncryptedAccessToken = protector.Protect(accessToken, userId, normalized, "access_token");

            if (!string.IsNullOrWhiteSpace(refreshToken))
            {
                existing.EncryptedRefreshToken = protector.Protect(refreshToken.Trim(), userId, normalized, "refresh_token");
            }

            if (!string.IsNullOrWhiteSpace(clientId))
            {
                existing.EncryptedClientId = protector.Protect(clientId.Trim(), userId, normalized, "client_id");
            }

            if (!string.IsNullOrWhiteSpace(clientSecret))
            {
                existing.EncryptedClientSecret = protector.Protect(clientSecret.Trim(), userId, normalized, "client_secret");
            }

            existing.TokenExpiresAtUtc = expiresAtUtc;
            existing.UpdatedAtUtc = DateTime.UtcNow;
            existing.LastError = null;
            record.Providers[normalized] = existing;
        });
    }

    public AniSyncDecryptedCredentials? GetDecryptedCredentials(Guid userId, string service)
    {
        var normalized = AniSyncServices.Normalize(service);
        if (normalized == null)
        {
            return null;
        }

        var record = _store.Load(userId);
        if (!record.Providers.TryGetValue(normalized, out var provider))
        {
            return null;
        }

        var accessToken = protector.Unprotect(provider.EncryptedAccessToken, userId, normalized, "access_token");
        if (string.IsNullOrWhiteSpace(accessToken))
        {
            return null;
        }

        return new AniSyncDecryptedCredentials(
            normalized,
            provider.Username,
            provider.ExternalUserId,
            accessToken,
            protector.Unprotect(provider.EncryptedRefreshToken, userId, normalized, "refresh_token"),
            protector.Unprotect(provider.EncryptedClientId, userId, normalized, "client_id"),
            protector.Unprotect(provider.EncryptedClientSecret, userId, normalized, "client_secret"),
            provider.TokenExpiresAtUtc);
    }

    public void DisconnectProvider(Guid userId, string service)
    {
        var normalized = AniSyncServices.Normalize(service);
        if (normalized == null)
        {
            return;
        }

        _store.Update(userId, record =>
        {
            record.Providers.Remove(normalized);
        });
    }

    public void RecordSyncOutcome(
        Guid userId,
        string service,
        string itemTitle,
        int? episodeNumber,
        bool success,
        string message)
    {
        var normalized = AniSyncServices.Normalize(service) ?? service;
        var now = DateTime.UtcNow;

        _store.Update(userId, record =>
        {
            if (record.Providers.TryGetValue(normalized, out var provider))
            {
                if (success)
                {
                    provider.LastSyncAtUtc = now;
                    provider.LastSyncedTitle = episodeNumber is > 0 ? $"{itemTitle} (Ep {episodeNumber})" : itemTitle;
                    provider.LastError = null;
                }
                else
                {
                    provider.LastError = message;
                }
            }

            record.RecentLogs.Insert(0, new AniSyncLogEntry
            {
                TimestampUtc = now,
                Service = normalized,
                ItemTitle = itemTitle,
                EpisodeNumber = episodeNumber,
                Success = success,
                Message = message,
            });

            if (record.RecentLogs.Count > MaxLogEntries)
            {
                record.RecentLogs = record.RecentLogs.Take(MaxLogEntries).ToList();
            }
        });
    }
}
