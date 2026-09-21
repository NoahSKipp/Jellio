using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Jellio.Services.IntroCredits;

// Orchestrates the whole real cross-episode comparison a season needs:
// resolve each episode's own real playable source the same real way
// playback already does (IMediaSourceManager, not Intro Skipper's own
// local-file-only queue), fingerprint its own real intro/credits
// windows, and compare every one against a single real "anchor" episode
// (the first one this season a real fingerprint could be pulled for)
// rather than every real pair against every other - O(n) real ffmpeg
// runs per season instead of O(n^2), the anchor itself only needs
// fingerprinting once.
public class IntroCreditsAnalyzer(
    ILibraryManager libraryManager,
    IUserManager userManager,
    IMediaSourceManager mediaSourceManager,
    IHttpContextAccessor httpContextAccessor,
    IServiceProvider serviceProvider,
    ChromaprintExtractor extractor,
    IntroCreditsStore store,
    ILogger<IntroCreditsAnalyzer> logger)
{
    // Generous enough to hold a real cold open plus a real theme song,
    // or a real full length end credits roll, without reading anywhere
    // close to a whole real episode's own audio for it.
    private const double WindowSeconds = 300;

    // A title genuinely without a shared intro/credits (an anthology,
    // a one-off special, a real miss on this season's own anchor) would
    // otherwise get re-fingerprinted on every single real playback
    // within this gap, real wasted ffmpeg work for an already-known
    // real answer.
    private static readonly TimeSpan MinReanalyzeGap = TimeSpan.FromDays(3);

    // Serialized rather than one real analysis per concurrent playback:
    // this runs on a real home server's own CPU alongside whatever else
    // it is already doing (transcoding, Gelato's own real requests),
    // real low priority background work, not a real race to finish
    // first.
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly ConcurrentDictionary<Guid, byte> _queuedSeasons = new();

    // Fire and forget on purpose: Controllers/IntroCreditsController.cs's
    // own real POST already returns 202 the instant this is queued,
    // components/player.js's own real playback start already fires this
    // the same non-blocking real way it already fires prefetchStreams.
    // force skips MinReanalyzeGap's own real skip for an episode
    // already marked Attempted: real feedback live was a reader's own
    // manual "Analyze library" click doing nothing at all, visible only
    // once this file's own real ffmpeg failures stopped being logged at
    // Debug - every earlier real attempt across this whole feature's
    // own iteration already marked most episodes Attempted with a real
    // miss, so a plain re-trigger silently skipped every one of them for
    // MinReanalyzeGap's own real 3 days rather than actually retrying.
    // An explicit real ask from a reader should always get a real fresh
    // attempt; only the fully automatic real paths (playback start,
    // ItemAdded, the periodic sweep) still respect the gap.
    public void QueueSeasonAnalysis(Guid seasonId, Guid userId, bool force = false)
    {
        _ = RunGuardedAsync(seasonId, userId, force);
    }

    // screens/player.js's own real playback start only ever knows the
    // episode it is about to play, not that episode's own real
    // SeasonId - resolved here once rather than asking every real
    // caller (IntroCreditsController's own POST included) to look
    // that up itself first.
    public void QueueSeasonAnalysisForEpisode(Guid episodeId, Guid userId, bool force = false)
    {
        if (libraryManager.GetItemById(episodeId) is not Episode episode || episode.SeasonId == Guid.Empty)
        {
            return;
        }

        QueueSeasonAnalysis(episode.SeasonId, userId, force);
    }

    // IntroCreditsLibraryScanService's own real periodic sweep and its
    // own real "run now" endpoint both call this: every real Season in
    // the library, each queued the exact same real deduped way a single
    // playback's own real trigger already is, so a run already in
    // progress against a season a reader just happens to also be
    // watching right now is never started twice.
    public void QueueLibraryAnalysis(Guid userId, bool force = false)
    {
        var seasons = libraryManager.GetItemList(new InternalItemsQuery
        {
            IncludeItemTypes = [BaseItemKind.Season],
            Recursive = true,
        });

        logger.LogInformation("Jellio: queuing intro/credits analysis for {Count} seasons (force={Force})", seasons.Count, force);

        foreach (var season in seasons)
        {
            QueueSeasonAnalysis(season.Id, userId, force);
        }
    }

    private async Task RunGuardedAsync(Guid seasonId, Guid userId, bool force)
    {
        if (!_queuedSeasons.TryAdd(seasonId, 0))
        {
            return;
        }

        try
        {
            await _gate.WaitAsync().ConfigureAwait(false);
            try
            {
                await AnalyzeSeasonAsync(seasonId, userId, force, CancellationToken.None).ConfigureAwait(false);
            }
            finally
            {
                _gate.Release();
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: intro/credits analysis failed for season {SeasonId}", seasonId);
        }
        finally
        {
            _queuedSeasons.TryRemove(seasonId, out _);
        }
    }

    private async Task AnalyzeSeasonAsync(Guid seasonId, Guid userId, bool force, CancellationToken cancellationToken)
    {
        if (libraryManager.GetItemById(seasonId) is not Season season)
        {
            logger.LogWarning("Jellio: intro/credits analysis skipped, {SeasonId} is not a Season", seasonId);
            return;
        }

        var user = userManager.GetUserById(userId) ?? userManager.GetUsers().FirstOrDefault();
        if (user is null)
        {
            logger.LogWarning("Jellio: intro/credits analysis skipped for {SeasonName}, no user to resolve sources as", season.Name);
            return;
        }

        var episodes = season.GetEpisodes()
            .OfType<Episode>()
            .Where(episode => episode.RunTimeTicks is > 0)
            .OrderBy(episode => episode.IndexNumber ?? int.MaxValue)
            .ToList();

        if (episodes.Count < 2)
        {
            logger.LogInformation(
                "Jellio: intro/credits analysis skipped for {SeasonName}, only {Count} episode(s) with a known runtime",
                season.Name,
                episodes.Count);
            return;
        }

        logger.LogInformation("Jellio: analyzing {SeasonName}, {Count} episodes (force={Force})", season.Name, episodes.Count, force);

        // A local function rather than a private method taking a real
        // User parameter: that type's own real namespace has already
        // moved at least once across a real Jellyfin server version
        // (Jellyfin.Data.Entities in one, Jellyfin.Database.Implementations.
        // Entities in another), user itself captured straight off the
        // var above sidesteps ever needing to spell either one out here.
        //
        // Real bug, found live: Gelato's own IMediaSourceManager decorator
        // (MediaSourceManagerDecorator.GetStaticMediaSources, confirmed
        // from a real server's own stack trace) reads the ambient
        // HttpContext (IHttpContextAccessor) to check the current real
        // ASP.NET endpoint, something every real playback request always
        // has and this background job never does - a real
        // ArgumentNullException on every single call, 100% of this whole
        // real feature's own source resolution failing silently behind
        // "no playable source resolved" until now. A synthetic
        // DefaultHttpContext set on the same real IHttpContextAccessor
        // for the real duration of this one call is enough: Gelato's own
        // GetEndpoint() reads a non-null real HttpContext.Features and
        // finds no matched endpoint, the same real answer a genuine
        // request to a route no controller ever claimed would already
        // give it, not a special case this needs to know about.
        // IHttpContextAccessor.HttpContext is itself an AsyncLocal under
        // the hood, so this only ever affects this one real async call
        // chain, never a real concurrent request elsewhere on the host.
        async Task<MediaSourceInfo?> ResolveSourceAsync(Episode candidate)
        {
            var previousContext = httpContextAccessor.HttpContext;
            try
            {
                httpContextAccessor.HttpContext = new DefaultHttpContext { RequestServices = serviceProvider };
                var sources = await mediaSourceManager
                    .GetPlaybackMediaSources(candidate, user, false, false, cancellationToken)
                    .ConfigureAwait(false);
                return sources.FirstOrDefault(source => !string.IsNullOrEmpty(source.Path));
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Jellio: could not resolve a playable source for {ItemId}", candidate.Id);
                return null;
            }
            finally
            {
                httpContextAccessor.HttpContext = previousContext;
            }
        }

        Episode? anchor = null;
        int[]? anchorIntroFingerprint = null;
        int[]? anchorCreditsFingerprint = null;
        var anchorIntroWindow = 0d;
        var anchorCreditsWindow = 0d;
        var anchorCreditsOffset = 0d;

        foreach (var episode in episodes)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var existing = store.Get(episode.Id);
            if (!force && existing is { Attempted: true } && DateTimeOffset.UtcNow - existing.AttemptedAt < MinReanalyzeGap)
            {
                logger.LogInformation(
                    "Jellio: skipping {EpisodeName}, already attempted at {AttemptedAt} (pass force to retry sooner)",
                    episode.Name,
                    existing.AttemptedAt);
                continue;
            }

            var source = await ResolveSourceAsync(episode).ConfigureAwait(false);
            if (source is null)
            {
                logger.LogWarning("Jellio: no playable source resolved for {EpisodeName}, skipping", episode.Name);
                store.MarkAttempted(episode.Id);
                continue;
            }

            var durationSeconds = episode.RunTimeTicks!.Value / (double)TimeSpan.TicksPerSecond;
            var introWindow = Math.Min(WindowSeconds, durationSeconds / 2);
            var creditsWindow = Math.Min(WindowSeconds, durationSeconds / 2);
            var creditsOffset = Math.Max(0, durationSeconds - creditsWindow);

            var introFingerprint = await extractor.ExtractAsync(source, 0, introWindow, cancellationToken).ConfigureAwait(false);
            var creditsFingerprint = await extractor.ExtractAsync(source, creditsOffset, creditsWindow, cancellationToken).ConfigureAwait(false);

            if (introFingerprint is null && creditsFingerprint is null)
            {
                logger.LogWarning(
                    "Jellio: ffmpeg produced no fingerprint at all for {EpisodeName} ({Path}), see the warning above for the real ffmpeg failure",
                    episode.Name,
                    source.Path);
            }

            if (anchor is null)
            {
                if (introFingerprint is null && creditsFingerprint is null)
                {
                    store.MarkAttempted(episode.Id);
                    continue;
                }

                anchor = episode;
                anchorIntroFingerprint = introFingerprint;
                anchorCreditsFingerprint = creditsFingerprint;
                anchorIntroWindow = introWindow;
                anchorCreditsWindow = creditsWindow;
                anchorCreditsOffset = creditsOffset;
                store.MarkAttempted(episode.Id);
                logger.LogInformation("Jellio: {EpisodeName} set as this season's own anchor", episode.Name);
                continue;
            }

            var introMatched = false;
            if (introFingerprint is not null && anchorIntroFingerprint is not null)
            {
                introMatched = MatchAndStore(
                    anchor.Id,
                    anchorIntroFingerprint,
                    anchorIntroWindow,
                    0,
                    episode.Id,
                    introFingerprint,
                    introWindow,
                    0,
                    store.SetIntroduction);
            }

            var creditsMatched = false;
            if (creditsFingerprint is not null && anchorCreditsFingerprint is not null)
            {
                creditsMatched = MatchAndStore(
                    anchor.Id,
                    anchorCreditsFingerprint,
                    anchorCreditsWindow,
                    anchorCreditsOffset,
                    episode.Id,
                    creditsFingerprint,
                    creditsWindow,
                    creditsOffset,
                    store.SetCredits);
            }

            logger.LogInformation(
                "Jellio: {EpisodeName} vs anchor {AnchorName} - intro matched: {IntroMatched}, credits matched: {CreditsMatched}",
                episode.Name,
                anchor.Name,
                introMatched,
                creditsMatched);

            store.MarkAttempted(episode.Id);
        }
    }

    // Matches in both directions (a against b, then b against a): the
    // real run FindMatch finds is only ever expressed in the first
    // array's own real timeline, so getting both episodes' own real
    // segment recorded from one real comparison needs it called twice,
    // each side's own real offsetSeconds (0 for an intro window, that
    // episode's own real creditsOffset for a credits one) added back in
    // since FindMatch itself only ever knows about the real window it
    // was handed, not where that window sat in the real full episode.
    private static bool MatchAndStore(
        Guid itemIdA,
        int[] fingerprintA,
        double windowSecondsA,
        double offsetSecondsA,
        Guid itemIdB,
        int[] fingerprintB,
        double windowSecondsB,
        double offsetSecondsB,
        Action<Guid, double, double> store)
    {
        var matched = false;
        var matchA = FingerprintMatcher.FindMatch(fingerprintA, fingerprintB, windowSecondsA);
        if (matchA is { } a)
        {
            store(itemIdA, offsetSecondsA + a.StartSeconds, offsetSecondsA + a.EndSeconds);
            matched = true;
        }

        var matchB = FingerprintMatcher.FindMatch(fingerprintB, fingerprintA, windowSecondsB);
        if (matchB is { } b)
        {
            store(itemIdB, offsetSecondsB + b.StartSeconds, offsetSecondsB + b.EndSeconds);
            matched = true;
        }

        return matched;
    }
}
