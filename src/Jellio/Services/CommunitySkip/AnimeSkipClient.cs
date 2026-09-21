using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellio.Services.CommunitySkip;

// C# port of NuvioTV's own real AnimeSkipApi.kt/fetchFromAnimeSkip(),
// not re-derived: anime-skip.com's own real public GraphQL endpoint,
// the exact same two real queries NuvioTV itself sends (findShowsByExternalId
// against a real AniList id first, findEpisodesByShowId second), a
// real X-Client-ID header needed for either one to answer at all
// (PluginConfiguration.AnimeSkipClientId, a free real signup separate
// from Simkl's own). Anime-Skip's own real raw timestamps are single
// real points, not a start/end pair the way AniSkip's own real
// intervals already are - NuvioTV's own real fix (this file's own real
// end = the next real timestamp's own start, or "open ended" for the
// real last one) is carried over unchanged.
public class AnimeSkipClient(IHttpClientFactory httpClientFactory, ILogger<AnimeSkipClient> logger)
{
    private const string BaseUrl = "https://api.anime-skip.com/graphql";

    public async Task<List<CommunitySkipInterval>> GetTimestampsAsync(string anilistId, int episode, string clientId, CancellationToken cancellationToken)
    {
        try
        {
            var showIds = await FindShowIdsAsync(anilistId, clientId, cancellationToken).ConfigureAwait(false);
            foreach (var showId in showIds)
            {
                var result = await FindEpisodeTimestampsAsync(showId, episode, clientId, cancellationToken).ConfigureAwait(false);
                if (result.Count > 0)
                {
                    return result;
                }
            }
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Jellio: Anime-Skip lookup failed for AniList {AnilistId} episode {Episode}", anilistId, episode);
        }

        return [];
    }

    private async Task<List<string>> FindShowIdsAsync(string anilistId, string clientId, CancellationToken cancellationToken)
    {
        var query = "{ findShowsByExternalId(service: ANILIST, serviceId: \"" + anilistId + "\") { id } }";
        using var document = await QueryAsync(query, clientId, cancellationToken).ConfigureAwait(false);
        if (document is null
            || !document.RootElement.TryGetProperty("data", out var data)
            || !data.TryGetProperty("findShowsByExternalId", out var shows)
            || shows.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        return shows.EnumerateArray()
            .Select(show => show.TryGetProperty("id", out var id) ? id.GetString() : null)
            .Where(id => !string.IsNullOrEmpty(id))
            .Select(id => id!)
            .ToList();
    }

    private async Task<List<CommunitySkipInterval>> FindEpisodeTimestampsAsync(string showId, int episode, string clientId, CancellationToken cancellationToken)
    {
        var query = "{ findEpisodesByShowId(showId: \"" + showId + "\") { season number timestamps { at type { name } } } }";
        using var document = await QueryAsync(query, clientId, cancellationToken).ConfigureAwait(false);
        if (document is null
            || !document.RootElement.TryGetProperty("data", out var data)
            || !data.TryGetProperty("findEpisodesByShowId", out var episodes)
            || episodes.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        foreach (var episodeElement in episodes.EnumerateArray())
        {
            if (!episodeElement.TryGetProperty("number", out var numberElement)
                || !int.TryParse(numberElement.GetString(), out var number)
                || number != episode)
            {
                continue;
            }

            if (!episodeElement.TryGetProperty("timestamps", out var timestampsElement) || timestampsElement.ValueKind != JsonValueKind.Array)
            {
                continue;
            }

            var timestamps = timestampsElement.EnumerateArray()
                .Select(entry => (
                    At: entry.TryGetProperty("at", out var at) ? at.GetDouble() : (double?)null,
                    Name: entry.TryGetProperty("type", out var type) && type.TryGetProperty("name", out var name) ? name.GetString() : null))
                .Where(entry => entry.At is not null && entry.Name is not null)
                .OrderBy(entry => entry.At)
                .ToList();

            var result = new List<CommunitySkipInterval>();
            for (var i = 0; i < timestamps.Count; i++)
            {
                var category = CategoryFor(timestamps[i].Name!);
                if (category is null)
                {
                    continue;
                }

                var end = i + 1 < timestamps.Count ? timestamps[i + 1].At!.Value : double.MaxValue;
                result.Add(new CommunitySkipInterval(timestamps[i].At!.Value, end, category.Value, "animeskip"));
            }

            if (result.Count > 0)
            {
                return result;
            }
        }

        return [];
    }

    private async Task<JsonDocument?> QueryAsync(string query, string clientId, CancellationToken cancellationToken)
    {
        var client = httpClientFactory.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Post, BaseUrl);
        request.Headers.Add("X-Client-ID", clientId);
        var body = JsonSerializer.Serialize(new { query, variables = new Dictionary<string, string>() });
        request.Content = new StringContent(body, Encoding.UTF8, "application/json");

        using var response = await client.SendAsync(request, cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            return null;
        }

        var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        return await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken).ConfigureAwait(false);
    }

    private static CommunitySkipCategory? CategoryFor(string typeName) => typeName.ToLowerInvariant() switch
    {
        "intro" or "new intro" => CommunitySkipCategory.Opening,
        "mixed intro" => CommunitySkipCategory.Opening,
        "credits" or "new credits" => CommunitySkipCategory.Ending,
        "mixed credits" => CommunitySkipCategory.Ending,
        "recap" => CommunitySkipCategory.Recap,
        _ => null,
    };
}
