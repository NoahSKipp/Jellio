using System;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellio.Services.Manga;

public record TrackEntry(string? Status, int Progress, int ScoreRaw, int? Total);

/// <summary>
/// A reader's AniList list (Mihon's tracker): who the token belongs to,
/// where a series stands on their list, and saving status, score and the
/// chapters read. The token is the reader's own and never leaves the
/// server.
/// </summary>
public class AniListTrackerClient(IHttpClientFactory httpClientFactory, ILogger<AniListTrackerClient> logger)
{
    public static readonly string[] Statuses = ["CURRENT", "PLANNING", "COMPLETED", "DROPPED", "PAUSED", "REPEATING"];

    private async Task<JsonNode?> QueryAsync(string token, string query, JsonObject variables, CancellationToken cancellationToken)
    {
        try
        {
            var client = httpClientFactory.CreateClient(nameof(AniListClient));
            using var request = new HttpRequestMessage(HttpMethod.Post, "https://graphql.anilist.co");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            request.Headers.TryAddWithoutValidation("Accept", "application/json");
            request.Content = new StringContent(
                new JsonObject { ["query"] = query, ["variables"] = variables }.ToJsonString(),
                Encoding.UTF8,
                "application/json");
            using var response = await client.SendAsync(request, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                logger.LogWarning("Jellio: AniList tracker request failed, {StatusCode}", response.StatusCode);
                return null;
            }

            var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            return JsonNode.Parse(body)?["data"];
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: AniList tracker request threw");
            return null;
        }
    }

    public async Task<string?> GetViewerNameAsync(string token, CancellationToken cancellationToken)
    {
        var data = await QueryAsync(token, "query { Viewer { name } }", new JsonObject(), cancellationToken).ConfigureAwait(false);
        return data?["Viewer"]?["name"]?.GetValue<string>();
    }

    public async Task<TrackEntry?> GetEntryAsync(string token, int mediaId, CancellationToken cancellationToken)
    {
        var data = await QueryAsync(
            token,
            "query ($id: Int) { Media(id: $id, type: MANGA) { chapters mediaListEntry { status progress scoreRaw } } }",
            new JsonObject { ["id"] = mediaId },
            cancellationToken).ConfigureAwait(false);
        var media = data?["Media"];
        if (media is null)
        {
            return null;
        }

        var entry = media["mediaListEntry"];
        return new TrackEntry(
            entry?["status"]?.GetValue<string>(),
            ReadInt(entry?["progress"]) ?? 0,
            ReadInt(entry?["scoreRaw"]) ?? 0,
            ReadInt(media["chapters"]));
    }

    // Only what's given changes: a null status, progress or score is
    // left as it is on AniList.
    public async Task<TrackEntry?> SaveAsync(string token, int mediaId, string? status, int? progress, int? scoreRaw, CancellationToken cancellationToken)
    {
        var variables = new JsonObject { ["mediaId"] = mediaId };
        if (status is not null)
        {
            variables["status"] = status;
        }

        if (progress is not null)
        {
            variables["progress"] = progress;
        }

        if (scoreRaw is not null)
        {
            variables["scoreRaw"] = scoreRaw;
        }

        var data = await QueryAsync(
            token,
            "mutation ($mediaId: Int, $status: MediaListStatus, $progress: Int, $scoreRaw: Int) { SaveMediaListEntry(mediaId: $mediaId, status: $status, progress: $progress, scoreRaw: $scoreRaw) { status progress scoreRaw } }",
            variables,
            cancellationToken).ConfigureAwait(false);
        var saved = data?["SaveMediaListEntry"];
        if (saved is null)
        {
            return null;
        }

        return new TrackEntry(
            saved["status"]?.GetValue<string>(),
            ReadInt(saved["progress"]) ?? 0,
            ReadInt(saved["scoreRaw"]) ?? 0,
            null);
    }

    private static int? ReadInt(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue<int>(out var number) ? number : null;
}
