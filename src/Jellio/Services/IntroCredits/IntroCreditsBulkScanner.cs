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

// Two real explicit triggers components/cardOptionsMenu.js and
// screens/detail.js's own episode options menu both offer (admin only,
// Configuration/config.html's own toggle): a "Quick Skip Search"
// (Services/CommunitySkip's own free tier only, does nothing further
// once that comes back short) and a "Deep Skip Search" (the same free
// tier first, only reaching for IntroCreditsAnalyzer's own real
// debrid-backed chromaprint fallback for whatever it leaves uncovered).
// Real feedback was explicit that a reader's own debrid quota should
// never be spent automatically, and that even a deliberate real ask
// should let an admin choose whether that cost is worth paying, not
// just how big a scope to pay it across (Episode/Season/Show).
public class IntroCreditsBulkScanner(
    ILibraryManager libraryManager,
    CommunitySkipProvider communitySkipProvider,
    IntroCreditsAnalyzer analyzer,
    IntroCreditsStore store,
    ILogger<IntroCreditsBulkScanner> logger)
{
    public record ScanResult(int EpisodesScanned, int CommunityHits, int AnalyzerHits);

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

    // A movie has no sibling of its own within this library for
    // IntroCreditsAnalyzer's own cross-episode comparison to ever anchor
    // against, so TheIntroDB is the only real tier that can ever answer
    // for one - same real limitation the community tier itself already
    // has (Services/CommunitySkip/CommunitySkipProvider.cs's own header),
    // just with no expensive fallback below it to reach for here at all.
    // No Quick/Deep distinction on the frontend's own Movie card menu for
    // exactly that reason, a single "Find Skip Intro/Credits" entry only.
    private async Task<ScanResult> ScanMovieAsync(Movie movie, CancellationToken cancellationToken)
    {
        var result = await communitySkipProvider.GetSkipIntervalsForMovieAsync(movie, cancellationToken).ConfigureAwait(false);
        var found = StoreCommunityResult(movie.Id, result);
        logger.LogInformation("Jellio: community skip scan for {MovieName} - found: {Found}", movie.Name, found);
        return new ScanResult(1, found ? 1 : 0, 0);
    }

    // Deep Search on a single episode still has to reach the whole real
    // season for IntroCreditsAnalyzer's own cross-episode comparison
    // (chromaprint needs at least one other episode to anchor against, a
    // real limitation this file cannot avoid), but only ever pays that
    // real cost when this one episode's own community lookup came back
    // short - a Quick miss on a well covered season never triggers it.
    private async Task<ScanResult> ScanEpisodeAsync(Episode episode, bool useAnalyzerFallback, Guid userId, CancellationToken cancellationToken)
    {
        var result = await communitySkipProvider.GetSkipIntervalsAsync(episode, cancellationToken).ConfigureAwait(false);
        var communityHit = StoreCommunityResult(episode.Id, result);

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

            var result = await communitySkipProvider.GetSkipIntervalsAsync(episode, cancellationToken).ConfigureAwait(false);
            if (StoreCommunityResult(episode.Id, result))
            {
                communityHits++;
            }
            else
            {
                stillMissing.Add(episode);
            }
        }

        // Quick Search stops right here - Deep Search only reaches the
        // expensive fallback below for whatever the community tier above
        // left uncovered, and only when there are at least two of them
        // left in this season for IntroCreditsAnalyzer's own
        // cross-episode comparison to have anything to anchor against.
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

    // Only ever stores a real hit: leaving a miss unstored (rather than
    // MarkAttempted-ing it the way the expensive analyzer's own store
    // calls do) keeps this cheap tier retryable on the very next scan
    // with no gap to wait out, since a plain community lookup costs this
    // plugin nothing to just ask again.
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
