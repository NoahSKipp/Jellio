using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellio.Services.Shelfarr;

// Shelfarr (shelfarr.org, Pedro-Revez-Silva/shelfarr, a Rails app): a
// real self-hosted "Jellyseerr for books" this plugin proxies through
// rather than reimplementing. Every shape below (routes, params, JSON
// fields) was read directly off that project's own real
// app/controllers/api/v1/*_controller.rb before writing this, not
// guessed from its docs (shelfarr-spec.md itself, checked first, only
// documents Shelfarr's own outbound calls to Prowlarr/qBittorrent, not
// this real inbound API third party clients like Jellio actually use).
// Plain classes with explicit [JsonPropertyName] throughout, same
// convention every other real client in this codebase already uses
// (TheIntroDbClient.cs's own MediaResponse/SegmentTimestamp) rather
// than trusting System.Text.Json's own default case-sensitive property
// matching against Shelfarr's own real snake_case fields.
public class ShelfarrSearchResult
{
    [JsonPropertyName("canonical_key")]
    public string? CanonicalKey { get; set; }

    [JsonPropertyName("work_id")]
    public string? WorkId { get; set; }

    [JsonPropertyName("title")]
    public string? Title { get; set; }

    [JsonPropertyName("author")]
    public string? Author { get; set; }

    [JsonPropertyName("year")]
    public string? Year { get; set; }

    [JsonPropertyName("cover_url")]
    public string? CoverUrl { get; set; }

    [JsonPropertyName("has_audiobook")]
    public bool HasAudiobook { get; set; }

    [JsonPropertyName("has_ebook")]
    public bool HasEbook { get; set; }

    [JsonPropertyName("series_name")]
    public string? SeriesName { get; set; }

    [JsonPropertyName("series_position")]
    public string? SeriesPosition { get; set; }

    [JsonPropertyName("content_kind")]
    public string? ContentKind { get; set; }
}

public class ShelfarrSearchResponse
{
    [JsonPropertyName("results")]
    public List<ShelfarrSearchResult> Results { get; set; } = [];
}

public class ShelfarrCreatedUser
{
    [JsonPropertyName("id")]
    public int Id { get; set; }

    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("username")]
    public string Username { get; set; } = string.Empty;

    [JsonPropertyName("role")]
    public string Role { get; set; } = string.Empty;
}

public class ShelfarrRequestBook
{
    [JsonPropertyName("id")]
    public int Id { get; set; }

    [JsonPropertyName("title")]
    public string Title { get; set; } = string.Empty;

    [JsonPropertyName("author")]
    public string? Author { get; set; }

    [JsonPropertyName("book_type")]
    public string BookType { get; set; } = string.Empty;

    [JsonPropertyName("content_kind")]
    public string? ContentKind { get; set; }
}

public class ShelfarrRequestUser
{
    [JsonPropertyName("id")]
    public int Id { get; set; }

    [JsonPropertyName("username")]
    public string Username { get; set; } = string.Empty;
}

public class ShelfarrRequestPayload
{
    [JsonPropertyName("id")]
    public int Id { get; set; }

    [JsonPropertyName("status")]
    public string Status { get; set; } = string.Empty;

    [JsonPropertyName("book")]
    public ShelfarrRequestBook Book { get; set; } = new();

    [JsonPropertyName("user")]
    public ShelfarrRequestUser User { get; set; } = new();
}

public class ShelfarrCreateRequestResponse
{
    [JsonPropertyName("requests")]
    public List<ShelfarrRequestPayload> Requests { get; set; } = [];

    [JsonPropertyName("queued")]
    public bool Queued { get; set; }

    [JsonPropertyName("warnings")]
    public List<string> Warnings { get; set; } = [];

    [JsonPropertyName("errors")]
    public List<string> Errors { get; set; } = [];
}

public class ShelfarrClient(IHttpClientFactory httpClientFactory, ILogger<ShelfarrClient> logger)
{
    private static bool TryGetConfig(out string baseUrl, out string apiToken)
    {
        var cfg = JellioPlugin.Instance?.Configuration;
        baseUrl = (cfg?.ShelfarrUrl ?? string.Empty).TrimEnd('/');
        apiToken = cfg?.ShelfarrApiToken ?? string.Empty;
        return !string.IsNullOrWhiteSpace(baseUrl) && !string.IsNullOrWhiteSpace(apiToken);
    }

    private HttpClient BuildClient(string apiToken)
    {
        var client = httpClientFactory.CreateClient(nameof(ShelfarrClient));
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", apiToken);
        return client;
    }

    // GET /api/v1/search?q=...&limit=...&content_kind=... (API::V1::SearchController#index,
    // confirmed directly): q is required, limit clamps 1-20 server side
    // regardless of what is asked for here, content_kind is "book"
    // (novels/nonfiction, the server's own real default) or "graphic"
    // (comics/manga - ContentKinds.rb's own real LEGACY_ALIASES also
    // accepts "comic"/"manga" and normalizes them to "graphic" itself).
    public async Task<ShelfarrSearchResponse?> SearchAsync(string query, string? contentKind, int limit, CancellationToken cancellationToken)
    {
        if (!TryGetConfig(out var baseUrl, out var apiToken) || string.IsNullOrWhiteSpace(query))
        {
            return null;
        }

        var uri = baseUrl + "/api/v1/search?q=" + Uri.EscapeDataString(query) + "&limit=" + limit;
        if (!string.IsNullOrWhiteSpace(contentKind))
        {
            uri += "&content_kind=" + Uri.EscapeDataString(contentKind);
        }

        try
        {
            var client = BuildClient(apiToken);
            using var response = await client.GetAsync(uri, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                logger.LogWarning("Jellio: Shelfarr search failed, {StatusCode} for query {Query}", response.StatusCode, query);
                return null;
            }

            return await response.Content.ReadFromJsonAsync<ShelfarrSearchResponse>(cancellationToken: cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: Shelfarr search threw for query {Query}", query);
            return null;
        }
    }

    // POST /api/v1/users (API::V1::UsersController#create, confirmed
    // directly): name/username/password all required server side, no
    // idempotent upsert on a duplicate username - 422 with
    // errors: user.errors.full_messages the real response
    // ShelfarrUserMapStore's own caller has to treat as non-fatal (a
    // real leftover Shelfarr user from a wiped local mapping file, not
    // something worth reconciling automatically here).
    public async Task<ShelfarrCreatedUser?> CreateUserAsync(string name, string username, string password, CancellationToken cancellationToken)
    {
        if (!TryGetConfig(out var baseUrl, out var apiToken))
        {
            return null;
        }

        try
        {
            var client = BuildClient(apiToken);
            using var response = await client.PostAsJsonAsync(
                baseUrl + "/api/v1/users",
                new { name, username, password },
                cancellationToken).ConfigureAwait(false);

            if (!response.IsSuccessStatusCode)
            {
                var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
                logger.LogWarning("Jellio: Shelfarr user creation failed, {StatusCode} for username {Username}: {Body}", response.StatusCode, username, body);
                return null;
            }

            return await response.Content.ReadFromJsonAsync<ShelfarrCreatedUser>(cancellationToken: cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: Shelfarr user creation threw for username {Username}", username);
            return null;
        }
    }

    // POST /api/v1/requests (API::V1::RequestsController#create,
    // confirmed directly): shelfarrUserId targets an existing Shelfarr
    // User by id (find_user's own real admin-token path, confirmed
    // directly - a non-admin token could only ever request for
    // Current.api_user, the admin-scoped token this plugin asks for in
    // its own config description is what makes targeting a different
    // user per call possible at all). externalUserId carries the real
    // Jellyfin user id through onto the request's own origin metadata
    // (created_via: "api", external_source: "jellio"), readable later
    // in Shelfarr's own request history even though ownership itself is
    // already the targeted Shelfarr user, not this field.
    public async Task<ShelfarrCreateRequestResponse?> CreateRequestAsync(
        int shelfarrUserId,
        string workId,
        string bookType,
        string? title,
        string? author,
        string? coverUrl,
        string? contentKind,
        string externalUserId,
        CancellationToken cancellationToken)
    {
        if (!TryGetConfig(out var baseUrl, out var apiToken))
        {
            return null;
        }

        try
        {
            var client = BuildClient(apiToken);
            using var response = await client.PostAsJsonAsync(
                baseUrl + "/api/v1/requests",
                new
                {
                    user_id = shelfarrUserId,
                    work_id = workId,
                    book_type = bookType,
                    title,
                    author,
                    cover_url = coverUrl,
                    content_kind = contentKind,
                    external_source = "jellio",
                    external_user_id = externalUserId,
                },
                cancellationToken).ConfigureAwait(false);

            var payload = await response.Content.ReadFromJsonAsync<ShelfarrCreateRequestResponse>(cancellationToken: cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                logger.LogWarning(
                    "Jellio: Shelfarr request creation failed, {StatusCode} for workId {WorkId}: {Errors}",
                    response.StatusCode,
                    workId,
                    payload?.Errors is { Count: > 0 } errors ? string.Join(", ", errors) : "(no error detail)");
            }

            return payload;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: Shelfarr request creation threw for workId {WorkId}", workId);
            return null;
        }
    }
}
