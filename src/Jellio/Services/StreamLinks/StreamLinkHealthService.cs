using System;
using System.Linq;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellio.Services.StreamLinks;

// Re-checks every saved link every few hours. A link that stops working
// is marked in My streams and its owner gets one Jellio notification.
public class StreamLinkHealthService(
    StreamLinkStore store,
    StreamLinkResolver resolver,
    NotificationStore notifications,
    ILogger<StreamLinkHealthService> logger) : BackgroundService
{
    public const int FailuresBeforeFailing = 2;
    public const string NotificationKind = "streamlink";
    private static readonly TimeSpan FirstRunDelay = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan Interval = TimeSpan.FromHours(4);
    private static readonly TimeSpan PauseBetweenLinks = TimeSpan.FromSeconds(3);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await Task.Delay(FirstRunDelay, stoppingToken).ConfigureAwait(false);
            while (!stoppingToken.IsCancellationRequested)
            {
                await CheckAllAsync(stoppingToken).ConfigureAwait(false);
                await Task.Delay(Interval, stoppingToken).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
    }

    public async Task CheckAllAsync(CancellationToken ct)
    {
        int checkedCount = 0, failing = 0;
        foreach (var userId in store.UserIds())
        {
            foreach (var link in store.List(userId).ToList())
            {
                ct.ThrowIfCancellationRequested();
                var error = await CheckAsync(link, ct).ConfigureAwait(false);
                checkedCount++;
                if (error != null)
                {
                    failing++;
                }

                if (store.RecordCheck(userId, link.Id, error, FailuresBeforeFailing))
                {
                    Notify(userId, link);
                }

                await Task.Delay(PauseBetweenLinks, ct).ConfigureAwait(false);
            }
        }

        if (checkedCount > 0)
        {
            logger.LogInformation("Jellio stream links checked: {Count}, not answering: {Failing}", checkedCount, failing);
        }
    }

    // Null when the link still leads to a stream or a channel list.
    private async Task<string?> CheckAsync(StreamLink link, CancellationToken ct)
    {
        if (!PublicAddressGuard.TryParseLink(link.SourceUrl, out var source))
        {
            return StreamLinkErrors.InvalidUrl;
        }

        try
        {
            var result = await resolver.ResolveAsync(source, ct, useCache: false).ConfigureAwait(false);
            return result.Stream != null || result.Entries is { Count: > 0 } ? null : StreamLinkErrors.NoStream;
        }
        catch (StreamLinkException err)
        {
            return err.Code;
        }
        catch (HttpRequestException)
        {
            return StreamLinkErrors.Unreachable;
        }
    }

    private void Notify(Guid userId, StreamLink link)
    {
        var now = DateTime.UtcNow;
        notifications.Update(userId, list =>
        {
            list.RemoveAll(n => n.Kind == NotificationKind && n.SeriesKey == link.Id);
            list.Insert(0, new WatchlistNotification(
                "streamlink-" + link.Id + "-" + now.Ticks,
                Guid.Empty,
                link.Name,
                "StreamLink",
                now,
                NotificationKind,
                link.LastError,
                now,
                false,
                link.Id));
        });
    }
}
