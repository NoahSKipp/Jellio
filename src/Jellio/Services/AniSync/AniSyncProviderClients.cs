using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellio.Services.AniSync;

public record AniSyncVerifyResult(
    bool Success,
    string? Username,
    string? ExternalUserId,
    string? ErrorMessage);

public record AniSyncTokenExchangeResult(
    bool Success,
    string? AccessToken,
    string? RefreshToken,
    DateTime? ExpiresAtUtc,
    string? ErrorMessage);

public record AniSyncSimklPinStartResult(
    bool Success,
    string? UserCode,
    string? VerificationUrl,
    int ExpiresIn,
    int Interval,
    string? ErrorMessage);

public record AniSyncSimklPinPollResult(
    bool Approved,
    bool Pending,
    string? AccessToken,
    string? ErrorMessage);

public record AniSyncSyncTarget(
    string Title,
    string? OriginalTitle,
    int? ProductionYear,
    int? SeasonNumber,
    int? EpisodeNumber,
    bool IsMovie,
    bool IsCompleted,
    Dictionary<string, string> ProviderIds);

public record AniSyncSyncOutcome(
    bool Success,
    bool Skipped,
    string? ResolvedMediaId,
    string Message,
    string? NewAccessToken = null,
    string? NewRefreshToken = null,
    DateTime? NewExpiresAtUtc = null);

public class AniSyncProviderClients(
    IHttpClientFactory httpClientFactory,
    ILogger<AniSyncProviderClients> logger)
{
    private const string ShikimoriUserAgent = "Jellio-AniSync/1.0 (https://github.com/NoahSKipp/Jellio)";

    public async Task<AniSyncVerifyResult> VerifyAsync(
        string service,
        string accessToken,
        string? clientId,
        CancellationToken ct)
    {
        return service switch
        {
            AniSyncServices.AniList => await VerifyAniListAsync(accessToken, ct).ConfigureAwait(false),
            AniSyncServices.MyAnimeList => await VerifyMalAsync(accessToken, clientId, ct).ConfigureAwait(false),
            AniSyncServices.Shikimori => await VerifyShikimoriAsync(accessToken, ct).ConfigureAwait(false),
            AniSyncServices.Simkl => await VerifySimklAsync(accessToken, clientId, ct).ConfigureAwait(false),
            _ => new AniSyncVerifyResult(false, null, null, "Unsupported service."),
        };
    }

    public async Task<AniSyncTokenExchangeResult> ExchangeCodeAsync(
        string service,
        string code,
        string? redirectUri,
        string? clientId,
        string? clientSecret,
        string? pkceVerifier,
        CancellationToken ct)
    {
        try
        {
            var client = httpClientFactory.CreateClient();
            if (service == AniSyncServices.MyAnimeList)
            {
                if (string.IsNullOrWhiteSpace(clientId))
                {
                    return new AniSyncTokenExchangeResult(false, null, null, null, "MyAnimeList requires a Client ID to exchange an auth code.");
                }

                var form = new Dictionary<string, string>
                {
                    ["client_id"] = clientId.Trim(),
                    ["code"] = code.Trim(),
                    ["grant_type"] = "authorization_code",
                };
                if (!string.IsNullOrWhiteSpace(pkceVerifier))
                {
                    form["code_verifier"] = pkceVerifier.Trim();
                }

                if (!string.IsNullOrWhiteSpace(clientSecret))
                {
                    form["client_secret"] = clientSecret.Trim();
                }

                if (!string.IsNullOrWhiteSpace(redirectUri))
                {
                    form["redirect_uri"] = redirectUri.Trim();
                }

                using var resp = await client.PostAsync("https://myanimelist.net/v1/oauth2/token", new FormUrlEncodedContent(form), ct).ConfigureAwait(false);
                var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
                if (!resp.IsSuccessStatusCode)
                {
                    return new AniSyncTokenExchangeResult(false, null, null, null, $"MyAnimeList rejected authorization code ({(int)resp.StatusCode}).");
                }

                return ParseOAuthTokenJson(body);
            }

            if (service == AniSyncServices.Shikimori)
            {
                if (string.IsNullOrWhiteSpace(clientId) || string.IsNullOrWhiteSpace(clientSecret))
                {
                    return new AniSyncTokenExchangeResult(false, null, null, null, "Shikimori requires both Client ID and Client Secret to exchange an auth code.");
                }

                var form = new Dictionary<string, string>
                {
                    ["grant_type"] = "authorization_code",
                    ["client_id"] = clientId.Trim(),
                    ["client_secret"] = clientSecret.Trim(),
                    ["code"] = code.Trim(),
                    ["redirect_uri"] = string.IsNullOrWhiteSpace(redirectUri) ? "urn:ietf:wg:oauth:2.0:oob" : redirectUri.Trim(),
                };

                using var req = new HttpRequestMessage(HttpMethod.Post, "https://shikimori.one/oauth/token")
                {
                    Content = new FormUrlEncodedContent(form),
                };
                req.Headers.TryAddWithoutValidation("User-Agent", ShikimoriUserAgent);
                using var resp = await client.SendAsync(req, ct).ConfigureAwait(false);
                var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
                if (!resp.IsSuccessStatusCode)
                {
                    return new AniSyncTokenExchangeResult(false, null, null, null, $"Shikimori rejected authorization code ({(int)resp.StatusCode}).");
                }

                return ParseOAuthTokenJson(body);
            }

            if (service == AniSyncServices.Simkl)
            {
                if (string.IsNullOrWhiteSpace(clientId) || string.IsNullOrWhiteSpace(clientSecret))
                {
                    return new AniSyncTokenExchangeResult(false, null, null, null, "Simkl requires Client ID and Client Secret to exchange an auth code.");
                }

                var payload = new JsonObject
                {
                    ["code"] = code.Trim(),
                    ["client_id"] = clientId.Trim(),
                    ["client_secret"] = clientSecret.Trim(),
                    ["redirect_uri"] = redirectUri ?? string.Empty,
                    ["grant_type"] = "authorization_code",
                };
                using var req = new HttpRequestMessage(HttpMethod.Post, "https://api.simkl.com/oauth/token")
                {
                    Content = new StringContent(payload.ToJsonString(), Encoding.UTF8, "application/json"),
                };
                using var resp = await client.SendAsync(req, ct).ConfigureAwait(false);
                var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
                if (!resp.IsSuccessStatusCode)
                {
                    return new AniSyncTokenExchangeResult(false, null, null, null, $"Simkl rejected authorization code ({(int)resp.StatusCode}).");
                }

                return ParseOAuthTokenJson(body);
            }

            if (service == AniSyncServices.AniList)
            {
                if (string.IsNullOrWhiteSpace(clientId) || string.IsNullOrWhiteSpace(clientSecret))
                {
                    return new AniSyncTokenExchangeResult(false, null, null, null, "AniList requires Client ID and Client Secret to exchange an auth code, or paste an Access Token directly.");
                }

                var payload = new JsonObject
                {
                    ["grant_type"] = "authorization_code",
                    ["client_id"] = clientId.Trim(),
                    ["client_secret"] = clientSecret.Trim(),
                    ["redirect_uri"] = redirectUri ?? "https://anilist.co/api/v2/oauth/pin",
                    ["code"] = code.Trim(),
                };
                using var req = new HttpRequestMessage(HttpMethod.Post, "https://anilist.co/api/v2/oauth/token")
                {
                    Content = new StringContent(payload.ToJsonString(), Encoding.UTF8, "application/json"),
                };
                req.Headers.TryAddWithoutValidation("Accept", "application/json");
                using var resp = await client.SendAsync(req, ct).ConfigureAwait(false);
                var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
                if (!resp.IsSuccessStatusCode)
                {
                    return new AniSyncTokenExchangeResult(false, null, null, null, $"AniList rejected authorization code ({(int)resp.StatusCode}).");
                }

                return ParseOAuthTokenJson(body);
            }

            return new AniSyncTokenExchangeResult(false, null, null, null, "Unsupported service.");
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio Ani-Sync: auth code exchange failed for {Service}", service);
            return new AniSyncTokenExchangeResult(false, null, null, null, "Could not reach authentication server.");
        }
    }

    public async Task<AniSyncTokenExchangeResult> TryRefreshTokenAsync(
        string service,
        string refreshToken,
        string? clientId,
        string? clientSecret,
        CancellationToken ct)
    {
        try
        {
            var client = httpClientFactory.CreateClient();
            if (service == AniSyncServices.MyAnimeList && !string.IsNullOrWhiteSpace(clientId))
            {
                var form = new Dictionary<string, string>
                {
                    ["grant_type"] = "refresh_token",
                    ["refresh_token"] = refreshToken,
                    ["client_id"] = clientId,
                };
                if (!string.IsNullOrWhiteSpace(clientSecret))
                {
                    form["client_secret"] = clientSecret;
                }

                using var resp = await client.PostAsync("https://myanimelist.net/v1/oauth2/token", new FormUrlEncodedContent(form), ct).ConfigureAwait(false);
                var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
                return resp.IsSuccessStatusCode
                    ? ParseOAuthTokenJson(body)
                    : new AniSyncTokenExchangeResult(false, null, null, null, $"MAL refresh failed ({(int)resp.StatusCode}).");
            }

            if (service == AniSyncServices.Shikimori && !string.IsNullOrWhiteSpace(clientId) && !string.IsNullOrWhiteSpace(clientSecret))
            {
                var form = new Dictionary<string, string>
                {
                    ["grant_type"] = "refresh_token",
                    ["client_id"] = clientId,
                    ["client_secret"] = clientSecret,
                    ["refresh_token"] = refreshToken,
                };
                using var req = new HttpRequestMessage(HttpMethod.Post, "https://shikimori.one/oauth/token")
                {
                    Content = new FormUrlEncodedContent(form),
                };
                req.Headers.TryAddWithoutValidation("User-Agent", ShikimoriUserAgent);
                using var resp = await client.SendAsync(req, ct).ConfigureAwait(false);
                var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
                return resp.IsSuccessStatusCode
                    ? ParseOAuthTokenJson(body)
                    : new AniSyncTokenExchangeResult(false, null, null, null, $"Shikimori refresh failed ({(int)resp.StatusCode}).");
            }

            return new AniSyncTokenExchangeResult(false, null, null, null, "Refresh not supported without client credentials.");
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Jellio Ani-Sync: token refresh threw for {Service}", service);
            return new AniSyncTokenExchangeResult(false, null, null, null, "Token refresh error.");
        }
    }

    public async Task<AniSyncSimklPinStartResult> StartSimklPinAsync(string clientId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(clientId))
        {
            return new AniSyncSimklPinStartResult(false, null, null, 0, 5, "Simkl Client ID is required.");
        }

        try
        {
            var client = httpClientFactory.CreateClient();
            using var resp = await client.GetAsync(
                $"https://api.simkl.com/oauth/pin?client_id={Uri.EscapeDataString(clientId.Trim())}",
                ct).ConfigureAwait(false);
            var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            if (!resp.IsSuccessStatusCode)
            {
                return new AniSyncSimklPinStartResult(false, null, null, 0, 5, $"Simkl PIN request failed ({(int)resp.StatusCode}).");
            }

            var node = JsonNode.Parse(body);
            var userCode = node?["user_code"]?.GetValue<string>();
            var verificationUrl = node?["verification_url"]?.GetValue<string>() ?? "https://simkl.com/pin";
            var expiresIn = ReadInt(node?["expires_in"]) ?? 900;
            var interval = ReadInt(node?["interval"]) ?? 5;
            if (string.IsNullOrWhiteSpace(userCode))
            {
                return new AniSyncSimklPinStartResult(false, null, null, 0, 5, "Simkl returned an empty PIN code.");
            }

            return new AniSyncSimklPinStartResult(true, userCode, verificationUrl, expiresIn, interval, null);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio Ani-Sync: StartSimklPinAsync failed");
            return new AniSyncSimklPinStartResult(false, null, null, 0, 5, "Could not reach Simkl.");
        }
    }

    public async Task<AniSyncSimklPinPollResult> PollSimklPinAsync(string userCode, string clientId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(clientId) || string.IsNullOrWhiteSpace(userCode))
        {
            return new AniSyncSimklPinPollResult(false, false, null, "Simkl Client ID and code are required.");
        }

        try
        {
            var client = httpClientFactory.CreateClient();
            using var resp = await client.GetAsync(
                $"https://api.simkl.com/oauth/pin/{Uri.EscapeDataString(userCode.Trim())}?client_id={Uri.EscapeDataString(clientId.Trim())}",
                ct).ConfigureAwait(false);
            var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            if (!resp.IsSuccessStatusCode)
            {
                return new AniSyncSimklPinPollResult(false, false, null, $"Simkl PIN poll failed ({(int)resp.StatusCode}).");
            }

            var node = JsonNode.Parse(body);
            var result = node?["result"]?.GetValue<string>();
            var token = node?["access_token"]?.GetValue<string>();
            if (string.Equals(result, "OK", StringComparison.OrdinalIgnoreCase) && !string.IsNullOrWhiteSpace(token))
            {
                return new AniSyncSimklPinPollResult(true, false, token, null);
            }

            if (string.Equals(result, "KO", StringComparison.OrdinalIgnoreCase))
            {
                var msg = node?["message"]?.GetValue<string>() ?? "Waiting for user authorization at simkl.com/pin.";
                var expired = msg.Contains("expired", StringComparison.OrdinalIgnoreCase);
                return new AniSyncSimklPinPollResult(false, !expired, null, msg);
            }

            return new AniSyncSimklPinPollResult(false, true, null, "Waiting for authorization.");
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Jellio Ani-Sync: PollSimklPinAsync failed");
            return new AniSyncSimklPinPollResult(false, true, null, "Temporary error polling Simkl.");
        }
    }

    public async Task<AniSyncSyncOutcome> SyncProgressAsync(
        AniSyncDecryptedCredentials creds,
        string? effectiveClientId,
        string? cachedRemoteMediaId,
        AniSyncSyncTarget target,
        CancellationToken ct)
    {
        var token = creds.AccessToken;
        if (string.IsNullOrWhiteSpace(token))
        {
            return new AniSyncSyncOutcome(false, false, null, "No saved access token.");
        }

        string? newAccess = null;
        string? newRefresh = null;
        DateTime? newExpires = null;

        // Refresh proactively if we know the token is expired and have a refresh token.
        if (creds.TokenExpiresAtUtc is { } exp && exp <= DateTime.UtcNow.AddMinutes(2) && !string.IsNullOrWhiteSpace(creds.RefreshToken))
        {
            var refreshed = await TryRefreshTokenAsync(creds.Service, creds.RefreshToken, effectiveClientId ?? creds.ClientId, creds.ClientSecret, ct).ConfigureAwait(false);
            if (refreshed.Success && !string.IsNullOrWhiteSpace(refreshed.AccessToken))
            {
                token = refreshed.AccessToken;
                newAccess = refreshed.AccessToken;
                newRefresh = refreshed.RefreshToken ?? creds.RefreshToken;
                newExpires = refreshed.ExpiresAtUtc;
                creds = creds with { AccessToken = token, RefreshToken = newRefresh, TokenExpiresAtUtc = newExpires };
            }
        }

        var outcome = creds.Service switch
        {
            AniSyncServices.AniList => await SyncAniListAsync(token, cachedRemoteMediaId, target, ct).ConfigureAwait(false),
            AniSyncServices.MyAnimeList => await SyncMalAsync(token, cachedRemoteMediaId, target, ct).ConfigureAwait(false),
            AniSyncServices.Shikimori => await SyncShikimoriAsync(creds, cachedRemoteMediaId, target, ct).ConfigureAwait(false),
            AniSyncServices.Simkl => await SyncSimklAsync(token, effectiveClientId ?? creds.ClientId, target, ct).ConfigureAwait(false),
            _ => new AniSyncSyncOutcome(false, true, null, "Unsupported service."),
        };

        if (newAccess != null && outcome.NewAccessToken == null)
        {
            return outcome with
            {
                NewAccessToken = newAccess,
                NewRefreshToken = newRefresh,
                NewExpiresAtUtc = newExpires,
            };
        }

        return outcome;
    }

    // ---- AniList ----

    private async Task<AniSyncVerifyResult> VerifyAniListAsync(string token, CancellationToken ct)
    {
        try
        {
            var data = await QueryAniListAsync(token, "query { Viewer { id name } }", new JsonObject(), ct).ConfigureAwait(false);
            if (data == null)
            {
                return new AniSyncVerifyResult(false, null, null, "AniList rejected that token or could not be reached.");
            }

            var name = data["Viewer"]?["name"]?.GetValue<string>();
            var id = ReadInt(data["Viewer"]?["id"])?.ToString(CultureInfo.InvariantCulture);
            if (string.IsNullOrWhiteSpace(name))
            {
                return new AniSyncVerifyResult(false, null, null, "Could not read AniList account profile.");
            }

            return new AniSyncVerifyResult(true, name, id, null);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio Ani-Sync: AniList verification failed");
            return new AniSyncVerifyResult(false, null, null, "Could not reach AniList.");
        }
    }

    private async Task<AniSyncSyncOutcome> SyncAniListAsync(
        string token,
        string? cachedMediaId,
        AniSyncSyncTarget target,
        CancellationToken ct)
    {
        int mediaId = 0;
        if (target.ProviderIds.TryGetValue("AniList", out var explicitId) && int.TryParse(explicitId, out var parsedExplicit) && parsedExplicit > 0)
        {
            mediaId = parsedExplicit;
        }
        else if (!string.IsNullOrEmpty(cachedMediaId) && int.TryParse(cachedMediaId, out var parsedCached) && parsedCached > 0)
        {
            mediaId = parsedCached;
        }
        else
        {
            var searchQuery = BuildAnimeSearchQuery(target);
            var searchData = await QueryAniListAsync(
                token,
                "query ($search: String) { Page(perPage: 5) { media(search: $search, type: ANIME) { id episodes startDate { year } title { romaji english } } } }",
                new JsonObject { ["search"] = searchQuery },
                ct).ConfigureAwait(false);
            var list = searchData?["Page"]?["media"]?.AsArray();
            if (list == null || list.Count == 0)
            {
                return new AniSyncSyncOutcome(false, true, null, $"Could not find '{target.Title}' on AniList.");
            }

            JsonNode? best = null;
            if (target.ProductionYear is { } yr && (target.SeasonNumber is null or <= 1))
            {
                best = list.FirstOrDefault(m => ReadInt(m?["startDate"]?["year"]) == yr);
            }

            best ??= list[0];
            mediaId = ReadInt(best?["id"]) ?? 0;
        }

        if (mediaId <= 0)
        {
            return new AniSyncSyncOutcome(false, true, null, $"Could not resolve AniList ID for '{target.Title}'.");
        }

        var mediaIdStr = mediaId.ToString(CultureInfo.InvariantCulture);
        var entryData = await QueryAniListAsync(
            token,
            "query ($id: Int) { Media(id: $id) { episodes mediaListEntry { status progress } } }",
            new JsonObject { ["id"] = mediaId },
            ct).ConfigureAwait(false);

        var media = entryData?["Media"];
        if (media == null)
        {
            return new AniSyncSyncOutcome(false, false, mediaIdStr, "Failed to query AniList media entry.");
        }

        var existingProgress = ReadInt(media["mediaListEntry"]?["progress"]) ?? 0;
        var existingStatus = media["mediaListEntry"]?["status"]?.GetValue<string>();
        var totalEpisodes = ReadInt(media["episodes"]);
        var desiredProgress = target.IsMovie ? (totalEpisodes ?? 1) : Math.Max(1, target.EpisodeNumber ?? 1);

        if (desiredProgress <= existingProgress && (existingStatus == "CURRENT" || existingStatus == "COMPLETED"))
        {
            return new AniSyncSyncOutcome(true, true, mediaIdStr, $"Already at episode {existingProgress} on AniList.");
        }

        var nextStatus = (target.IsCompleted || target.IsMovie || (totalEpisodes is > 0 && desiredProgress >= totalEpisodes.Value))
            ? "COMPLETED"
            : "CURRENT";

        var savedData = await QueryAniListAsync(
            token,
            "mutation ($mediaId: Int, $status: MediaListStatus, $progress: Int) { SaveMediaListEntry(mediaId: $mediaId, status: $status, progress: $progress) { status progress } }",
            new JsonObject
            {
                ["mediaId"] = mediaId,
                ["status"] = nextStatus,
                ["progress"] = Math.Max(existingProgress, desiredProgress),
            },
            ct).ConfigureAwait(false);

        if (savedData?["SaveMediaListEntry"] == null)
        {
            return new AniSyncSyncOutcome(false, false, mediaIdStr, "AniList rejected progress update.");
        }

        return new AniSyncSyncOutcome(true, false, mediaIdStr, $"Synced episode {Math.Max(existingProgress, desiredProgress)} ({nextStatus.ToLowerInvariant()}) on AniList.");
    }

    private async Task<JsonNode?> QueryAniListAsync(string token, string query, JsonObject variables, CancellationToken ct)
    {
        var client = httpClientFactory.CreateClient();
        using var req = new HttpRequestMessage(HttpMethod.Post, "https://graphql.anilist.co");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Headers.TryAddWithoutValidation("Accept", "application/json");
        req.Content = new StringContent(
            new JsonObject { ["query"] = query, ["variables"] = variables }.ToJsonString(),
            Encoding.UTF8,
            "application/json");
        using var resp = await client.SendAsync(req, ct).ConfigureAwait(false);
        if (!resp.IsSuccessStatusCode)
        {
            return null;
        }

        var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        return JsonNode.Parse(body)?["data"];
    }

    // ---- MyAnimeList ----

    private async Task<AniSyncVerifyResult> VerifyMalAsync(string token, string? clientId, CancellationToken ct)
    {
        try
        {
            var client = httpClientFactory.CreateClient();
            using var req = new HttpRequestMessage(HttpMethod.Get, "https://api.myanimelist.net/v2/users/@me");
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            if (!string.IsNullOrWhiteSpace(clientId))
            {
                req.Headers.TryAddWithoutValidation("X-MAL-CLIENT-ID", clientId.Trim());
            }

            using var resp = await client.SendAsync(req, ct).ConfigureAwait(false);
            if (!resp.IsSuccessStatusCode)
            {
                return new AniSyncVerifyResult(false, null, null, $"MyAnimeList rejected that token ({(int)resp.StatusCode}).");
            }

            var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            var node = JsonNode.Parse(body);
            var name = node?["name"]?.GetValue<string>();
            var id = ReadInt(node?["id"])?.ToString(CultureInfo.InvariantCulture);
            return string.IsNullOrWhiteSpace(name)
                ? new AniSyncVerifyResult(false, null, null, "Could not read MyAnimeList user profile.")
                : new AniSyncVerifyResult(true, name, id, null);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio Ani-Sync: MAL verification failed");
            return new AniSyncVerifyResult(false, null, null, "Could not reach MyAnimeList.");
        }
    }

    private async Task<AniSyncSyncOutcome> SyncMalAsync(
        string token,
        string? cachedMediaId,
        AniSyncSyncTarget target,
        CancellationToken ct)
    {
        var client = httpClientFactory.CreateClient();
        int malId = 0;
        int? totalEpisodes = null;
        int existingWatched = 0;
        string? existingStatus = null;

        if (TryGetMalId(target.ProviderIds, out var explicitMal))
        {
            malId = explicitMal;
        }
        else if (!string.IsNullOrEmpty(cachedMediaId) && int.TryParse(cachedMediaId, out var parsedCached) && parsedCached > 0)
        {
            malId = parsedCached;
        }
        else
        {
            var searchQuery = BuildAnimeSearchQuery(target);
            using var searchReq = new HttpRequestMessage(
                HttpMethod.Get,
                $"https://api.myanimelist.net/v2/anime?q={Uri.EscapeDataString(searchQuery)}&limit=5&fields=num_episodes,my_list_status");
            searchReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            using var searchResp = await client.SendAsync(searchReq, ct).ConfigureAwait(false);
            if (!searchResp.IsSuccessStatusCode)
            {
                return new AniSyncSyncOutcome(false, false, null, $"MyAnimeList search failed ({(int)searchResp.StatusCode}).");
            }

            var searchJson = JsonNode.Parse(await searchResp.Content.ReadAsStringAsync(ct).ConfigureAwait(false));
            var firstNode = searchJson?["data"]?.AsArray()?.FirstOrDefault()?["node"];
            malId = ReadInt(firstNode?["id"]) ?? 0;
            totalEpisodes = ReadInt(firstNode?["num_episodes"]);
            existingWatched = ReadInt(firstNode?["my_list_status"]?["num_watched_episodes"]) ?? 0;
            existingStatus = firstNode?["my_list_status"]?["status"]?.GetValue<string>();
        }

        if (malId <= 0)
        {
            return new AniSyncSyncOutcome(false, true, null, $"Could not find '{target.Title}' on MyAnimeList.");
        }

        var malIdStr = malId.ToString(CultureInfo.InvariantCulture);

        if (totalEpisodes == null)
        {
            using var detailReq = new HttpRequestMessage(
                HttpMethod.Get,
                $"https://api.myanimelist.net/v2/anime/{malId}?fields=num_episodes,my_list_status");
            detailReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            using var detailResp = await client.SendAsync(detailReq, ct).ConfigureAwait(false);
            if (detailResp.IsSuccessStatusCode)
            {
                var detailJson = JsonNode.Parse(await detailResp.Content.ReadAsStringAsync(ct).ConfigureAwait(false));
                totalEpisodes = ReadInt(detailJson?["num_episodes"]);
                existingWatched = ReadInt(detailJson?["my_list_status"]?["num_watched_episodes"]) ?? existingWatched;
                existingStatus = detailJson?["my_list_status"]?["status"]?.GetValue<string>() ?? existingStatus;
            }
        }

        var desired = target.IsMovie ? (totalEpisodes ?? 1) : Math.Max(1, target.EpisodeNumber ?? 1);
        if (desired <= existingWatched && (existingStatus == "watching" || existingStatus == "completed"))
        {
            return new AniSyncSyncOutcome(true, true, malIdStr, $"Already at episode {existingWatched} on MyAnimeList.");
        }

        var finalEps = Math.Max(existingWatched, desired);
        var nextStatus = (target.IsCompleted || target.IsMovie || (totalEpisodes is > 0 && finalEps >= totalEpisodes.Value))
            ? "completed"
            : "watching";

        using var updateReq = new HttpRequestMessage(
            HttpMethod.Patch,
            $"https://api.myanimelist.net/v2/anime/{malId}/my_list_status")
        {
            Content = new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["status"] = nextStatus,
                ["num_watched_episodes"] = finalEps.ToString(CultureInfo.InvariantCulture),
            }),
        };
        updateReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using var updateResp = await client.SendAsync(updateReq, ct).ConfigureAwait(false);
        if (!updateResp.IsSuccessStatusCode)
        {
            return new AniSyncSyncOutcome(false, false, malIdStr, $"MyAnimeList rejected update ({(int)updateResp.StatusCode}).");
        }

        return new AniSyncSyncOutcome(true, false, malIdStr, $"Synced episode {finalEps} ({nextStatus}) on MyAnimeList.");
    }

    // ---- Shikimori ----

    private async Task<AniSyncVerifyResult> VerifyShikimoriAsync(string token, CancellationToken ct)
    {
        try
        {
            var client = httpClientFactory.CreateClient();
            using var req = new HttpRequestMessage(HttpMethod.Get, "https://shikimori.one/api/users/whoami");
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            req.Headers.TryAddWithoutValidation("User-Agent", ShikimoriUserAgent);
            using var resp = await client.SendAsync(req, ct).ConfigureAwait(false);
            if (!resp.IsSuccessStatusCode)
            {
                return new AniSyncVerifyResult(false, null, null, $"Shikimori rejected that token ({(int)resp.StatusCode}).");
            }

            var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            var node = JsonNode.Parse(body);
            var name = node?["nickname"]?.GetValue<string>();
            var id = ReadInt(node?["id"])?.ToString(CultureInfo.InvariantCulture);
            return string.IsNullOrWhiteSpace(name)
                ? new AniSyncVerifyResult(false, null, null, "Could not read Shikimori profile.")
                : new AniSyncVerifyResult(true, name, id, null);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio Ani-Sync: Shikimori verification failed");
            return new AniSyncVerifyResult(false, null, null, "Could not reach Shikimori.");
        }
    }

    private async Task<AniSyncSyncOutcome> SyncShikimoriAsync(
        AniSyncDecryptedCredentials creds,
        string? cachedMediaId,
        AniSyncSyncTarget target,
        CancellationToken ct)
    {
        var token = creds.AccessToken!;
        var client = httpClientFactory.CreateClient();

        var externalUserId = creds.ExternalUserId;
        if (string.IsNullOrWhiteSpace(externalUserId))
        {
            var whoami = await VerifyShikimoriAsync(token, ct).ConfigureAwait(false);
            if (!whoami.Success || string.IsNullOrWhiteSpace(whoami.ExternalUserId))
            {
                return new AniSyncSyncOutcome(false, false, null, whoami.ErrorMessage ?? "Could not resolve Shikimori user ID.");
            }

            externalUserId = whoami.ExternalUserId;
        }

        int animeId = 0;
        int? totalEpisodes = null;
        if (TryGetMalId(target.ProviderIds, out var explicitMal))
        {
            animeId = explicitMal;
        }
        else if (!string.IsNullOrEmpty(cachedMediaId) && int.TryParse(cachedMediaId, out var parsedCached) && parsedCached > 0)
        {
            animeId = parsedCached;
        }
        else
        {
            var searchQuery = BuildAnimeSearchQuery(target);
            using var searchReq = new HttpRequestMessage(
                HttpMethod.Get,
                $"https://shikimori.one/api/animes?search={Uri.EscapeDataString(searchQuery)}&limit=5");
            searchReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            searchReq.Headers.TryAddWithoutValidation("User-Agent", ShikimoriUserAgent);
            using var searchResp = await client.SendAsync(searchReq, ct).ConfigureAwait(false);
            if (!searchResp.IsSuccessStatusCode)
            {
                return new AniSyncSyncOutcome(false, false, null, $"Shikimori search failed ({(int)searchResp.StatusCode}).");
            }

            var arr = JsonNode.Parse(await searchResp.Content.ReadAsStringAsync(ct).ConfigureAwait(false))?.AsArray();
            var first = arr?.FirstOrDefault();
            animeId = ReadInt(first?["id"]) ?? 0;
            totalEpisodes = ReadInt(first?["episodes"]);
        }

        if (animeId <= 0)
        {
            return new AniSyncSyncOutcome(false, true, null, $"Could not find '{target.Title}' on Shikimori.");
        }

        var animeIdStr = animeId.ToString(CultureInfo.InvariantCulture);

        using var rateReq = new HttpRequestMessage(
            HttpMethod.Get,
            $"https://shikimori.one/api/v2/user_rates?user_id={Uri.EscapeDataString(externalUserId)}&target_id={animeId}&target_type=Anime");
        rateReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        rateReq.Headers.TryAddWithoutValidation("User-Agent", ShikimoriUserAgent);
        using var rateResp = await client.SendAsync(rateReq, ct).ConfigureAwait(false);

        long existingRateId = 0;
        int existingEps = 0;
        string? existingStatus = null;
        if (rateResp.IsSuccessStatusCode)
        {
            var rates = JsonNode.Parse(await rateResp.Content.ReadAsStringAsync(ct).ConfigureAwait(false))?.AsArray();
            var rate = rates?.FirstOrDefault();
            if (rate != null)
            {
                existingRateId = ReadLong(rate["id"]) ?? 0;
                existingEps = ReadInt(rate["episodes"]) ?? 0;
                existingStatus = rate["status"]?.GetValue<string>();
            }
        }

        var desired = target.IsMovie ? (totalEpisodes ?? 1) : Math.Max(1, target.EpisodeNumber ?? 1);
        if (desired <= existingEps && (existingStatus == "watching" || existingStatus == "completed"))
        {
            return new AniSyncSyncOutcome(true, true, animeIdStr, $"Already at episode {existingEps} on Shikimori.");
        }

        var finalEps = Math.Max(existingEps, desired);
        var nextStatus = (target.IsCompleted || target.IsMovie || (totalEpisodes is > 0 && finalEps >= totalEpisodes.Value))
            ? "completed"
            : "watching";

        HttpResponseMessage saveResp;
        if (existingRateId > 0)
        {
            var patchPayload = new JsonObject
            {
                ["user_rate"] = new JsonObject
                {
                    ["episodes"] = finalEps,
                    ["status"] = nextStatus,
                },
            };
            using var patchReq = new HttpRequestMessage(HttpMethod.Patch, $"https://shikimori.one/api/v2/user_rates/{existingRateId}")
            {
                Content = new StringContent(patchPayload.ToJsonString(), Encoding.UTF8, "application/json"),
            };
            patchReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            patchReq.Headers.TryAddWithoutValidation("User-Agent", ShikimoriUserAgent);
            saveResp = await client.SendAsync(patchReq, ct).ConfigureAwait(false);
        }
        else
        {
            var createPayload = new JsonObject
            {
                ["user_rate"] = new JsonObject
                {
                    ["user_id"] = long.Parse(externalUserId, CultureInfo.InvariantCulture),
                    ["target_id"] = animeId,
                    ["target_type"] = "Anime",
                    ["episodes"] = finalEps,
                    ["status"] = nextStatus,
                },
            };
            using var postReq = new HttpRequestMessage(HttpMethod.Post, "https://shikimori.one/api/v2/user_rates")
            {
                Content = new StringContent(createPayload.ToJsonString(), Encoding.UTF8, "application/json"),
            };
            postReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            postReq.Headers.TryAddWithoutValidation("User-Agent", ShikimoriUserAgent);
            saveResp = await client.SendAsync(postReq, ct).ConfigureAwait(false);
        }

        using (saveResp)
        {
            if (!saveResp.IsSuccessStatusCode)
            {
                return new AniSyncSyncOutcome(false, false, animeIdStr, $"Shikimori rejected update ({(int)saveResp.StatusCode}).");
            }
        }

        return new AniSyncSyncOutcome(true, false, animeIdStr, $"Synced episode {finalEps} ({nextStatus}) on Shikimori.");
    }

    // ---- Simkl ----

    private async Task<AniSyncVerifyResult> VerifySimklAsync(string token, string? clientId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(clientId))
        {
            return new AniSyncVerifyResult(false, null, null, "Simkl requires a Client ID (set in Jellio server plugin settings or Advanced Client ID field).");
        }

        try
        {
            var client = httpClientFactory.CreateClient();
            using var req = new HttpRequestMessage(HttpMethod.Get, "https://api.simkl.com/users/settings");
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            req.Headers.TryAddWithoutValidation("simkl-api-key", clientId.Trim());
            using var resp = await client.SendAsync(req, ct).ConfigureAwait(false);
            if (!resp.IsSuccessStatusCode)
            {
                return new AniSyncVerifyResult(false, null, null, $"Simkl rejected that token ({(int)resp.StatusCode}).");
            }

            var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            var node = JsonNode.Parse(body);
            var name = node?["user"]?["name"]?.GetValue<string>();
            var accountId = ReadInt(node?["account"]?["id"])?.ToString(CultureInfo.InvariantCulture);
            return string.IsNullOrWhiteSpace(name)
                ? new AniSyncVerifyResult(false, null, null, "Could not read Simkl account settings.")
                : new AniSyncVerifyResult(true, name, accountId, null);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio Ani-Sync: Simkl verification failed");
            return new AniSyncVerifyResult(false, null, null, "Could not reach Simkl.");
        }
    }

    private async Task<AniSyncSyncOutcome> SyncSimklAsync(
        string token,
        string? clientId,
        AniSyncSyncTarget target,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(clientId))
        {
            return new AniSyncSyncOutcome(false, false, null, "Simkl Client ID is missing.");
        }

        var ids = new JsonObject();
        if (target.ProviderIds.TryGetValue("Simkl", out var simklId) && long.TryParse(simklId, out var sId))
        {
            ids["simkl"] = sId;
        }

        if (TryGetMalId(target.ProviderIds, out var malId))
        {
            ids["mal"] = malId;
        }

        if (target.ProviderIds.TryGetValue("AniList", out var aniId) && long.TryParse(aniId, out var aId))
        {
            ids["anilist"] = aId;
        }

        if (target.ProviderIds.TryGetValue("Tmdb", out var tmdbId) && long.TryParse(tmdbId, out var tId))
        {
            ids["tmdb"] = tId;
        }

        if (target.ProviderIds.TryGetValue("Imdb", out var imdbId) && !string.IsNullOrWhiteSpace(imdbId))
        {
            ids["imdb"] = imdbId.Trim();
        }

        var payload = new JsonObject();
        if (target.IsMovie)
        {
            var movieObj = new JsonObject
            {
                ["title"] = target.Title,
                ["watched_at"] = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture),
            };
            if (target.ProductionYear is > 1900)
            {
                movieObj["year"] = target.ProductionYear.Value;
            }

            if (ids.Count > 0)
            {
                movieObj["ids"] = ids;
            }

            payload["movies"] = new JsonArray(movieObj);
        }
        else
        {
            var epNum = Math.Max(1, target.EpisodeNumber ?? 1);
            var seasonNum = target.SeasonNumber ?? 1;
            var showObj = new JsonObject
            {
                ["title"] = target.Title,
                ["seasons"] = new JsonArray(
                    new JsonObject
                    {
                        ["number"] = seasonNum,
                        ["episodes"] = new JsonArray(
                            new JsonObject
                            {
                                ["number"] = epNum,
                                ["watched_at"] = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture),
                            }),
                    }),
            };
            if (target.ProductionYear is > 1900)
            {
                showObj["year"] = target.ProductionYear.Value;
            }

            if (ids.Count > 0)
            {
                showObj["ids"] = ids;
            }

            payload["shows"] = new JsonArray(showObj);
        }

        var client = httpClientFactory.CreateClient();
        using var req = new HttpRequestMessage(HttpMethod.Post, "https://api.simkl.com/sync/history")
        {
            Content = new StringContent(payload.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Headers.TryAddWithoutValidation("simkl-api-key", clientId.Trim());

        using var resp = await client.SendAsync(req, ct).ConfigureAwait(false);
        if (!resp.IsSuccessStatusCode)
        {
            return new AniSyncSyncOutcome(false, false, null, $"Simkl sync failed ({(int)resp.StatusCode}).");
        }

        var label = target.IsMovie ? "movie watched" : $"S{target.SeasonNumber ?? 1:D2}E{target.EpisodeNumber ?? 1:D2}";
        return new AniSyncSyncOutcome(true, false, null, $"Synced {label} to Simkl.");
    }

    // ---- Helpers ----

    private static string BuildAnimeSearchQuery(AniSyncSyncTarget target)
    {
        if (target.SeasonNumber is > 1)
        {
            return $"{target.Title} Season {target.SeasonNumber.Value}";
        }

        return target.Title;
    }

    private static bool TryGetMalId(Dictionary<string, string> ids, out int malId)
    {
        malId = 0;
        foreach (var key in new[] { "Mal", "MAL", "MyAnimeList" })
        {
            if (ids.TryGetValue(key, out var val) && int.TryParse(val, out var parsed) && parsed > 0)
            {
                malId = parsed;
                return true;
            }
        }

        return false;
    }

    private static AniSyncTokenExchangeResult ParseOAuthTokenJson(string json)
    {
        var node = JsonNode.Parse(json);
        var access = node?["access_token"]?.GetValue<string>();
        var refresh = node?["refresh_token"]?.GetValue<string>();
        var expiresIn = ReadInt(node?["expires_in"]);
        DateTime? expiresAt = expiresIn is > 0 ? DateTime.UtcNow.AddSeconds(expiresIn.Value) : null;

        return string.IsNullOrWhiteSpace(access)
            ? new AniSyncTokenExchangeResult(false, null, null, null, "Provider response did not include access_token.")
            : new AniSyncTokenExchangeResult(true, access, refresh, expiresAt, null);
    }

    private static int? ReadInt(JsonNode? node)
    {
        if (node is JsonValue v)
        {
            if (v.TryGetValue<int>(out var i))
            {
                return i;
            }

            if (v.TryGetValue<long>(out var l) && l is >= int.MinValue and <= int.MaxValue)
            {
                return (int)l;
            }
        }

        return null;
    }

    private static long? ReadLong(JsonNode? node) =>
        node is JsonValue v && v.TryGetValue<long>(out var l) ? l : null;
}
