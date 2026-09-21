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

// The one real explicit trigger left for this plugin's own chromaprint
// analyzer (Controllers/IntroCreditsController.cs's own real right-click
// "Find Skip Intro/Credits" action, gated admin only): Services/
// CommunitySkip's own free tier runs first, no stream access at all, and
// only whatever it leaves uncovered for a season ever reaches
// IntroCreditsAnalyzer's own real debrid-backed fallback below it - real
// feedback was explicit that a reader's own debrid quota should never be
// spent automatically, only on a deliberate real ask.
public class IntroCreditsBulkScanner(
    ILibraryManager libraryManager,
    CommunitySkipProvider communitySkipProvider,
    IntroCreditsAnalyzer analyzer,
    IntroCreditsStore store,
    ILogger<IntroCreditsBulkScanner> logger)
{
    public record ScanResult(int EpisodesScanned, int CommunityHits, int AnalyzerHits);

    public async Task<ScanResult> ScanAsync(Guid itemId, Guid userId, CancellationToken cancellationToken)
    {
        var item = libraryManager.GetItemById(itemId);
        return item switch
        {
            Movie movie => await ScanMovieAsync(movie, cancellationToken).ConfigureAwait(false),
            Series series => await ScanSeriesAsync(series, userId, cancellationToken).ConfigureAwait(false),
            _ => new ScanResult(0, 0, 0),
        };
    }

    // A movie has no sibling of its own within this library for
    // IntroCreditsAnalyzer's own cross-episode comparison to ever anchor
    // against, so TheIntroDB is the only real tier that can ever answer
    // for one - same real limitation the community tier itself already
    // has (Services/CommunitySkip/CommunitySkipProvider.cs's own header),
    // just with no expensive fallback below it to reach for here at all.
    private async Task<ScanResult> ScanMovieAsync(Movie movie, CancellationToken cancellationToken)
    {
        var result = await communitySkipProvider.GetSkipIntervalsForMovieAsync(movie, cancellationToken).ConfigureAwait(false);
        var found = StoreCommunityResult(movie.Id, result);
        logger.LogInformation("Jellio: community skip scan for {MovieName} - found: {Found}", movie.Name, found);
        return new ScanResult(1, found ? 1 : 0, 0);
    }

    private async Task<ScanResult> ScanSeriesAsync(Series series, Guid userId, CancellationToken cancellationToken)
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

            var episodes = season.GetEpisodes().OfType<Episode>().Where(episode => episode.RunTimeTicks is > 0).ToList();
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

            // Only the episodes the community tier above could not
            // already answer for ever reach the expensive fallback, and
            // only when there are at least two of them left in this
            // season for IntroCreditsAnalyzer's own cross-episode
            // comparison to have anything to anchor against.
            if (stillMissing.Count < 2)
            {
                continue;
            }

            var beforeIntro = stillMissing.Count(episode => store.Get(episode.Id)?.IntroEndTicks is > 0);
            var beforeCredits = stillMissing.Count(episode => store.Get(episode.Id)?.CreditsEndTicks is > 0);

            await analyzer.AnalyzeSeasonAsync(season.Id, userId, cancellationToken).ConfigureAwait(false);

            var afterIntro = stillMissing.Count(episode => store.Get(episode.Id)?.IntroEndTicks is > 0);
            var afterCredits = stillMissing.Count(episode => store.Get(episode.Id)?.CreditsEndTicks is > 0);
            analyzerHits += Math.Max(afterIntro - beforeIntro, 0) + Math.Max(afterCredits - beforeCredits, 0);
        }

        logger.LogInformation(
            "Jellio: community skip scan for {SeriesName} - {EpisodesScanned} episode(s) scanned, {CommunityHits} from the community tier, {AnalyzerHits} from the analyzer fallback",
            series.Name,
            episodesScanned,
            communityHits,
            analyzerHits);

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
