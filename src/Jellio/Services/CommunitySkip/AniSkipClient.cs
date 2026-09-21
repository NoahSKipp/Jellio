using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellio.Services.CommunitySkip;

// C# port of NuvioTV's own real AniSkipApi.kt/fetchFromAniSkip(), not
// re-derived: api.aniskip.com's own real public endpoint, no client id
// or registration of any real kind needed, keyed off a title's own real
// MyAnimeList id plus a plain episode number. Real op/ed/recap/mixed-op/
// mixed-ed skip types requested explicitly, the same real list NuvioTV
// itself asks for.
public class AniSkipClient(IHttpClientFactory httpClientFactory, ILogger<AniSkipClient> logger)
{
    private const string BaseUrl = "https://api.aniskip.com/v2/skip-times";

    public async Task<List<CommunitySkipInterval>> GetSkipTimesAsync(string malId, int episode, CancellationToken cancellationToken)
    {
        var result = new List<CommunitySkipInterval>();
        try
        {
            var url = $"{BaseUrl}/{Uri.EscapeDataString(malId)}/{episode}" +
                "?types[]=op&types[]=ed&types[]=recap&types[]=mixed-op&types[]=mixed-ed&episodeLength=0";
            var client = httpClientFactory.CreateClient();
            using var response = await client.GetAsync(url, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                return result;
            }

            var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken).ConfigureAwait(false);
            var root = document.RootElement;
            if (!root.TryGetProperty("found", out var foundElement) || foundElement.ValueKind != JsonValueKind.True)
            {
                return result;
            }

            if (!root.TryGetProperty("results", out var resultsElement) || resultsElement.ValueKind != JsonValueKind.Array)
            {
                return result;
            }

            foreach (var entry in resultsElement.EnumerateArray())
            {
                if (!entry.TryGetProperty("interval", out var interval)
                    || !interval.TryGetProperty("startTime", out var startElement)
                    || !interval.TryGetProperty("endTime", out var endElement)
                    || !entry.TryGetProperty("skipType", out var typeElement))
                {
                    continue;
                }

                var category = CategoryFor(typeElement.GetString());
                if (category is null)
                {
                    continue;
                }

                result.Add(new CommunitySkipInterval(startElement.GetDouble(), endElement.GetDouble(), category.Value, "aniskip"));
            }
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Jellio: AniSkip lookup failed for MAL {MalId} episode {Episode}", malId, episode);
        }

        return result;
    }

    private static CommunitySkipCategory? CategoryFor(string? skipType) => skipType?.ToLowerInvariant() switch
    {
        "op" or "mixed-op" => CommunitySkipCategory.Opening,
        "ed" or "mixed-ed" => CommunitySkipCategory.Ending,
        "recap" => CommunitySkipCategory.Recap,
        _ => null,
    };
}
