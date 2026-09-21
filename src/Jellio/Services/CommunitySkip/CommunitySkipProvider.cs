using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Entities.TV;
using Microsoft.Extensions.Logging;

namespace Jellio.Services.CommunitySkip;

public record CommunitySkipResult(double? IntroductionStart, double? IntroductionEnd, double? CreditsStart, double? CreditsEnd);

// Orchestrates the whole real NuvioTV-style community lookup: resolve
// this episode's own Series-level ProviderIds.Tmdb onto Simkl's own
// real MAL/AniList ids, then ask AniSkip and Anime-Skip for real
// timestamps the exact same real priority order NuvioTV's own real
// mergeByPriority already uses (AniSkip first, Anime-Skip fills
// whatever category AniSkip itself did not have) - IntroDB, the third
// real tier NuvioTV's own source also has, is deliberately not ported:
// confirmed against that real source before writing any of this, its
// own real INTRODB_API_URL is read from a real local build config file,
// a private/self-hosted real deployment with no real public URL this
// plugin could call the same way.
public class CommunitySkipProvider(
    SimklIdResolver simklIdResolver,
    AniSkipClient aniSkipClient,
    AnimeSkipClient animeSkipClient,
    ILogger<CommunitySkipProvider> logger)
{
    public async Task<CommunitySkipResult?> GetSkipIntervalsAsync(Episode episode, CancellationToken cancellationToken)
    {
        var simklClientId = JellioPlugin.Instance?.Configuration.SimklClientId;
        if (string.IsNullOrWhiteSpace(simklClientId))
        {
            return null;
        }

        var tmdbId = TmdbIdFor(episode);
        if (tmdbId is null)
        {
            return null;
        }

        var episodeNumber = episode.IndexNumber;
        if (episodeNumber is null)
        {
            return null;
        }

        try
        {
            var ids = await simklIdResolver.ResolveIdsAsync("tmdb", tmdbId, simklClientId, cancellationToken).ConfigureAwait(false);
            if (ids is null || (ids.Mal is null && ids.Anilist is null))
            {
                return null;
            }

            var aniSkipIntervals = ids.Mal is not null
                ? await aniSkipClient.GetSkipTimesAsync(ids.Mal, episodeNumber.Value, cancellationToken).ConfigureAwait(false)
                : [];

            var animeSkipClientId = JellioPlugin.Instance?.Configuration.AnimeSkipClientId;
            var animeSkipIntervals = ids.Anilist is not null && !string.IsNullOrWhiteSpace(animeSkipClientId)
                ? await animeSkipClient.GetTimestampsAsync(ids.Anilist, episodeNumber.Value, animeSkipClientId, cancellationToken).ConfigureAwait(false)
                : [];

            var merged = MergeByPriority(aniSkipIntervals, animeSkipIntervals);
            if (merged.Count == 0)
            {
                return null;
            }

            var opening = merged.GetValueOrDefault(CommunitySkipCategory.Opening);
            var ending = merged.GetValueOrDefault(CommunitySkipCategory.Ending);

            logger.LogInformation(
                "Jellio: community skip data for {EpisodeName} - opening: {HasOpening} ({OpeningProvider}), ending: {HasEnding} ({EndingProvider})",
                episode.Name,
                opening is not null,
                opening?.Provider,
                ending is not null,
                ending?.Provider);

            return new CommunitySkipResult(
                opening?.StartSeconds,
                opening?.EndSeconds,
                ending?.StartSeconds,
                ending?.EndSeconds);
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Jellio: community skip lookup failed for {EpisodeName}", episode.Name);
            return null;
        }
    }

    // First provider in priority order to have a given category wins,
    // the same real "putIfAbsent" shape NuvioTV's own mergeByPriority
    // already uses: a partial real result from AniSkip (opening only,
    // say) never gets its own missing ending shadowed by Anime-Skip
    // simply because Anime-Skip's own real response happened to include
    // both.
    private static Dictionary<CommunitySkipCategory, CommunitySkipInterval> MergeByPriority(
        params IEnumerable<CommunitySkipInterval>[] providerResults)
    {
        var chosen = new Dictionary<CommunitySkipCategory, CommunitySkipInterval>();
        foreach (var results in providerResults)
        {
            foreach (var interval in results)
            {
                chosen.TryAdd(interval.Category, interval);
            }
        }

        return chosen;
    }

    private static string? TmdbIdFor(Episode episode)
    {
        if (episode.Series?.ProviderIds is { } seriesIds && seriesIds.TryGetValue("Tmdb", out var seriesTmdbId) && !string.IsNullOrWhiteSpace(seriesTmdbId))
        {
            return seriesTmdbId;
        }

        if (episode.ProviderIds.TryGetValue("Tmdb", out var episodeTmdbId) && !string.IsNullOrWhiteSpace(episodeTmdbId))
        {
            return episodeTmdbId;
        }

        return null;
    }
}
