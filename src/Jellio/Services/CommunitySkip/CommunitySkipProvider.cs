using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using Microsoft.Extensions.Logging;

namespace Jellio.Services.CommunitySkip;

public record CommunitySkipResult(double? IntroductionStart, double? IntroductionEnd, double? CreditsStart, double? CreditsEnd);

// Orchestrates the whole real NuvioTV-style community lookup, two real
// independent sources merged by priority (the same real "first
// provider to have a category wins" shape NuvioTV's own
// mergeByPriority already uses):
//
// 1. TheIntroDB (api.theintrodb.org, its own official real Jellyfin
//    plugin's own TheIntroDbClient.cs read directly before writing
//    this): general TV/movie coverage, works anonymously straight off
//    ProviderIds.Tmdb, no id resolution round trip needed at all. Tried
//    first for exactly that reason - it answers in one real request,
//    everything below it needs at least two.
// 2. AniSkip/Anime-Skip, resolved through Simkl: anime specific
//    coverage TheIntroDB itself does not have, the exact same real
//    NuvioTV stack this file started out porting.
//
// NuvioTV's own third real source, IntroDB, is deliberately not ported
// a second time: confirmed against its own real source that its
// INTRODB_API_URL is a private, self-hosted build config value, no
// public URL this plugin could call the same way TheIntroDB's own real
// public API already can be.
public class CommunitySkipProvider(
    TheIntroDbClient theIntroDbClient,
    SimklIdResolver simklIdResolver,
    AniSkipClient aniSkipClient,
    AnimeSkipClient animeSkipClient,
    ILogger<CommunitySkipProvider> logger)
{
    public Task<CommunitySkipResult?> GetSkipIntervalsAsync(Episode episode, CancellationToken cancellationToken)
    {
        var tmdbIdString = TmdbIdFor(episode);
        return GetSkipIntervalsCoreAsync(
            tmdbIdString,
            isMovie: false,
            episode.ParentIndexNumber,
            episode.IndexNumber,
            episode.RunTimeTicks,
            allowAnimeFallback: true,
            episode.Name,
            cancellationToken);
    }

    // Movies get the exact same real TheIntroDB tier (isMovie: true skips
    // the season/episode query parameters GetSegmentsAsync itself already
    // guards on), just no Simkl/AniSkip/Anime-Skip fallback below it: that
    // whole chain is keyed on MyAnimeList/AniList's own real per-episode
    // numbering, which a standalone movie has none of.
    public Task<CommunitySkipResult?> GetSkipIntervalsForMovieAsync(BaseItem movie, CancellationToken cancellationToken)
    {
        var tmdbIdString = movie.ProviderIds.TryGetValue("Tmdb", out var id) && !string.IsNullOrWhiteSpace(id) ? id : null;
        return GetSkipIntervalsCoreAsync(
            tmdbIdString,
            isMovie: true,
            season: null,
            episode: null,
            movie.RunTimeTicks,
            allowAnimeFallback: false,
            movie.Name,
            cancellationToken);
    }

    private async Task<CommunitySkipResult?> GetSkipIntervalsCoreAsync(
        string? tmdbIdString,
        bool isMovie,
        int? season,
        int? episode,
        long? runTimeTicks,
        bool allowAnimeFallback,
        string? itemName,
        CancellationToken cancellationToken)
    {
        var tmdbId = int.TryParse(tmdbIdString, out var parsedTmdbId) ? parsedTmdbId : (int?)null;
        var durationSeconds = runTimeTicks is > 0 ? runTimeTicks.Value / (double)TimeSpan.TicksPerSecond : 0d;

        var theIntroDbIntervals = new List<CommunitySkipInterval>();
        if (tmdbId is not null && (isMovie || (season is not null && episode is not null)))
        {
            try
            {
                var durationMs = durationSeconds > 0 ? (long)(durationSeconds * 1000) : (long?)null;
                var response = await theIntroDbClient
                    .GetSegmentsAsync(tmdbId.Value, isMovie, season, episode, durationMs, cancellationToken)
                    .ConfigureAwait(false);
                theIntroDbIntervals = ConvertTheIntroDb(response, durationSeconds);
            }
            catch (Exception ex)
            {
                logger.LogDebug(ex, "Jellio: TheIntroDB lookup failed for {ItemName}", itemName);
            }
        }

        var hasBoth = theIntroDbIntervals.Any(i => i.Category == CommunitySkipCategory.Opening)
            && theIntroDbIntervals.Any(i => i.Category == CommunitySkipCategory.Ending);

        var animeIntervals = !allowAnimeFallback || hasBoth
            ? []
            : await GetAnimeIntervalsAsync(itemName, tmdbIdString, episode, cancellationToken).ConfigureAwait(false);

        var merged = MergeByPriority(theIntroDbIntervals, animeIntervals);
        if (merged.Count == 0)
        {
            return null;
        }

        var opening = merged.GetValueOrDefault(CommunitySkipCategory.Opening);
        var ending = merged.GetValueOrDefault(CommunitySkipCategory.Ending);

        logger.LogInformation(
            "Jellio: community skip data for {ItemName} - opening: {HasOpening} ({OpeningProvider}), ending: {HasEnding} ({EndingProvider})",
            itemName,
            opening is not null,
            opening?.Provider,
            ending is not null,
            ending?.Provider);

        return new CommunitySkipResult(opening?.StartSeconds, opening?.EndSeconds, ending?.StartSeconds, ending?.EndSeconds);
    }

    // TheIntroDB's own real segment validation (Api/SegmentTimestamp.cs,
    // its own real HasValidRange): intro/recap leave start_ms optional
    // (defaults to the real start of the episode) but require end_ms;
    // credits/preview require start_ms but leave end_ms optional (means
    // "runs to the real end of the media"), carried over unchanged here.
    private static List<CommunitySkipInterval> ConvertTheIntroDb(MediaResponse? response, double durationSeconds)
    {
        var result = new List<CommunitySkipInterval>();
        if (response is null)
        {
            return result;
        }

        var intro = response.Intro.FirstOrDefault();
        if (intro?.EndMs is { } introEndMs && introEndMs > 0)
        {
            var start = (intro.StartMs ?? 0) / 1000.0;
            var end = introEndMs / 1000.0;
            if (end > start)
            {
                result.Add(new CommunitySkipInterval(start, end, CommunitySkipCategory.Opening, "theintrodb"));
            }
        }

        var credits = response.Credits.FirstOrDefault();
        if (credits?.StartMs is { } creditsStartMs)
        {
            var start = creditsStartMs / 1000.0;
            var end = credits.EndMs.HasValue ? credits.EndMs.Value / 1000.0 : durationSeconds;
            if (end > start)
            {
                result.Add(new CommunitySkipInterval(start, end, CommunitySkipCategory.Ending, "theintrodb"));
            }
        }

        return result;
    }

    private async Task<List<CommunitySkipInterval>> GetAnimeIntervalsAsync(
        string? itemName,
        string? tmdbId,
        int? episodeNumber,
        CancellationToken cancellationToken)
    {
        var simklClientId = JellioPlugin.Instance?.Configuration.SimklClientId;
        if (string.IsNullOrWhiteSpace(simklClientId) || tmdbId is null || episodeNumber is null)
        {
            return [];
        }

        try
        {
            var ids = await simklIdResolver.ResolveIdsAsync("tmdb", tmdbId, simklClientId, cancellationToken).ConfigureAwait(false);
            if (ids is null || (ids.Mal is null && ids.Anilist is null))
            {
                return [];
            }

            var aniSkipIntervals = ids.Mal is not null
                ? await aniSkipClient.GetSkipTimesAsync(ids.Mal, episodeNumber.Value, cancellationToken).ConfigureAwait(false)
                : [];

            var animeSkipClientId = JellioPlugin.Instance?.Configuration.AnimeSkipClientId;
            var animeSkipIntervals = ids.Anilist is not null && !string.IsNullOrWhiteSpace(animeSkipClientId)
                ? await animeSkipClient.GetTimestampsAsync(ids.Anilist, episodeNumber.Value, animeSkipClientId, cancellationToken).ConfigureAwait(false)
                : [];

            return [.. aniSkipIntervals, .. animeSkipIntervals];
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Jellio: anime community skip lookup failed for {ItemName}", itemName);
            return [];
        }
    }

    // First provider in priority order to have a given category wins:
    // a partial real result from TheIntroDB (opening only, say) never
    // gets its own missing ending shadowed by AniSkip simply because
    // AniSkip's own real response happened to include both.
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
