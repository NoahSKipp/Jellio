using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellio.Services.CommunitySkip;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Logging;

namespace Jellio.Services.IntroCredits;

public class IntroCreditsBulkScanner(
    ILibraryManager libraryManager,
    CommunitySkipProvider communitySkipProvider,
    IntroCreditsAnalyzer analyzer,
    IntroCreditsStore store,
    ILogger<IntroCreditsBulkScanner> logger)
{
    public record ScanResult(int EpisodesScanned, int CommunityHits, int AnalyzerHits);

    private static readonly TimeSpan CommunityRecheckGap = TimeSpan.FromDays(3);

    public async Task<ScanResult> ScanAsync(Guid itemId, bool useAnalyzerFallback, Guid userId, CancellationToken cancellationToken)
    {
        var item = libraryManager.GetItemById(itemId);
        return item switch
        {
            Movie movie => await ScanMovieAsync(movie, cancellationToken).ConfigureAwait(false),
            Episode episode => await ScanEpisodeAsync(episode, useAnalyzerFallback, userId, cancellationToken).ConfigureAwait(false),
            Season season => await ScanSeasonAsync(season, useAnalyzerFallback, userId, cancellationToken).ConfigureAwait(false),
            Series series => await ScanSeriesAsync(series, useAnalyzerFallback, userId, cancellationToken).ConfigureAwait(false),
            _ => new ScanResult(0, 0, 0),
        };
    }

    private async Task<ScanResult> ScanMovieAsync(Movie movie, CancellationToken cancellationToken)
    {
        if (ShouldSkipCommunityLookup(movie.Id))
        {
            logger.LogInformation("Jellio: community skip scan for {MovieName} - skipped, already attempted recently", movie.Name);
            return new ScanResult(1, 0, 0);
        }

        var result = await communitySkipProvider.GetSkipIntervalsForMovieAsync(movie, cancellationToken).ConfigureAwait(false);
        var found = StoreCommunityResult(movie.Id, result);
        store.MarkCommunityAttempted(movie.Id);
        logger.LogInformation("Jellio: community skip scan for {MovieName} - found: {Found}", movie.Name, found);
        return new ScanResult(1, found ? 1 : 0, 0);
    }

    private async Task<ScanResult> ScanEpisodeAsync(Episode episode, bool useAnalyzerFallback, Guid userId, CancellationToken cancellationToken)
    {
        bool communityHit;
        if (ShouldSkipCommunityLookup(episode.Id))
        {
            logger.LogInformation("Jellio: community skip scan for {EpisodeName} - skipped, already attempted recently", episode.Name);
            communityHit = false;
        }
        else
        {
            var result = await communitySkipProvider.GetSkipIntervalsAsync(episode, cancellationToken).ConfigureAwait(false);
            communityHit = StoreCommunityResult(episode.Id, result);
            store.MarkCommunityAttempted(episode.Id);
        }

        if (communityHit || !useAnalyzerFallback || episode.SeasonId == Guid.Empty)
        {
            logger.LogInformation("Jellio: community skip scan for {EpisodeName} - found: {Found}", episode.Name, communityHit);
            return new ScanResult(1, communityHit ? 1 : 0, 0);
        }

        var beforeIntro = store.Get(episode.Id)?.IntroEndTicks is > 0;
        var beforeCredits = store.Get(episode.Id)?.CreditsEndTicks is > 0;

        await analyzer.AnalyzeSeasonAsync(episode.SeasonId, userId, cancellationToken).ConfigureAwait(false);

        var afterIntro = store.Get(episode.Id)?.IntroEndTicks is > 0;
        var afterCredits = store.Get(episode.Id)?.CreditsEndTicks is > 0;
        var analyzerHit = (afterIntro && !beforeIntro) || (afterCredits && !beforeCredits);

        logger.LogInformation("Jellio: deep skip scan for {EpisodeName} - analyzer found: {Found}", episode.Name, analyzerHit);
        return new ScanResult(1, 0, analyzerHit ? 1 : 0);
    }

    private Task<ScanResult> ScanSeasonAsync(Season season, bool useAnalyzerFallback, Guid userId, CancellationToken cancellationToken) =>
        ScanSeasonInternalAsync(season, useAnalyzerFallback, userId, cancellationToken);

    private async Task<ScanResult> ScanSeriesAsync(Series series, bool useAnalyzerFallback, Guid userId, CancellationToken cancellationToken)
    {
        var seasons = libraryManager.GetItemList(new InternalItemsQuery
        {
            ParentId = series.Id,
            IncludeItemTypes = [BaseItemKind.Season],
        }).OfType<Season>().ToList();

        var episodesScanned = 0;
        var communityHits = 0;
        var analyzerHits = 0;

        foreach (var season in seasons)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var seasonResult = await ScanSeasonInternalAsync(season, useAnalyzerFallback, userId, cancellationToken).ConfigureAwait(false);
            episodesScanned += seasonResult.EpisodesScanned;
            communityHits += seasonResult.CommunityHits;
            analyzerHits += seasonResult.AnalyzerHits;
        }

        logger.LogInformation(
            "Jellio: community skip scan for {SeriesName} - {EpisodesScanned} episode(s) scanned, {CommunityHits} from the community tier, {AnalyzerHits} from the analyzer fallback",
            series.Name,
            episodesScanned,
            communityHits,
            analyzerHits);

        return new ScanResult(episodesScanned, communityHits, analyzerHits);
    }

    private async Task<ScanResult> ScanSeasonInternalAsync(Season season, bool useAnalyzerFallback, Guid userId, CancellationToken cancellationToken)
    {
        var episodes = season.GetEpisodes().OfType<Episode>().Where(episode => episode.RunTimeTicks is > 0).ToList();
        var episodesScanned = 0;
        var communityHits = 0;
        var stillMissing = new List<Episode>();

        foreach (var episode in episodes)
        {
            cancellationToken.ThrowIfCancellationRequested();
            episodesScanned++;

            if (ShouldSkipCommunityLookup(episode.Id))
            {
                stillMissing.Add(episode);
                continue;
            }

            var result = await communitySkipProvider.GetSkipIntervalsAsync(episode, cancellationToken).ConfigureAwait(false);
            store.MarkCommunityAttempted(episode.Id);
            if (StoreCommunityResult(episode.Id, result))
            {
                communityHits++;
            }
            else
            {
                stillMissing.Add(episode);
            }
        }

        if (!useAnalyzerFallback || stillMissing.Count < 2)
        {
            return new ScanResult(episodesScanned, communityHits, 0);
        }

        var beforeIntro = stillMissing.Count(episode => store.Get(episode.Id)?.IntroEndTicks is > 0);
        var beforeCredits = stillMissing.Count(episode => store.Get(episode.Id)?.CreditsEndTicks is > 0);

        await analyzer.AnalyzeSeasonAsync(season.Id, userId, cancellationToken).ConfigureAwait(false);

        var afterIntro = stillMissing.Count(episode => store.Get(episode.Id)?.IntroEndTicks is > 0);
        var afterCredits = stillMissing.Count(episode => store.Get(episode.Id)?.CreditsEndTicks is > 0);
        var analyzerHits = Math.Max(afterIntro - beforeIntro, 0) + Math.Max(afterCredits - beforeCredits, 0);

        return new ScanResult(episodesScanned, communityHits, analyzerHits);
    }

    private bool ShouldSkipCommunityLookup(Guid itemId)
    {
        var record = store.Get(itemId);
        return record is { CommunityAttempted: true } && DateTimeOffset.UtcNow - record.CommunityAttemptedAt < CommunityRecheckGap;
    }

    private bool StoreCommunityResult(Guid itemId, CommunitySkipResult? result)
    {
        if (result is null)
        {
            return false;
        }

        var found = false;
        if (result.IntroductionStart is { } introStart && result.IntroductionEnd is { } introEnd && introEnd > introStart)
        {
            store.SetIntroduction(itemId, introStart, introEnd);
            found = true;
        }

        if (result.CreditsStart is { } creditsStart && result.CreditsEnd is { } creditsEnd && creditsEnd > creditsStart)
        {
            store.SetCredits(itemId, creditsStart, creditsEnd);
            found = true;
        }

        return found;
    }
}
