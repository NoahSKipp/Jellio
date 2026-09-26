using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Jellio.Services.Chaptarr;
using Microsoft.Extensions.Logging;

namespace Jellio.Services.Manga;

public record SuwayomiSource(long Id, string Name, string Lang);

public record SuwayomiManga(int Id, string Title, string? Author, string? Status, bool InLibrary);

public record SuwayomiSettings(bool DownloadAsCbz, bool AutoDownloadNewChapters, string? DownloadsPath);

public record SuwayomiRequestResult(bool Success, bool AlreadyInLibrary, int QueuedChapters, int TotalChapters, string? Message);

/// <summary>
/// Suwayomi-Server (the self-hosted Tachiyomi/Mihon), for manga, manhwa
/// and manhua that exist as chapters rather than published volumes.
/// Everything goes through its GraphQL API (/api/graphql); operation and
/// field names are taken from its own source (SourceMutation,
/// MangaMutation, ChapterMutation, DownloadMutation). Auth follows its
/// modes: none, basic auth (credentials on every request) or UI login
/// (a JWT from its login mutation, renewed when rejected). Its "simple
/// login" cookie mode isn't supported.
/// </summary>
public class SuwayomiClient(IHttpClientFactory httpClientFactory, ILogger<SuwayomiClient> logger)
{
    private static readonly TimeSpan SourcesTtl = TimeSpan.FromMinutes(10);

    private readonly SemaphoreSlim _loginLock = new(1, 1);
    private string? _bearerToken;
    private (DateTime At, IReadOnlyList<SuwayomiSource> Sources)? _sources;

    public static bool IsConfigured => !string.IsNullOrWhiteSpace(JellioPlugin.Instance?.Configuration.SuwayomiUrl);

    private static (string BaseUrl, string User, string Password) Config()
    {
        var cfg = JellioPlugin.Instance?.Configuration;
        return (
            (cfg?.SuwayomiUrl ?? string.Empty).Trim().TrimEnd('/'),
            (cfg?.SuwayomiUsername ?? string.Empty).Trim(),
            cfg?.SuwayomiPassword ?? string.Empty);
    }

    // The source languages to search, e.g. "en" or "en,es"; "all" (the
    // multi-language sources) is always included.
    private static HashSet<string> Languages()
    {
        var raw = JellioPlugin.Instance?.Configuration.SuwayomiLanguages;
        var langs = (string.IsNullOrWhiteSpace(raw) ? "en" : raw)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(lang => lang.ToLowerInvariant())
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        langs.Add("all");
        return langs;
    }

    public async Task<SuwayomiSettings?> GetSettingsAsync(CancellationToken cancellationToken)
    {
        var data = await QueryAsync("query { settings { downloadAsCbz autoDownloadNewChapters downloadsPath } }", null, cancellationToken).ConfigureAwait(false);
        var settings = data?["settings"];
        return settings is null
            ? null
            : new SuwayomiSettings(
                ChaptarrClient.ReadBool(settings["downloadAsCbz"]),
                ChaptarrClient.ReadBool(settings["autoDownloadNewChapters"]),
                ChaptarrClient.ReadString(settings["downloadsPath"]));
    }

    public async Task<IReadOnlyList<SuwayomiSource>?> GetSourcesAsync(CancellationToken cancellationToken)
    {
        if (_sources is { } cached && DateTime.UtcNow - cached.At < SourcesTtl)
        {
            return cached.Sources;
        }

        var data = await QueryAsync("query { sources { nodes { id name lang displayName isNsfw } } }", null, cancellationToken).ConfigureAwait(false);
        if (data?["sources"]?["nodes"] is not JsonArray nodes)
        {
            return null;
        }

        var languages = Languages();
        var sources = nodes.OfType<JsonObject>()
            .Where(node => !ChaptarrClient.ReadBool(node["isNsfw"]))
            .Select(node => new SuwayomiSource(
                ReadLong(node["id"]),
                ChaptarrClient.ReadString(node["displayName"]) ?? ChaptarrClient.ReadString(node["name"]) ?? "Source",
                ChaptarrClient.ReadString(node["lang"]) ?? string.Empty))
            // Source 0 is Suwayomi's own local-files source.
            .Where(source => source.Id != 0 && languages.Contains(source.Lang))
            .ToList();
        _sources = (DateTime.UtcNow, sources);
        return sources;
    }

    public async Task<IReadOnlyList<SuwayomiManga>?> SearchAsync(long sourceId, string query, CancellationToken cancellationToken)
    {
        const string Mutation = @"mutation ($input: FetchSourceMangaInput!) {
  fetchSourceManga(input: $input) { mangas { id title author status inLibrary } }
}";
        var variables = new JsonObject
        {
            ["input"] = new JsonObject
            {
                // Long ids travel as strings (Suwayomi's LongString scalar).
                ["source"] = sourceId.ToString(CultureInfo.InvariantCulture),
                ["type"] = "SEARCH",
                ["page"] = 1,
                ["query"] = query,
            },
        };
        var data = await QueryAsync(Mutation, variables, cancellationToken).ConfigureAwait(false);
        return (data?["fetchSourceManga"]?["mangas"] as JsonArray)?
            .OfType<JsonObject>()
            .Select(manga => new SuwayomiManga(
                (int)ReadLong(manga["id"]),
                ChaptarrClient.ReadString(manga["title"]) ?? "Untitled",
                ChaptarrClient.ReadString(manga["author"]),
                ChaptarrClient.ReadString(manga["status"]),
                ChaptarrClient.ReadBool(manga["inLibrary"])))
            .ToList();
    }

    // Add to Suwayomi's library (so its library updates pick up new
    // chapters), fetch the chapter list, and queue every chapter that
    // isn't downloaded yet.
    public async Task<SuwayomiRequestResult> AddAndDownloadAsync(int mangaId, CancellationToken cancellationToken)
    {
        const string AddMutation = @"mutation ($input: UpdateMangaInput!) {
  updateManga(input: $input) { manga { id inLibrary } }
}";
        var added = await QueryAsync(
            AddMutation,
            new JsonObject { ["input"] = new JsonObject { ["id"] = mangaId, ["patch"] = new JsonObject { ["inLibrary"] = true } } },
            cancellationToken).ConfigureAwait(false);
        if (added is null)
        {
            return new SuwayomiRequestResult(false, false, 0, 0, "Suwayomi could not add this series");
        }

        const string ChaptersMutation = @"mutation ($input: FetchChaptersInput!) {
  fetchChapters(input: $input) { chapters { id isDownloaded } }
}";
        var fetched = await QueryAsync(
            ChaptersMutation,
            new JsonObject { ["input"] = new JsonObject { ["mangaId"] = mangaId } },
            cancellationToken).ConfigureAwait(false);
        var chapters = (fetched?["fetchChapters"]?["chapters"] as JsonArray)?.OfType<JsonObject>().ToList() ?? [];
        var pending = chapters
            .Where(chapter => !ChaptarrClient.ReadBool(chapter["isDownloaded"]))
            .Select(chapter => (int)ReadLong(chapter["id"]))
            .Where(id => id > 0)
            .ToList();
        if (pending.Count == 0)
        {
            return new SuwayomiRequestResult(true, true, 0, chapters.Count, chapters.Count == 0 ? "No chapters found on this source yet" : null);
        }

        const string DownloadMutation = @"mutation ($input: EnqueueChapterDownloadsInput!) {
  enqueueChapterDownloads(input: $input) { clientMutationId }
}";
        var ids = new JsonArray();
        pending.ForEach(id => ids.Add(id));
        var queued = await QueryAsync(DownloadMutation, new JsonObject { ["input"] = new JsonObject { ["ids"] = ids } }, cancellationToken).ConfigureAwait(false);
        return queued is null
            ? new SuwayomiRequestResult(false, false, 0, chapters.Count, "Suwayomi could not queue the downloads")
            : new SuwayomiRequestResult(true, false, pending.Count, chapters.Count, null);
    }

    public async Task<(byte[] Bytes, string ContentType)?> GetThumbnailAsync(int mangaId, CancellationToken cancellationToken)
    {
        var (baseUrl, _, _) = Config();
        if (baseUrl.Length == 0)
        {
            return null;
        }

        try
        {
            using var response = await SendAsync(
                () => new HttpRequestMessage(HttpMethod.Get, baseUrl + "/api/v1/manga/" + mangaId.ToString(CultureInfo.InvariantCulture) + "/thumbnail"),
                cancellationToken).ConfigureAwait(false);
            var contentType = response.Content.Headers.ContentType?.MediaType ?? string.Empty;
            if (!response.IsSuccessStatusCode || !contentType.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
            {
                return null;
            }

            return (await response.Content.ReadAsByteArrayAsync(cancellationToken).ConfigureAwait(false), contentType);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Jellio: Suwayomi thumbnail for {MangaId} failed", mangaId);
            return null;
        }
    }

    private async Task<JsonNode?> QueryAsync(string query, JsonObject? variables, CancellationToken cancellationToken)
    {
        var (baseUrl, _, _) = Config();
        if (baseUrl.Length == 0)
        {
            return null;
        }

        var payload = new JsonObject { ["query"] = query };
        if (variables is not null)
        {
            payload["variables"] = variables;
        }

        var body = payload.ToJsonString();
        try
        {
            using var response = await SendAsync(
                () => new HttpRequestMessage(HttpMethod.Post, baseUrl + "/api/graphql")
                {
                    Content = new StringContent(body, Encoding.UTF8, "application/json"),
                },
                cancellationToken).ConfigureAwait(false);
            var text = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                logger.LogWarning("Jellio: Suwayomi GraphQL failed, {StatusCode}", response.StatusCode);
                return null;
            }

            var json = JsonNode.Parse(text);
            if (json?["errors"] is JsonArray { Count: > 0 } errors)
            {
                logger.LogWarning("Jellio: Suwayomi GraphQL error: {Message}", ChaptarrClient.ReadString(errors[0]?["message"]));
                return null;
            }

            return json?["data"];
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: Suwayomi request threw");
            return null;
        }
    }

    // Sends with whatever credentials are configured: a UI-login JWT if we
    // have one, basic auth otherwise. A 401 with credentials configured
    // means UI-login mode (or an expired token): log in and retry once.
    private async Task<HttpResponseMessage> SendAsync(Func<HttpRequestMessage> build, CancellationToken cancellationToken)
    {
        var client = httpClientFactory.CreateClient(nameof(SuwayomiClient));
        var (_, user, password) = Config();
        var request = build();
        Authorize(request, user, password);
        var response = await client.SendAsync(request, cancellationToken).ConfigureAwait(false);
        if (response.StatusCode != HttpStatusCode.Unauthorized || user.Length == 0 || !await LoginAsync(client, cancellationToken).ConfigureAwait(false))
        {
            return response;
        }

        response.Dispose();
        request.Dispose();
        var retry = build();
        Authorize(retry, user, password);
        return await client.SendAsync(retry, cancellationToken).ConfigureAwait(false);
    }

    private void Authorize(HttpRequestMessage request, string user, string password)
    {
        if (_bearerToken is not null)
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _bearerToken);
        }
        else if (user.Length > 0)
        {
            request.Headers.Authorization = new AuthenticationHeaderValue(
                "Basic",
                Convert.ToBase64String(Encoding.UTF8.GetBytes(user + ":" + password)));
        }
    }

    private async Task<bool> LoginAsync(HttpClient client, CancellationToken cancellationToken)
    {
        var (baseUrl, user, password) = Config();
        await _loginLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            _bearerToken = null;
            var payload = new JsonObject
            {
                ["query"] = "mutation ($input: LoginInput!) { login(input: $input) { accessToken } }",
                ["variables"] = new JsonObject { ["input"] = new JsonObject { ["username"] = user, ["password"] = password } },
            };
            using var request = new HttpRequestMessage(HttpMethod.Post, baseUrl + "/api/graphql")
            {
                Content = new StringContent(payload.ToJsonString(), Encoding.UTF8, "application/json"),
            };
            using var response = await client.SendAsync(request, cancellationToken).ConfigureAwait(false);
            var text = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            _bearerToken = ChaptarrClient.ReadString(JsonNode.Parse(text)?["data"]?["login"]?["accessToken"]);
            if (_bearerToken is null)
            {
                logger.LogWarning("Jellio: Suwayomi login failed; check the username and password, or its auth mode");
            }

            return _bearerToken is not null;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "Jellio: Suwayomi login threw");
            return false;
        }
        finally
        {
            _loginLock.Release();
        }
    }

    private static long ReadLong(JsonNode? node)
    {
        if (node is not JsonValue value)
        {
            return 0;
        }

        if (value.TryGetValue<long>(out var number))
        {
            return number;
        }

        return value.TryGetValue<string>(out var text) && long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed) ? parsed : 0;
    }
}
