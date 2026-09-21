using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using Microsoft.Extensions.Logging;

namespace Jellio.Services.IntroCredits;

// Real bug, found live, that reshaped this whole file: Gelato's own
// IMediaSourceManager decorator (Gelato.ActionContextExtensions.
// IsInsertableAction, confirmed from a real server's own stack trace)
// only does its real expensive resolution (a live Stremio addon round
// trip plus debrid lookup) when the current call is genuinely inside a
// real ASP.NET request it recognizes - anything else, including a
// synthetic HttpContext this file used to hand it, gets back a cheap
// gelato://stub/... placeholder instead, not a real playable URL.
// Almost certainly deliberate on Gelato's own part: a bulk background
// sweep resolving real streams for a reader's entire library, unwatched
// episodes included, is exactly the kind of load that gate reads as
// built to stop (a real debrid account has real rate limits and real
// quotas, and this whole library ran to 5911 real seasons). So this no
// longer tries to fight that gate with a background job at all -
// AnalyzeBatchAsync is called directly, awaited, from
// IntroCreditsController's own POST, a real request with a real
// matched endpoint Gelato already recognizes, and only ever resolves a
// small forward-looking batch from whichever episode a reader actually
// started playing, not the whole library at once.
public class IntroCreditsAnalyzer(
    ILibraryManager libraryManager,
    IUserManager userManager,
    IMediaSourceManager mediaSourceManager,
    ChromaprintExtractor extractor,
    IntroCreditsStore store,
    ILogger<IntroCreditsAnalyzer> logger)
{
    // Real feedback shaped this number directly: a batch this size,
    // resolved and fingerprinted together in one real pass, already has
    // an anchor and at least one real comparison to make by the time it
    // finishes, rather than needing a second real playback before the
    // very first episode of a season ever gets a real result. Small
    // enough that even a real cold Stremio round trip on every one of
    // them stays a real seconds-not-minutes real request.
    private const int BatchSize = 5;

    private const double WindowSeconds = 300;

    private static readonly TimeSpan MinReanalyzeGap = TimeSpan.FromDays(3);

    // Per-season, not global: two readers watching two different real
    // shows at once should never wait on each other, only a real
    // repeat/overlapping trigger for the exact same season (a reader
    // pausing and un-pausing, or Up Next firing this again a moment
    // after playback start already did) serializes against itself.
    private readonly Dictionary<Guid, SemaphoreSlim> _seasonGates = new();
    private readonly object _seasonGatesLock = new();

    // Called directly from IntroCreditsController's own real POST,
    // awaited there rather than fired and forgotten: the real request
    // it runs inside of is the one real thing Gelato's own resolution
    // gate actually needs, so this has to stay part of that same real
    // async chain start to finish, unlike this file's own earlier
    // design.
    public async Task AnalyzeBatchAsync(Guid episodeId, Guid userId, CancellationToken cancellationToken)
    {
        if (libraryManager.GetItemById(episodeId) is not Episode triggerEpisode || triggerEpisode.SeasonId == Guid.Empty)
        {
            return;
        }

        if (libraryManager.GetItemById(triggerEpisode.SeasonId) is not Season season)
        {
            return;
        }

        var gate = GetSeasonGate(season.Id);
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await AnalyzeBatchLockedAsync(season, triggerEpisode, userId, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: intro/credits batch analysis failed for {SeasonName}", season.Name);
        }
        finally
        {
            gate.Release();
        }
    }

    private SemaphoreSlim GetSeasonGate(Guid seasonId)
    {
        lock (_seasonGatesLock)
        {
            if (!_seasonGates.TryGetValue(seasonId, out var gate))
            {
                gate = new SemaphoreSlim(1, 1);
                _seasonGates[seasonId] = gate;
            }

            return gate;
        }
    }

    private async Task AnalyzeBatchLockedAsync(Season season, Episode triggerEpisode, Guid userId, CancellationToken cancellationToken)
    {
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

        var triggerIndex = episodes.FindIndex(episode => episode.Id == triggerEpisode.Id);
        if (triggerIndex == -1)
        {
            return;
        }

        // Forward from wherever a reader actually started playing, the
        // same real "batches ahead of where someone's watching" shape
        // real feedback asked for directly: reaching episode N of a
        // batch that already covered N..N+4 needs no new real work at
        // all, MinReanalyzeGap below already skips it, the next real
        // batch only starts once a reader's own playback reaches an
        // episode this season has not already queued.
        var batch = episodes.Skip(triggerIndex).Take(BatchSize).ToList();
        if (batch.Count < 2)
        {
            logger.LogInformation(
                "Jellio: intro/credits batch for {SeasonName} starting at {EpisodeName} has only {Count} episode(s) left, nothing to cross reference",
                season.Name,
                triggerEpisode.Name,
                batch.Count);
            return;
        }

        logger.LogInformation(
            "Jellio: analyzing {SeasonName}, batch of {Count} starting at {EpisodeName}",
            season.Name,
            batch.Count,
            triggerEpisode.Name);

        Episode? anchor = null;
        int[]? anchorIntroFingerprint = null;
        int[]? anchorCreditsFingerprint = null;
        var anchorIntroWindow = 0d;
        var anchorCreditsWindow = 0d;
        var anchorCreditsOffset = 0d;

        foreach (var episode in batch)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var existing = store.Get(episode.Id);
            if (existing is { Attempted: true } && DateTimeOffset.UtcNow - existing.AttemptedAt < MinReanalyzeGap)
            {
                logger.LogInformation("Jellio: skipping {EpisodeName}, already attempted at {AttemptedAt}", episode.Name, existing.AttemptedAt);
                continue;
            }

            MediaSourceInfo? source;
            try
            {
                // Real, unfaked ambient HttpContext: this whole method
                // only ever runs as part of the real request
                // IntroCreditsController's own POST is already inside,
                // so Gelato's own decorator sees the same real endpoint
                // that request matched and does its real resolution
                // rather than handing back a gelato://stub/... placeholder.
                var sources = await mediaSourceManager
                    .GetPlaybackMediaSources(episode, user, false, false, cancellationToken)
                    .ConfigureAwait(false);
                source = sources.FirstOrDefault(candidate => !string.IsNullOrEmpty(candidate.Path));
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Jellio: could not resolve a playable source for {EpisodeName}", episode.Name);
                source = null;
            }

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
                logger.LogInformation("Jellio: {EpisodeName} set as this batch's own anchor", episode.Name);
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
