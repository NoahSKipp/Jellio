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

public class CommunitySkipProvider(
    TheIntroDbClient theIntroDbClient,
    SkipMeDbClient skipMeDbClient,
    IntroDbClient introDbClient,
    TmdbExternalIdResolver tmdbExternalIdResolver,
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
            ProviderIdFor(episode, "Tvdb"),
            ProviderIdFor(episode, "Imdb"),
            TheIntroDbClient.MappingFor(episode.Series?.DisplayOrder),
            isMovie: false,
            episode.ParentIndexNumber,
            episode.IndexNumber,
            episode.RunTimeTicks,
            isTvEpisode: true,
            episode.Name,
            cancellationToken);
    }

    public Task<CommunitySkipResult?> GetSkipIntervalsForMovieAsync(BaseItem movie, CancellationToken cancellationToken)
    {
        var tmdbIdString = movie.ProviderIds.TryGetValue("Tmdb", out var id) && !string.IsNullOrWhiteSpace(id) ? id : null;
        return GetSkipIntervalsCoreAsync(
            tmdbIdString,
            ProviderIdFor(movie, "Tvdb"),
            ProviderIdFor(movie, "Imdb"),
            mapping: null,
            isMovie: true,
            season: null,
            episode: null,
            movie.RunTimeTicks,
            isTvEpisode: false,
            movie.Name,
            cancellationToken);
    }

    private async Task<CommunitySkipResult?> GetSkipIntervalsCoreAsync(
        string? tmdbIdString,
        string? tvdbId,
        string? imdbId,
        string? mapping,
        bool isMovie,
        int? season,
        int? episode,
        long? runTimeTicks,
        bool isTvEpisode,
        string? itemName,
        CancellationToken cancellationToken)
    {
        var tmdbId = int.TryParse(tmdbIdString, out var parsedTmdbId) ? parsedTmdbId : (int?)null;
        var durationSeconds = runTimeTicks is > 0 ? runTimeTicks.Value / (double)TimeSpan.TicksPerSecond : 0d;
        var hasTmdbTarget = tmdbId is not null && (isMovie || (season is not null && episode is not null));

        var tiers = new List<List<CommunitySkipInterval>>();

        var theIntroDbIds = new TheIntroDbIds(tmdbId, tvdbId, imdbId);
        var hasTheIntroDbTarget = theIntroDbIds.Any && (isMovie || (season is not null && episode is not null));
        var theIntroDbIntervals = hasTheIntroDbTarget
            ? await GetTheIntroDbIntervalsAsync(theIntroDbIds, isMovie, season, episode, mapping, durationSeconds, itemName, cancellationToken).ConfigureAwait(false)
            : [];
        tiers.Add(theIntroDbIntervals);

        var skipMeDbEnabled = JellioPlugin.Instance?.Configuration.EnableSkipMeDb ?? false;
        if (hasTmdbTarget && skipMeDbEnabled && !HasBothCategories(tiers))
        {
            var skipMeDbIntervals = await GetSkipMeDbIntervalsAsync(tmdbId!.Value, isMovie, season, episode, durationSeconds, itemName, cancellationToken).ConfigureAwait(false);
            tiers.Add(skipMeDbIntervals);
        }

        if (isTvEpisode && tmdbId is not null && season is not null && episode is not null && !HasBothCategories(tiers))
        {
            var introDbIntervals = await GetIntroDbIntervalsAsync(tmdbId.Value, season.Value, episode.Value, itemName, cancellationToken).ConfigureAwait(false);
            tiers.Add(introDbIntervals);
        }

        if (isTvEpisode && !HasBothCategories(tiers))
        {
            var animeIntervals = await GetAnimeIntervalsAsync(itemName, tmdbIdString, episode, cancellationToken).ConfigureAwait(false);
            tiers.Add(animeIntervals);
        }

        var merged = MergeByPriority(tiers.ToArray());
        if (merged.Count == 0)
        {
            logger.LogInformation("Jellio: community skip data for {ItemName} - no tier found anything", itemName);
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

    private async Task<List<CommunitySkipInterval>> GetTheIntroDbIntervalsAsync(
        TheIntroDbIds ids,
        bool isMovie,
        int? season,
        int? episode,
        string? mapping,
        double durationSeconds,
        string? itemName,
        CancellationToken cancellationToken)
    {
        try
        {
            var durationMs = durationSeconds > 0 ? (long?)(durationSeconds * 1000) : null;
            var response = await theIntroDbClient
                .GetSegmentsAsync(ids, isMovie, season, episode, mapping, durationMs, cancellationToken)
                .ConfigureAwait(false);
            return ConvertTheIntroDb(response, durationSeconds);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: TheIntroDB lookup failed for {ItemName}", itemName);
            return [];
        }
    }

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

    private async Task<List<CommunitySkipInterval>> GetSkipMeDbIntervalsAsync(
        int tmdbId,
        bool isMovie,
        int? season,
        int? episode,
        double durationSeconds,
        string? itemName,
        CancellationToken cancellationToken)
    {
        try
        {
            var durationMs = durationSeconds > 0 ? (long?)(durationSeconds * 1000) : null;
            var response = await skipMeDbClient
                .GetItemSegmentsAsync(tmdbId, isMovie ? null : season, isMovie ? null : episode, durationMs, cancellationToken)
                .ConfigureAwait(false);
            return ConvertSkipMeDb(response, durationSeconds);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: SkipMe.db lookup failed for {ItemName}", itemName);
            return [];
        }
    }

    private static List<CommunitySkipInterval> ConvertSkipMeDb(SkipMeMediaResponse? response, double durationSeconds)
    {
        var result = new List<CommunitySkipInterval>();
        if (response is null)
        {
            return result;
        }

        var intro = response.Intro.FirstOrDefault();
        if (intro?.EndMs is { } introEndMs && introEndMs > 0)
        {
            var start = intro.StartMs / 1000.0;
            var end = introEndMs / 1000.0;
            if (end > start)
            {
                result.Add(new CommunitySkipInterval(start, end, CommunitySkipCategory.Opening, "skipmedb"));
            }
        }

        var credits = response.Credits.FirstOrDefault();
        if (credits is not null)
        {
            var start = credits.StartMs / 1000.0;
            var end = credits.EndMs.HasValue ? credits.EndMs.Value / 1000.0 : durationSeconds;
            if (end > start)
            {
                result.Add(new CommunitySkipInterval(start, end, CommunitySkipCategory.Ending, "skipmedb"));
            }
        }

        return result;
    }

    private async Task<List<CommunitySkipInterval>> GetIntroDbIntervalsAsync(
        int tmdbId,
        int season,
        int episode,
        string? itemName,
        CancellationToken cancellationToken)
    {
        try
        {
            var imdbId = await tmdbExternalIdResolver.ResolveTvImdbIdAsync(tmdbId, cancellationToken).ConfigureAwait(false);
            if (imdbId is null)
            {
                logger.LogInformation(
                    "Jellio: IntroDB skipped for {ItemName} - no IMDb id resolved for TMDB id {TmdbId} (TmdbAccessToken unset, or TMDB genuinely has none on file)",
                    itemName,
                    tmdbId);
                return [];
            }

            var response = await introDbClient.GetSegmentsAsync(imdbId, season, episode, cancellationToken).ConfigureAwait(false);
            var intervals = ConvertIntroDb(response);
            logger.LogInformation(
                "Jellio: IntroDB lookup for {ItemName} (imdb {ImdbId} S{Season}E{Episode}) - found: {Found}",
                itemName,
                imdbId,
                season,
                episode,
                intervals.Count > 0);
            return intervals;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: IntroDB lookup failed for {ItemName}", itemName);
            return [];
        }
    }

    private static List<CommunitySkipInterval> ConvertIntroDb(IntroDbMediaResponse? response)
    {
        var result = new List<CommunitySkipInterval>();
        if (response is null)
        {
            return result;
        }

        if (response.Intro is { } intro && intro.EndMs > intro.StartMs)
        {
            result.Add(new CommunitySkipInterval(intro.StartMs / 1000.0, intro.EndMs / 1000.0, CommunitySkipCategory.Opening, "introdb"));
        }

        if (response.Outro is { } outro && outro.EndMs > outro.StartMs)
        {
            result.Add(new CommunitySkipInterval(outro.StartMs / 1000.0, outro.EndMs / 1000.0, CommunitySkipCategory.Ending, "introdb"));
        }

        return result;
    }

    private static bool HasBothCategories(List<List<CommunitySkipInterval>> tiers)
    {
        var hasOpening = tiers.Any(tier => tier.Any(i => i.Category == CommunitySkipCategory.Opening));
        var hasEnding = tiers.Any(tier => tier.Any(i => i.Category == CommunitySkipCategory.Ending));
        return hasOpening && hasEnding;
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
            logger.LogWarning(ex, "Jellio: anime community skip lookup failed for {ItemName}", itemName);
            return [];
        }
    }

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

    private static string? ProviderIdFor(BaseItem item, string provider)
    {
        var owner = item is Episode { Series: { } series } ? series : item;
        return owner.ProviderIds.TryGetValue(provider, out var id) && !string.IsNullOrWhiteSpace(id) ? id : null;
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
