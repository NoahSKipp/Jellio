using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellio.Services.Reading;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellio.Services.Manga;

public class SeenChapter
{
    public int ChapterId { get; set; }

    public int MangaId { get; set; }

    // Unix milliseconds the chapter first showed up in a refresh.
    public long SeenAt { get; set; }
}

public class UpdatesData
{
    // Chapter ids already known for each series. A series is only
    // baselined on its first refresh, so a newly added series' whole
    // back catalogue doesn't flood the feed.
    public Dictionary<int, List<int>> Known { get; set; } = [];

    public List<SeenChapter> Recent { get; set; } = [];

    public long LastRefreshAt { get; set; }
}

/// <summary>
/// Mihon's library updates: every so often (and on demand) asks each
/// series' source for its chapter list through Suwayomi and notes the
/// chapters it hasn't seen before, for the Updates feed.
/// </summary>
public class MangaUpdatesService(
    SuwayomiClient suwayomi,
    MangaStreamService stream,
    ShelfStore shelfStore,
    ReadingProgressStore progressStore,
    NotificationStore notificationStore,
    IApplicationPaths applicationPaths,
    ILogger<MangaUpdatesService> logger) : BackgroundService
{
    private const int MaxRecent = 500;
    private const int ParallelFetches = 3;
    private static readonly TimeSpan FirstRun = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan Interval = TimeSpan.FromHours(12);
    private static readonly TimeSpan MinGap = TimeSpan.FromMinutes(10);

    // One shared record (not per user): the chapters are the server's.
    private readonly JsonUserStore<UpdatesData> _store = new(applicationPaths, "manga-updates", () => new UpdatesData());
    private readonly SemaphoreSlim _running = new(1, 1);

    public UpdatesData Load() => _store.Load(Guid.Empty);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await Task.Delay(FirstRun, stoppingToken).ConfigureAwait(false);
            while (!stoppingToken.IsCancellationRequested)
            {
                if (SuwayomiClient.IsConfigured)
                {
                    await RefreshAsync(false, stoppingToken).ConfigureAwait(false);
                }

                await Task.Delay(Interval, stoppingToken).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException)
        {
            // Shutting down.
        }
    }

    // Returns how many new chapters turned up. A refresh that ran in the
    // last few minutes is not repeated unless forced.
    public async Task<int> RefreshAsync(bool force, CancellationToken cancellationToken)
    {
        if (!SuwayomiClient.IsConfigured || !await _running.WaitAsync(0, cancellationToken).ConfigureAwait(false))
        {
            return 0;
        }

        try
        {
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (!force && now - Load().LastRefreshAt < MinGap.TotalMilliseconds)
            {
                return 0;
            }

            var titles = await stream.GetTitlesAsync(cancellationToken).ConfigureAwait(false);
            if (titles is null)
            {
                return 0;
            }

            // A series every reader of it has set to skip isn't checked.
            var shelves = shelfStore.UserIds().Select(id => shelfStore.Load(id)).ToList();
            titles = titles.Where(title =>
            {
                var key = ShelfStore.SeriesShelfKey(title.Title);
                var readers = shelves.Where(shelf => shelf.Library?.Contains(key) == true).ToList();
                return readers.Count == 0 || readers.Any(shelf => !(shelf.Series.GetValueOrDefault(key)?.SkipUpdates ?? false));
            }).ToList();

            using var throttle = new SemaphoreSlim(ParallelFetches);
            var fetched = await Task.WhenAll(titles.Select(async title =>
            {
                await throttle.WaitAsync(cancellationToken).ConfigureAwait(false);
                try
                {
                    var chapters = await suwayomi.FetchChaptersAsync(title.MangaId, cancellationToken).ConfigureAwait(false);
                    return (title.MangaId, Ids: chapters?.Select(chapter => chapter.Id).ToList());
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    logger.LogDebug(ex, "Jellio: could not refresh chapters for manga {MangaId}", title.MangaId);
                    return (title.MangaId, Ids: (List<int>?)null);
                }
                finally
                {
                    throttle.Release();
                }
            })).ConfigureAwait(false);

            var added = 0;
            var newByManga = new Dictionary<int, List<int>>();
            _store.Update(Guid.Empty, data =>
            {
                foreach (var (mangaId, ids) in fetched)
                {
                    if (ids is null)
                    {
                        continue;
                    }

                    if (data.Known.TryGetValue(mangaId, out var known))
                    {
                        var seen = known.ToHashSet();
                        foreach (var id in ids.Where(id => !seen.Contains(id)))
                        {
                            data.Recent.Add(new SeenChapter { ChapterId = id, MangaId = mangaId, SeenAt = now });
                            if (!newByManga.TryGetValue(mangaId, out var list))
                            {
                                list = [];
                                newByManga[mangaId] = list;
                            }

                            list.Add(id);
                            added++;
                        }
                    }

                    data.Known[mangaId] = ids;
                }

                data.Recent = data.Recent.OrderByDescending(entry => entry.SeenAt).Take(MaxRecent).ToList();
                data.LastRefreshAt = now;
            });

            if (added > 0)
            {
                stream.Invalidate();
                await NotifyAsync(newByManga, cancellationToken).ConfigureAwait(false);
            }

            logger.LogInformation("Jellio: manga library refresh found {Count} new chapters", added);
            return added;
        }
        finally
        {
            _running.Release();
        }
    }

    // One notification per reader who is reading the series (has progress
    // in it within the last three months) and hasn't set it to skip updates.
    private async Task NotifyAsync(Dictionary<int, List<int>> newByManga, CancellationToken cancellationToken)
    {
        try
        {
            var series = await stream.GetSeriesAsync(newByManga.Keys, cancellationToken).ConfigureAwait(false);
            var recentCutoff = DateTimeOffset.UtcNow.AddDays(-90);
            foreach (var userId in shelfStore.UserIds())
            {
                var shelf = shelfStore.Load(userId);
                var progress = progressStore.GetAll(userId);
                foreach (var one in series)
                {
                    var key = ShelfStore.SeriesShelfKey(one.Title);
                    if (shelf.Library?.Contains(key) != true)
                    {
                        continue;
                    }

                    var prefs = shelf.Series.GetValueOrDefault(key);
                    if (prefs?.SkipUpdates == true)
                    {
                        continue;
                    }

                    var reading = one.Chapters.Any(chapter => progress.TryGetValue(chapter.Id, out var record) && record.UpdatedAt >= recentCutoff);
                    if (!reading)
                    {
                        continue;
                    }

                    var excluded = prefs?.ExcludedScanlators;
                    var fresh = one.Chapters
                        .Where(chapter => newByManga[one.MangaId].Contains(chapter.ChapterId))
                        .Where(chapter => excluded is not { Count: > 0 } || chapter.Scanlator is null || !excluded.Contains(chapter.Scanlator, StringComparer.OrdinalIgnoreCase))
                        .OrderBy(chapter => chapter.Number)
                        .ToList();
                    if (fresh.Count == 0)
                    {
                        continue;
                    }

                    var newest = fresh[^1];
                    var detail = fresh.Count == 1 ? newest.Name : fresh.Count + " new chapters, up to " + newest.Name;
                    var id = "manga:" + one.MangaId + ":" + newest.ChapterId;
                    var now = DateTime.UtcNow;
                    notificationStore.Update(userId, notifications =>
                    {
                        if (notifications.Any(existing => existing.Id == id))
                        {
                            return;
                        }

                        notifications.Insert(
                            0,
                            new WatchlistNotification(id, Guid.Empty, one.Title, "Manga", now, "manga", detail, now, false, key, one.MangaId));
                    });
                }
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: could not send new chapter notifications");
        }
    }
}
