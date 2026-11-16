using System;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Jellio.Extensions;
using Jellio.Services.AniSync;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

[ApiController]
[Route("Jellio/anisync")]
[Authorize]
public partial class AniSyncController(
    AniSyncStore store,
    AniSyncService service,
    AniSyncProviderClients clients) : ControllerBase
{
    public record PreferencesRequest(
        string? SelectedService,
        bool? Enabled,
        bool? SyncAllConnected,
        bool? OnlyAnimeItems);

    public record ConnectRequest(
        string? Service,
        string? Username,
        string? AccessToken,
        string? RefreshToken,
        string? ClientId,
        string? ClientSecret,
        string? AuthCode,
        string? RedirectUri,
        string? OAuthState);

    public record ServiceRequest(string? Service);

    public record SyncNowRequest(string? Service, int Limit = 5);

    public record SimklPinRequest(string? ClientId);

    public record SimklPinPollRequest(string? UserCode, string? ClientId);

    [HttpGet("settings")]
    public ActionResult<AniSyncSettingsDto> GetSettings()
    {
        if (!TryUser(out var userId))
        {
            return Unauthorized();
        }

        return Ok(service.GetSanitizedSettings(userId));
    }

    [HttpPut("preferences")]
    public ActionResult<AniSyncSettingsDto> SavePreferences([FromBody] PreferencesRequest? body)
    {
        if (!TryUser(out var userId))
        {
            return Unauthorized();
        }

        if (body == null)
        {
            return BadRequest("Request body is required.");
        }

        string? normalizedService = null;
        if (!string.IsNullOrWhiteSpace(body.SelectedService))
        {
            normalizedService = AniSyncServices.Normalize(body.SelectedService);
            if (normalizedService == null)
            {
                return BadRequest("Unsupported Ani-Sync service.");
            }
        }

        store.Update(userId, record =>
        {
            if (normalizedService != null)
            {
                record.SelectedService = normalizedService;
            }

            if (body.Enabled.HasValue)
            {
                record.Enabled = body.Enabled.Value;
            }

            if (body.SyncAllConnected.HasValue)
            {
                record.SyncAllConnected = body.SyncAllConnected.Value;
            }

            if (body.OnlyAnimeItems.HasValue)
            {
                record.OnlyAnimeItems = body.OnlyAnimeItems.Value;
            }
        });

        return Ok(service.GetSanitizedSettings(userId));
    }

    [HttpPost("connect")]
    public async Task<IActionResult> Connect([FromBody] ConnectRequest? body, CancellationToken ct)
    {
        if (!TryUser(out var userId))
        {
            return Unauthorized();
        }

        if (body == null)
        {
            return BadRequest("Request body is required.");
        }

        var normalized = AniSyncServices.Normalize(body.Service);
        if (normalized == null)
        {
            return BadRequest("Unsupported Ani-Sync service. Choose AniList, MyAnimeList, Shikimori, or Simkl.");
        }

        var rawTokenOrUrl = (body.AccessToken ?? string.Empty).Trim();
        var rawCodeOrUrl = (body.AuthCode ?? string.Empty).Trim();

        // Allow pasting full OAuth callback URLs into either field.
        var extractedToken = ExtractAccessToken(rawTokenOrUrl);
        var extractedCode = !string.IsNullOrWhiteSpace(rawCodeOrUrl)
            ? (ExtractAuthCode(rawCodeOrUrl) ?? (rawCodeOrUrl.StartsWith("http", StringComparison.OrdinalIgnoreCase) ? null : rawCodeOrUrl))
            : (string.IsNullOrWhiteSpace(extractedToken) ? ExtractAuthCode(rawTokenOrUrl) : null);

        var customClientId = string.IsNullOrWhiteSpace(body.ClientId) ? null : body.ClientId.Trim();
        var customClientSecret = string.IsNullOrWhiteSpace(body.ClientSecret) ? null : body.ClientSecret.Trim();
        var existingCreds = store.GetDecryptedCredentials(userId, normalized);
        var effectiveClientId = customClientId ?? existingCreds?.ClientId ?? service.GetServerClientId(normalized);
        var effectiveClientSecret = customClientSecret ?? existingCreds?.ClientSecret ?? service.GetServerClientSecret(normalized);

        string? accessToken = extractedToken;
        string? refreshToken = string.IsNullOrWhiteSpace(body.RefreshToken) ? null : body.RefreshToken.Trim();
        DateTime? expiresAtUtc = null;

        if (!string.IsNullOrWhiteSpace(extractedCode) && string.IsNullOrWhiteSpace(accessToken))
        {
            service.TryConsumeOAuthVerifier(userId, normalized, body.OAuthState, out var verifier, out var oauthClientId);
            var exchanged = await clients.ExchangeCodeAsync(
                normalized,
                extractedCode,
                body.RedirectUri,
                effectiveClientId ?? oauthClientId,
                effectiveClientSecret,
                verifier,
                ct).ConfigureAwait(false);
            if (!exchanged.Success || string.IsNullOrWhiteSpace(exchanged.AccessToken))
            {
                return BadRequest(exchanged.ErrorMessage ?? "Authorization code exchange failed.");
            }

            accessToken = exchanged.AccessToken;
            refreshToken ??= exchanged.RefreshToken;
            expiresAtUtc = exchanged.ExpiresAtUtc;
        }

        if (string.IsNullOrWhiteSpace(accessToken) && existingCreds != null && !string.IsNullOrWhiteSpace(existingCreds.AccessToken))
        {
            accessToken = existingCreds.AccessToken;
            refreshToken ??= existingCreds.RefreshToken;
            expiresAtUtc ??= existingCreds.TokenExpiresAtUtc;
        }

        if (string.IsNullOrWhiteSpace(accessToken) || accessToken.Length < 10 || accessToken.Length > 8000 || accessToken.Any(char.IsWhiteSpace))
        {
            return BadRequest($"Please enter a valid access token or OAuth redirect URL for {AniSyncServices.DisplayName(normalized)}.");
        }

        var verified = await clients.VerifyAsync(normalized, accessToken, effectiveClientId, ct).ConfigureAwait(false);
        if (!verified.Success)
        {
            return BadRequest(verified.ErrorMessage ?? $"{AniSyncServices.DisplayName(normalized)} did not accept those credentials.");
        }

        var displayUsername = !string.IsNullOrWhiteSpace(body.Username) ? body.Username.Trim() : verified.Username;

        store.SaveProviderCredentials(
            userId,
            normalized,
            displayUsername,
            verified.ExternalUserId,
            accessToken,
            refreshToken,
            customClientId,
            customClientSecret,
            expiresAtUtc,
            makeActive: true);

        return Ok(new
        {
            Connected = true,
            Service = normalized,
            Username = displayUsername,
            Settings = service.GetSanitizedSettings(userId),
        });
    }

    [HttpDelete("disconnect")]
    public ActionResult<AniSyncSettingsDto> DisconnectQuery([FromQuery] string service) =>
        DisconnectInternal(service);

    [HttpPost("disconnect")]
    public ActionResult<AniSyncSettingsDto> DisconnectBody([FromBody] ServiceRequest? body) =>
        DisconnectInternal(body?.Service);

    [HttpPost("test")]
    public async Task<IActionResult> Test([FromBody] ServiceRequest? body, CancellationToken ct)
    {
        if (!TryUser(out var userId))
        {
            return Unauthorized();
        }

        var targetService = body?.Service ?? store.Load(userId).SelectedService;
        var (ok, message) = await service.TestConnectionAsync(userId, targetService, ct).ConfigureAwait(false);
        return Ok(new
        {
            Ok = ok,
            Message = message,
            Settings = service.GetSanitizedSettings(userId),
        });
    }

    [HttpPost("sync-now")]
    public async Task<IActionResult> SyncNow([FromBody] SyncNowRequest? body, CancellationToken ct)
    {
        if (!TryUser(out var userId))
        {
            return Unauthorized();
        }

        var (syncedCount, failedCount, message) = await service.SyncRecentWatchedAsync(
            userId,
            body?.Service,
            Math.Clamp(body?.Limit ?? 5, 1, 20),
            ct).ConfigureAwait(false);

        return Ok(new
        {
            SyncedCount = syncedCount,
            FailedCount = failedCount,
            Message = message,
            Settings = service.GetSanitizedSettings(userId),
        });
    }

    [HttpGet("oauth/start")]
    public IActionResult StartOAuth([FromQuery] string service, [FromQuery] string? redirectUri, [FromQuery] string? clientId)
    {
        if (!TryUser(out var userId))
        {
            return Unauthorized();
        }

        var normalized = AniSyncServices.Normalize(service);
        if (normalized == null)
        {
            return BadRequest("Unsupported Ani-Sync service.");
        }

        var result = this.service.BuildOAuthStartUrl(userId, normalized, redirectUri, clientId);
        return Ok(new
        {
            Service = normalized,
            result.AuthorizeUrl,
            result.State,
            result.RedirectUri,
            result.HasClientId,
        });
    }

    [HttpPost("simkl/pin")]
    public async Task<IActionResult> StartSimklPin([FromBody] SimklPinRequest? body, CancellationToken ct)
    {
        if (!TryUser(out _))
        {
            return Unauthorized();
        }

        var clientId = !string.IsNullOrWhiteSpace(body?.ClientId)
            ? body.ClientId.Trim()
            : service.GetServerClientId(AniSyncServices.Simkl);

        var started = await clients.StartSimklPinAsync(clientId ?? string.Empty, ct).ConfigureAwait(false);
        if (!started.Success)
        {
            return BadRequest(started.ErrorMessage ?? "Could not start Simkl PIN login.");
        }

        return Ok(new
        {
            started.UserCode,
            started.VerificationUrl,
            started.ExpiresIn,
            started.Interval,
        });
    }

    [HttpPost("simkl/pin/poll")]
    public async Task<IActionResult> PollSimklPin([FromBody] SimklPinPollRequest? body, CancellationToken ct)
    {
        if (!TryUser(out var userId))
        {
            return Unauthorized();
        }

        if (body == null || string.IsNullOrWhiteSpace(body.UserCode))
        {
            return BadRequest("UserCode is required.");
        }

        var customClientId = string.IsNullOrWhiteSpace(body.ClientId) ? null : body.ClientId.Trim();
        var clientId = customClientId ?? service.GetServerClientId(AniSyncServices.Simkl);
        if (string.IsNullOrWhiteSpace(clientId))
        {
            return BadRequest("Simkl Client ID is required.");
        }

        var polled = await clients.PollSimklPinAsync(body.UserCode, clientId, ct).ConfigureAwait(false);
        if (!polled.Approved || string.IsNullOrWhiteSpace(polled.AccessToken))
        {
            return Ok(new
            {
                Approved = false,
                polled.Pending,
                Message = polled.ErrorMessage ?? "Waiting for approval.",
            });
        }

        var verified = await clients.VerifyAsync(AniSyncServices.Simkl, polled.AccessToken, clientId, ct).ConfigureAwait(false);
        var username = verified.Success ? verified.Username : "Simkl User";
        store.SaveProviderCredentials(
            userId,
            AniSyncServices.Simkl,
            username,
            verified.ExternalUserId,
            polled.AccessToken,
            null,
            customClientId,
            null,
            null,
            makeActive: true);

        return Ok(new
        {
            Approved = true,
            Pending = false,
            Username = username,
            Settings = service.GetSanitizedSettings(userId),
        });
    }

    private ActionResult<AniSyncSettingsDto> DisconnectInternal(string? targetService)
    {
        if (!TryUser(out var userId))
        {
            return Unauthorized();
        }

        var normalized = AniSyncServices.Normalize(targetService);
        if (normalized == null)
        {
            return BadRequest("Unsupported Ani-Sync service.");
        }

        store.DisconnectProvider(userId, normalized);
        return Ok(service.GetSanitizedSettings(userId));
    }

    private bool TryUser(out Guid userId)
    {
        userId = Guid.Empty;
        return User.TryGetJellyfinUserId(out userId);
    }

    private static string? ExtractAccessToken(string input)
    {
        if (string.IsNullOrWhiteSpace(input))
        {
            return null;
        }

        var match = AccessTokenPattern().Match(input);
        if (match.Success)
        {
            return match.Groups[1].Value;
        }

        // If it looks like an OAuth redirect URL without access_token, do not treat URL as a token.
        if (input.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
            || input.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        return input;
    }

    private static string? ExtractAuthCode(string input)
    {
        if (string.IsNullOrWhiteSpace(input))
        {
            return null;
        }

        var match = AuthCodePattern().Match(input);
        return match.Success ? Uri.UnescapeDataString(match.Groups[1].Value) : (input.Contains("code=", StringComparison.OrdinalIgnoreCase) ? null : null);
    }

    [GeneratedRegex("(?:access_token|token)=([^&\\s#]+)", RegexOptions.CultureInvariant)]
    private static partial Regex AccessTokenPattern();

    [GeneratedRegex("[?&]code=([^&\\s#]+)", RegexOptions.CultureInvariant)]
    private static partial Regex AuthCodePattern();
}
