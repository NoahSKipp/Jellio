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

// Matching: installed sources in the configured languages.
// InstalledLanguages: every language any installed source covers, so the
// UI can say when sources exist but none match.
// Total: every source Suwayomi reports; Nsfw: how many were skipped for
// the NSFW flag. An empty result can then say which of the two it was.
public record SuwayomiSourceList(IReadOnlyList<SuwayomiSource> Matching, IReadOnlyList<string> InstalledLanguages, int Total, int Nsfw);

public record SuwayomiManga(int Id, string Title, string? Author, string? Status, bool InLibrary, string? Url = null);

public record SuwayomiChapter(int Id, string Url, string Name, string? Scanlator, float ChapterNumber, bool IsDownloaded);

// A chapter as the stream shelf needs it. UploadDate: unix milliseconds.
public record SuwayomiStreamChapter(int Id, int MangaId, string Name, float ChapterNumber, string? Scanlator, bool IsDownloaded, int PageCount, int SourceOrder, long UploadDate);

public record SuwayomiLibraryManga(int Id, string Title, string? Author, string? Status, IReadOnlyList<SuwayomiStreamChapter> Chapters);

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
    private (DateTime At, string Languages, SuwayomiSourceList Sources)? _sources;

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
    public static HashSet<string> Languages()
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

    public async Task<SuwayomiSourceList?> GetSourcesAsync(CancellationToken cancellationToken)
    {
        var languages = Languages();
        var includeNsfw = JellioPlugin.Instance?.Configuration.SuwayomiIncludeNsfw ?? false;
        var languageKey = string.Join(',', languages.Order(StringComparer.Ordinal)) + (includeNsfw ? "+nsfw" : string.Empty);
        if (_sources is { } cached && cached.Languages == languageKey && DateTime.UtcNow - cached.At < SourcesTtl)
        {
            return cached.Sources;
        }

        var data = await QueryAsync("query { sources { nodes { id name lang displayName isNsfw } } }", null, cancellationToken).ConfigureAwait(false);
        if (data?["sources"]?["nodes"] is not JsonArray nodes)
        {
            return null;
        }

        var all = nodes.OfType<JsonObject>()
            .Select(node => (
                Source: new SuwayomiSource(
                    ReadLong(node["id"]),
                    ChaptarrClient.ReadString(node["displayName"]) ?? ChaptarrClient.ReadString(node["name"]) ?? "Source",
                    ChaptarrClient.ReadString(node["lang"]) ?? string.Empty),
                Nsfw: ChaptarrClient.ReadBool(node["isNsfw"]),
                RawId: node["id"]?.ToJsonString()))
            .ToList();

        // Source 0 is Suwayomi's own local-files source.
        var remote = all.Where(entry => entry.RawId is not ("\"0\"" or "0")).ToList();
        var unreadable = remote.Where(entry => entry.Source.Id == 0).ToList();
        if (unreadable.Count > 0)
        {
            logger.LogWarning("Jellio: {Count} Suwayomi sources had an unreadable id, e.g. {Id}", unreadable.Count, unreadable[0].RawId);
        }

        var installed = remote.Where(entry => (includeNsfw || !entry.Nsfw) && entry.Source.Id != 0).Select(entry => entry.Source).ToList();
        var sources = new SuwayomiSourceList(
            installed.Where(source => languages.Contains(source.Lang)).ToList(),
            installed.Select(source => source.Lang).Where(lang => lang.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase).Order(StringComparer.Ordinal).ToList(),
            remote.Count,
            includeNsfw ? 0 : remote.Count(entry => entry.Nsfw));
        logger.LogInformation(
            "Jellio: Suwayomi reports {Total} sources ({Nsfw} NSFW); {Matching} searchable for {Languages}",
            sources.Total,
            sources.Nsfw,
            sources.Matching.Count,
            languageKey);

        // Only cache a usable list: extensions installed after an empty
        // result should show up on the next search, not ten minutes later.
        _sources = sources.Matching.Count > 0 ? (DateTime.UtcNow, languageKey, sources) : null;
        return sources;
    }

    public async Task<IReadOnlyList<SuwayomiManga>?> SearchAsync(long sourceId, string query, CancellationToken cancellationToken)
    {
        const string Mutation = @"mutation ($input: FetchSourceMangaInput!) {
  fetchSourceManga(input: $input) { mangas { id title author status inLibrary url } }
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
                ChaptarrClient.ReadBool(manga["inLibrary"]),
                ChaptarrClient.ReadString(manga["url"])))
            .ToList();
    }

    // Add to Suwayomi's library (so its library updates pick up new
    // chapters), fetch the chapter list, and queue every chapter that
    // isn't downloaded yet.
    public async Task<SuwayomiRequestResult> AddAndDownloadAsync(int mangaId, CancellationToken cancellationToken)
    {
        if (!await AddToLibraryAsync(mangaId, cancellationToken).ConfigureAwait(false))
        {
            return new SuwayomiRequestResult(false, false, 0, 0, "Suwayomi could not add this series");
        }

        var chapters = await FetchChaptersAsync(mangaId, cancellationToken).ConfigureAwait(false) ?? [];
        var pending = chapters.Where(chapter => !chapter.IsDownloaded).Select(chapter => chapter.Id).ToList();
        if (pending.Count == 0)
        {
            return new SuwayomiRequestResult(true, true, 0, chapters.Count, chapters.Count == 0 ? "No chapters found on this source yet" : null);
        }

        return await EnqueueDownloadsAsync(pending, cancellationToken).ConfigureAwait(false)
            ? new SuwayomiRequestResult(true, false, pending.Count, chapters.Count, null)
            : new SuwayomiRequestResult(false, false, 0, chapters.Count, "Suwayomi could not queue the downloads");
    }

    // Add to Suwayomi's library and load its chapters, without
    // downloading anything: the shelf reads them from the source.
    public async Task<SuwayomiRequestResult> AddAndFetchAsync(int mangaId, CancellationToken cancellationToken)
    {
        if (!await AddToLibraryAsync(mangaId, cancellationToken).ConfigureAwait(false))
        {
            return new SuwayomiRequestResult(false, false, 0, 0, "Suwayomi could not add this series");
        }

        var chapters = await FetchChaptersAsync(mangaId, cancellationToken).ConfigureAwait(false) ?? [];
        _library = null;
        return new SuwayomiRequestResult(true, false, 0, chapters.Count, chapters.Count == 0 ? "No chapters found on this source yet" : null);
    }

    private const string StreamChapterFields = "id mangaId name chapterNumber scanlator isDownloaded pageCount sourceOrder uploadDate";

    // Every series in Suwayomi's library with its chapters, in one query.
    public async Task<IReadOnlyList<SuwayomiLibraryManga>?> GetLibraryWithChaptersAsync(CancellationToken cancellationToken)
    {
        var data = await QueryAsync(
            "query { mangas(condition: { inLibrary: true }) { nodes { id title author status chapters { nodes { " + StreamChapterFields + " } } } } }",
            null,
            cancellationToken).ConfigureAwait(false);
        if (data?["mangas"]?["nodes"] is not JsonArray nodes)
        {
            return null;
        }

        return nodes.OfType<JsonObject>()
            .Select(node => new SuwayomiLibraryManga(
                (int)ReadLong(node["id"]),
                ChaptarrClient.ReadString(node["title"]) ?? string.Empty,
                ChaptarrClient.ReadString(node["author"]),
                ChaptarrClient.ReadString(node["status"]),
                ReadStreamChapters(node["chapters"]?["nodes"] as JsonArray)))
            .Where(manga => manga.Id > 0 && manga.Title.Length > 0)
            .ToList();
    }

    public async Task<IReadOnlyList<SuwayomiStreamChapter>?> GetChaptersAsync(int mangaId, CancellationToken cancellationToken)
    {
        var data = await QueryAsync(
            "query ($id: Int!) { chapters(condition: { mangaId: $id }) { nodes { " + StreamChapterFields + " } } }",
            new JsonObject { ["id"] = mangaId },
            cancellationToken).ConfigureAwait(false);
        return data?["chapters"]?["nodes"] is JsonArray nodes ? ReadStreamChapters(nodes) : null;
    }

    private static List<SuwayomiStreamChapter> ReadStreamChapters(JsonArray? nodes) =>
        (nodes?.OfType<JsonObject>() ?? Enumerable.Empty<JsonObject>())
            .Select(chapter => new SuwayomiStreamChapter(
                (int)ReadLong(chapter["id"]),
                (int)ReadLong(chapter["mangaId"]),
                ChaptarrClient.ReadString(chapter["name"]) ?? string.Empty,
                chapter["chapterNumber"] is JsonValue number && number.TryGetValue<double>(out var value) ? (float)value : -1f,
                ChaptarrClient.ReadString(chapter["scanlator"]),
                ChaptarrClient.ReadBool(chapter["isDownloaded"]),
                (int)ReadLong(chapter["pageCount"]),
                (int)ReadLong(chapter["sourceOrder"]),
                ReadLong(chapter["uploadDate"])))
            .Where(chapter => chapter.Id > 0)
            .ToList();

    // The chapter's page image paths on Suwayomi (it loads them from the
    // source the first time).
    public async Task<IReadOnlyList<string>?> FetchChapterPagesAsync(int chapterId, CancellationToken cancellationToken)
    {
        const string Mutation = @"mutation ($input: FetchChapterPagesInput!) {
  fetchChapterPages(input: $input) { pages }
}";
        var data = await QueryAsync(Mutation, new JsonObject { ["input"] = new JsonObject { ["chapterId"] = chapterId } }, cancellationToken).ConfigureAwait(false);
        return (data?["fetchChapterPages"]?["pages"] as JsonArray)?
            .Select(page => ChaptarrClient.ReadString(page))
            .OfType<string>()
            .ToList();
    }

    // An image Suwayomi serves (a page or thumbnail), by path or URL.
    public async Task<(byte[] Bytes, string ContentType)?> GetImageAsync(string pathOrUrl, CancellationToken cancellationToken)
    {
        var (baseUrl, _, _) = Config();
        if (baseUrl.Length == 0)
        {
            return null;
        }

        var url = pathOrUrl.StartsWith("http", StringComparison.OrdinalIgnoreCase) ? pathOrUrl : baseUrl + (pathOrUrl.StartsWith('/') ? pathOrUrl : "/" + pathOrUrl);
        if (!url.StartsWith(baseUrl, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        try
        {
            using var response = await SendAsync(() => new HttpRequestMessage(HttpMethod.Get, url), cancellationToken).ConfigureAwait(false);
            var contentType = response.Content.Headers.ContentType?.MediaType ?? "application/octet-stream";
            if (!response.IsSuccessStatusCode)
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
            logger.LogDebug(ex, "Jellio: Suwayomi image {Url} failed", url);
            return null;
        }
    }

    public async Task<bool> AddToLibraryAsync(int mangaId, CancellationToken cancellationToken)
    {
        const string AddMutation = @"mutation ($input: UpdateMangaInput!) {
  updateManga(input: $input) { manga { id inLibrary } }
}";
        var added = await QueryAsync(
            AddMutation,
            new JsonObject { ["input"] = new JsonObject { ["id"] = mangaId, ["patch"] = new JsonObject { ["inLibrary"] = true } } },
            cancellationToken).ConfigureAwait(false);
        return added is not null;
    }

    public async Task<bool> RemoveFromLibraryAsync(int mangaId, CancellationToken cancellationToken)
    {
        const string Mutation = @"mutation ($input: UpdateMangaInput!) {
  updateManga(input: $input) { manga { id inLibrary } }
}";
        var removed = await QueryAsync(
            Mutation,
            new JsonObject { ["input"] = new JsonObject { ["id"] = mangaId, ["patch"] = new JsonObject { ["inLibrary"] = false } } },
            cancellationToken).ConfigureAwait(false);
        _library = null;
        return removed is not null;
    }

    // The chapters Suwayomi already has for a series (no source request).
    public async Task<IReadOnlyList<SuwayomiChapter>?> GetStoredChaptersAsync(int mangaId, CancellationToken cancellationToken)
    {
        var data = await QueryAsync(
            "query ($id: Int!) { chapters(condition: { mangaId: $id }) { nodes { id url name scanlator chapterNumber isDownloaded } } }",
            new JsonObject { ["id"] = mangaId },
            cancellationToken).ConfigureAwait(false);
        return ReadChapters(data?["chapters"]?["nodes"] as JsonArray);
    }

    private static List<SuwayomiChapter>? ReadChapters(JsonArray? nodes) =>
        nodes?
            .OfType<JsonObject>()
            .Select(chapter => new SuwayomiChapter(
                (int)ReadLong(chapter["id"]),
                ChaptarrClient.ReadString(chapter["url"]) ?? string.Empty,
                ChaptarrClient.ReadString(chapter["name"]) ?? string.Empty,
                ChaptarrClient.ReadString(chapter["scanlator"]),
                chapter["chapterNumber"] is JsonValue number && number.TryGetValue<double>(out var value) ? (float)value : -1f,
                ChaptarrClient.ReadBool(chapter["isDownloaded"])))
            .Where(chapter => chapter.Id > 0)
            .ToList();

    // Refreshes the chapter list from the source and returns it.
    public async Task<IReadOnlyList<SuwayomiChapter>?> FetchChaptersAsync(int mangaId, CancellationToken cancellationToken)
    {
        const string ChaptersMutation = @"mutation ($input: FetchChaptersInput!) {
  fetchChapters(input: $input) { chapters { id url name scanlator chapterNumber isDownloaded } }
}";
        var fetched = await QueryAsync(
            ChaptersMutation,
            new JsonObject { ["input"] = new JsonObject { ["mangaId"] = mangaId } },
            cancellationToken).ConfigureAwait(false);
        return ReadChapters(fetched?["fetchChapters"]?["chapters"] as JsonArray);
    }

    public async Task<bool> EnqueueDownloadsAsync(IReadOnlyCollection<int> chapterIds, CancellationToken cancellationToken)
    {
        if (chapterIds.Count == 0)
        {
            return true;
        }

        const string DownloadMutation = @"mutation ($input: EnqueueChapterDownloadsInput!) {
  enqueueChapterDownloads(input: $input) { clientMutationId }
}";
        var ids = new JsonArray();
        foreach (var id in chapterIds)
        {
            ids.Add(id);
        }

        return await QueryAsync(DownloadMutation, new JsonObject { ["input"] = new JsonObject { ["ids"] = ids } }, cancellationToken).ConfigureAwait(false) is not null;
    }

    // Every series in Suwayomi's library, { id, title }, for matching
    // downloaded series folders back to Suwayomi (covers). Cached briefly.
    private (DateTime At, IReadOnlyList<(int Id, string Title)> Library)? _library;

    public async Task<IReadOnlyList<(int Id, string Title)>?> GetLibraryAsync(CancellationToken cancellationToken)
    {
        if (_library is { } cached && DateTime.UtcNow - cached.At < TimeSpan.FromMinutes(1))
        {
            return cached.Library;
        }

        var data = await QueryAsync(
            "query { mangas(condition: { inLibrary: true }) { nodes { id title } } }",
            null,
            cancellationToken).ConfigureAwait(false);
        if (data?["mangas"]?["nodes"] is not JsonArray nodes)
        {
            return null;
        }

        var library = nodes.OfType<JsonObject>()
            .Select(node => ((int)ReadLong(node["id"]), ChaptarrClient.ReadString(node["title"]) ?? string.Empty))
            .Where(entry => entry.Item1 > 0 && entry.Item2.Length > 0)
            .ToList();
        _library = (DateTime.UtcNow, library);
        return library;
    }

    // A series by its source and the source's own URL for it (what a
    // Mihon backup records): Suwayomi's stored copy if it has one, else a
    // title search on that source, matched by URL.
    public async Task<SuwayomiManga?> FindMangaAsync(long sourceId, string url, string title, CancellationToken cancellationToken)
    {
        const string Query = @"query ($condition: MangaConditionInput) {
  mangas(condition: $condition) { nodes { id title inLibrary url } }
}";
        var stored = await QueryAsync(
            Query,
            new JsonObject
            {
                ["condition"] = new JsonObject
                {
                    ["sourceId"] = sourceId.ToString(CultureInfo.InvariantCulture),
                    ["url"] = url,
                },
            },
            cancellationToken).ConfigureAwait(false);
        var node = (stored?["mangas"]?["nodes"] as JsonArray)?.OfType<JsonObject>().FirstOrDefault();
        if (node is not null && ReadLong(node["id"]) > 0)
        {
            return new SuwayomiManga(
                (int)ReadLong(node["id"]),
                ChaptarrClient.ReadString(node["title"]) ?? title,
                null,
                null,
                ChaptarrClient.ReadBool(node["inLibrary"]),
                ChaptarrClient.ReadString(node["url"]));
        }

        var found = await SearchAsync(sourceId, title, cancellationToken).ConfigureAwait(false);
        return found?.FirstOrDefault(manga => string.Equals(manga.Url?.Trim(), url.Trim(), StringComparison.Ordinal))
            ?? found?.FirstOrDefault(manga => string.Equals(manga.Title.Trim(), title.Trim(), StringComparison.OrdinalIgnoreCase));
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
