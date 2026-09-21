using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
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
    public void QueueSeasonAnalysis(Guid episodeId, Guid userId)
    {
        _ = RunGuardedAsync(episodeId, userId);
    }

    private async Task RunGuardedAsync(Guid episodeId, Guid userId)
    {
        if (libraryManager.GetItemById(episodeId) is not Episode episode || episode.SeasonId == Guid.Empty)
        {
            return;
        }

        if (!_queuedSeasons.TryAdd(episode.SeasonId, 0))
        {
            return;
        }

        try
        {
            await _gate.WaitAsync().ConfigureAwait(false);
            try
            {
                await AnalyzeSeasonAsync(episode.SeasonId, userId, CancellationToken.None).ConfigureAwait(false);
            }
            finally
            {
                _gate.Release();
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: intro/credits analysis failed for season {SeasonId}", episode.SeasonId);
        }
        finally
        {
            _queuedSeasons.TryRemove(episode.SeasonId, out _);
        }
    }

    private async Task AnalyzeSeasonAsync(Guid seasonId, Guid userId, CancellationToken cancellationToken)
    {
        if (libraryManager.GetItemById(seasonId) is not Season season)
        {
            return;
        }

        var user = userManager.GetUserById(userId) ?? userManager.GetUsers().FirstOrDefault();
        if (user is null)
        {
            return;
        }

        var episodes = season.GetEpisodes()
            .OfType<Episode>()
            .Where(episode => episode.RunTimeTicks is > 0)
            .OrderBy(episode => episode.IndexNumber ?? int.MaxValue)
            .ToList();

        if (episodes.Count < 2)
        {
            return;
        }

        // A local function rather than a private method taking a real
        // User parameter: that type's own real namespace has already
        // moved at least once across a real Jellyfin server version
        // (Jellyfin.Data.Entities in one, Jellyfin.Database.Implementations.
        // Entities in another), user itself captured straight off the
        // var above sidesteps ever needing to spell either one out here.
        async Task<MediaSourceInfo?> ResolveSourceAsync(Episode candidate)
        {
            try
            {
                var sources = await mediaSourceManager
                    .GetPlaybackMediaSources(candidate, user, false, false, cancellationToken)
                    .ConfigureAwait(false);
                return sources.FirstOrDefault(source => !string.IsNullOrEmpty(source.Path));
            }
            catch (Exception ex)
            {
                logger.LogDebug(ex, "Jellio: could not resolve a playable source for {ItemId}", candidate.Id);
                return null;
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
            if (existing is { Attempted: true } && DateTimeOffset.UtcNow - existing.AttemptedAt < MinReanalyzeGap)
            {
                continue;
            }

            var source = await ResolveSourceAsync(episode).ConfigureAwait(false);
            if (source is null)
            {
                store.MarkAttempted(episode.Id);
                continue;
            }

            var durationSeconds = episode.RunTimeTicks!.Value / (double)TimeSpan.TicksPerSecond;
            var introWindow = Math.Min(WindowSeconds, durationSeconds / 2);
            var creditsWindow = Math.Min(WindowSeconds, durationSeconds / 2);
            var creditsOffset = Math.Max(0, durationSeconds - creditsWindow);

            var introFingerprint = await extractor.ExtractAsync(source, 0, introWindow, cancellationToken).ConfigureAwait(false);
            var creditsFingerprint = await extractor.ExtractAsync(source, creditsOffset, creditsWindow, cancellationToken).ConfigureAwait(false);

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
                continue;
            }

            if (introFingerprint is not null && anchorIntroFingerprint is not null)
            {
                MatchAndStore(
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

            if (creditsFingerprint is not null && anchorCreditsFingerprint is not null)
            {
                MatchAndStore(
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
    private static void MatchAndStore(
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
        var matchA = FingerprintMatcher.FindMatch(fingerprintA, fingerprintB, windowSecondsA);
        if (matchA is { } a)
        {
            store(itemIdA, offsetSecondsA + a.StartSeconds, offsetSecondsA + a.EndSeconds);
        }

        var matchB = FingerprintMatcher.FindMatch(fingerprintB, fingerprintA, windowSecondsB);
        if (matchB is { } b)
        {
            store(itemIdB, offsetSecondsB + b.StartSeconds, offsetSecondsB + b.EndSeconds);
        }
    }
}
