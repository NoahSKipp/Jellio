using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellio.Services;

public record HistoricalActivity(Guid ItemId, Guid UserId, string Activity, int Priority, DateTime Date);

// When the watch history behind community watching is rebuilt: every few
// minutes, and soon after someone starts or stops playing.
public sealed class RefreshSchedule(TimeSpan interval, TimeSpan debounce)
{
    private DateTime? _builtAt;
    private DateTime? _dirtySince;

    public void MarkDirty(DateTime now)
    {
        lock (this)
        {
            _dirtySince ??= now;
        }
    }

    public bool IsDue(DateTime now)
    {
        lock (this)
        {
            return _builtAt is null
                || now - _builtAt.Value >= interval
                || (_dirtySince is { } dirty && now - dirty >= debounce);
        }
    }

    // startedAt: changes after the build started are picked up by the next one.
    public void Built(DateTime startedAt, DateTime now)
    {
        lock (this)
        {
            _builtAt = now;
            if (_dirtySince is { } dirty && dirty <= startedAt)
            {
                _dirtySince = null;
            }
        }
    }
}

// Builds the watch history of every user in the background, one user at a
// time, so a request for community watching only reads it. Built inside the
// request, it ran sixteen large library queries at once on every cache miss
// and held the database for up to a minute while titles were being opened.
public sealed class CommunityWatchingService(
    ISessionManager sessionManager,
    ILibraryManager libraryManager,
    IUserManager userManager,
    IUserDataManager userDataManager,
    IServiceProvider services,
    ILogger<CommunityWatchingService> logger) : IHostedService, IDisposable
{
    private bool _userDataTableFailed;
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan Debounce = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan Tick = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan PauseBetweenUsers = TimeSpan.FromMilliseconds(250);

    private readonly RefreshSchedule _schedule = new(Interval, Debounce);
    private readonly CancellationTokenSource _stop = new();
    private Task? _loop;
    private volatile IReadOnlyList<HistoricalActivity>? _history;

    // Null until the first build finished.
    public IReadOnlyList<HistoricalActivity>? History => _history;

    public Task StartAsync(CancellationToken cancellationToken)
    {
        sessionManager.PlaybackStart += OnPlayback;
        sessionManager.PlaybackStopped += OnPlayback;
        _loop = Task.Run(() => RunAsync(_stop.Token), CancellationToken.None);
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        sessionManager.PlaybackStart -= OnPlayback;
        sessionManager.PlaybackStopped -= OnPlayback;
        await _stop.CancelAsync().ConfigureAwait(false);
        if (_loop is not null)
        {
            try
            {
                await _loop.WaitAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
            }
        }
    }

    public void Dispose() => _stop.Dispose();

    private void OnPlayback(object? sender, PlaybackProgressEventArgs e) => _schedule.MarkDirty(DateTime.UtcNow);

    private async Task RunAsync(CancellationToken ct)
    {
        // Let the server finish starting first.
        await Task.Delay(TimeSpan.FromSeconds(30), ct).ConfigureAwait(false);
        while (!ct.IsCancellationRequested)
        {
            if (_schedule.IsDue(DateTime.UtcNow))
            {
                var started = DateTime.UtcNow;
                try
                {
                    _history = await BuildAsync(ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception ex)
                {
                    logger.LogWarning(ex, "Jellio: could not build the community watch history");
                }

                _schedule.Built(started, DateTime.UtcNow);
            }

            await Task.Delay(Tick, ct).ConfigureAwait(false);
        }
    }

    // A user's own play state rows, read through their index: a few
    // hundred rows instead of two queries over the whole library per user.
    private bool AddFromUserData(Jellyfin.Database.Implementations.Entities.User user, DateTime since, List<HistoricalActivity> history)
    {
        if (_userDataTableFailed || services.GetService<IDbContextFactory<JellyfinDbContext>>() is not { } factory)
        {
            return false;
        }

        List<(Guid ItemId, bool Played, long Position, DateTime? LastPlayed)> rows;
        try
        {
            using var db = factory.CreateDbContext();
            rows = db.UserData.AsNoTracking()
                .Where(u => u.UserId == user.Id && (u.PlaybackPositionTicks > 0 || u.Played))
                .OrderByDescending(u => u.LastPlayedDate)
                .Take(200)
                .Select(u => new { u.ItemId, u.Played, u.PlaybackPositionTicks, u.LastPlayedDate })
                .AsEnumerable()
                .Select(u => (u.ItemId, u.Played, u.PlaybackPositionTicks, u.LastPlayedDate))
                .ToList();
        }
        catch (Exception ex)
        {
            _userDataTableFailed = true;
            logger.LogWarning(ex, "Jellio: reading play state directly failed, using library queries for community watching");
            return false;
        }

        int watching = 0, finished = 0;
        var seen = new HashSet<Guid>();
        foreach (var row in rows)
        {
            // One row per user data key; an item can have several.
            if (!seen.Add(row.ItemId))
            {
                continue;
            }

            if (watching >= 8 && finished >= 12)
            {
                break;
            }

            if (libraryManager.GetItemById(row.ItemId) is not { } item
                || item.GetBaseItemKind() is not (BaseItemKind.Movie or BaseItemKind.Episode)
                || !item.IsVisibleStandalone(user))
            {
                continue;
            }

            var date = row.LastPlayed ?? DateTime.MinValue;
            if (!row.Played && row.Position > 0 && watching < 8)
            {
                watching++;
                history.Add(new HistoricalActivity(item.Id, user.Id, "watching", 1, date));
            }
            else if (row.Played && finished < 12)
            {
                finished++;
                if (date >= since)
                {
                    history.Add(new HistoricalActivity(item.Id, user.Id, "finished", 2, date));
                }
            }
        }

        return true;
    }

    private void AddFromLibrary(Jellyfin.Database.Implementations.Entities.User user, DateTime fourteenDaysAgo, List<HistoricalActivity> history)
    {
        var resumable = libraryManager.GetItemList(new InternalItemsQuery(user)
        {
            IncludeItemTypes = [BaseItemKind.Movie, BaseItemKind.Episode],
            IsResumable = true,
            Recursive = true,
            OrderBy = [(ItemSortBy.DatePlayed, SortOrder.Descending)],
            Limit = 8,
        });
        foreach (var item in resumable)
        {
            var date = userDataManager.GetUserData(user, item)?.LastPlayedDate ?? DateTime.MinValue;
            history.Add(new HistoricalActivity(item.Id, user.Id, "watching", 1, date));
        }

        var played = libraryManager.GetItemList(new InternalItemsQuery(user)
        {
            IncludeItemTypes = [BaseItemKind.Movie, BaseItemKind.Episode],
            IsPlayed = true,
            Recursive = true,
            OrderBy = [(ItemSortBy.DatePlayed, SortOrder.Descending)],
            Limit = 12,
        });
        foreach (var item in played)
        {
            var date = userDataManager.GetUserData(user, item)?.LastPlayedDate ?? DateTime.MinValue;
            if (date >= fourteenDaysAgo)
            {
                history.Add(new HistoricalActivity(item.Id, user.Id, "finished", 2, date));
            }
        }
    }

    private async Task<IReadOnlyList<HistoricalActivity>> BuildAsync(CancellationToken ct)
    {
        var timer = Stopwatch.StartNew();
        var fourteenDaysAgo = DateTime.UtcNow.AddDays(-14);
        var history = new List<HistoricalActivity>();
        var users = userManager.GetUsers().ToList();
        foreach (var user in users)
        {
            ct.ThrowIfCancellationRequested();
            if (!AddFromUserData(user, fourteenDaysAgo, history))
            {
                AddFromLibrary(user, fourteenDaysAgo, history);
            }

            // Short writes and requests get the database between users.
            await Task.Delay(PauseBetweenUsers, ct).ConfigureAwait(false);
        }

        logger.LogInformation(
            "Jellio: community watch history built in the background in {Ms} ms for {Users} users, {Entries} entries",
            timer.ElapsedMilliseconds,
            users.Count,
            history.Count);
        return history;
    }
}
