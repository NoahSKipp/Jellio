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

public class IntroCreditsAnalyzer(
    ILibraryManager libraryManager,
    IUserManager userManager,
    IMediaSourceManager mediaSourceManager,
    ChromaprintExtractor extractor,
    IntroCreditsStore store,
    ILogger<IntroCreditsAnalyzer> logger)
{
    private const double WindowSeconds = 300;

    private static readonly TimeSpan MinReanalyzeGap = TimeSpan.FromDays(3);

    private readonly Dictionary<Guid, SemaphoreSlim> _seasonGates = new();
    private readonly object _seasonGatesLock = new();

    public async Task AnalyzeSeasonAsync(Guid seasonId, Guid userId, CancellationToken cancellationToken)
    {
        if (libraryManager.GetItemById(seasonId) is not Season season)
        {
            return;
        }

        var episodes = OrderedEpisodes(season);
        if (episodes.Count < 2)
        {
            return;
        }

        await RunLockedAsync(season, episodes, userId, cancellationToken).ConfigureAwait(false);
    }

    private async Task RunLockedAsync(Season season, List<Episode> batch, Guid userId, CancellationToken cancellationToken)
    {
        var gate = GetSeasonGate(season.Id);
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await AnalyzeBatchLockedAsync(season, batch, userId, cancellationToken).ConfigureAwait(false);
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

    private static List<Episode> OrderedEpisodes(Season season) =>
        season.GetEpisodes()
            .OfType<Episode>()
            .Where(episode => episode.RunTimeTicks is > 0)
            .OrderBy(episode => episode.IndexNumber ?? int.MaxValue)
            .ToList();

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

    private async Task AnalyzeBatchLockedAsync(Season season, List<Episode> batch, Guid userId, CancellationToken cancellationToken)
    {
        var user = userManager.GetUserById(userId) ?? userManager.GetUsers().FirstOrDefault();
        if (user is null)
        {
            logger.LogWarning("Jellio: intro/credits analysis skipped for {SeasonName}, no user to resolve sources as", season.Name);
            return;
        }

        logger.LogInformation(
            "Jellio: analyzing {SeasonName}, batch of {Count} starting at {EpisodeName}",
            season.Name,
            batch.Count,
            batch[0].Name);

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
