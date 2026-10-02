using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
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
            }

            logger.LogInformation("Jellio: manga library refresh found {Count} new chapters", added);
            return added;
        }
        finally
        {
            _running.Release();
        }
    }
}
