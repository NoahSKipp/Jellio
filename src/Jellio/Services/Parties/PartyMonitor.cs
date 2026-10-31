using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Session;
using MediaBrowser.Controller.SyncPlay;
using MediaBrowser.Controller.SyncPlay.Requests;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellio.Services.Parties;

// Once a minute: tells people a scheduled party is starting, and ends the
// parties whose SyncPlay group is gone (writing their summary).
public class PartyMonitor(
    PartyService parties,
    ISessionManager sessionManager,
    ISyncPlayManager syncPlayManager,
    NotificationStore notifications,
    ILogger<PartyMonitor> logger) : BackgroundService
{
    public const string StartingKind = "party_starting";
    public const string ScheduledKind = "party_scheduled";
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(1);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
                    Tick(DateTime.UtcNow);
                }
                catch (Exception ex)
                {
                    logger.LogWarning(ex, "Jellio: watch party check failed");
                }

                await Task.Delay(Interval, stoppingToken).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
    }

    public void Tick(DateTime now)
    {
        var session = sessionManager.Sessions.FirstOrDefault();
        if (session != null)
        {
            var live = syncPlayManager.ListGroups(session, new ListGroupsRequest()).Select(g => g.GroupId).ToHashSet();
            foreach (var meta in parties.All().Where(m => !live.Contains(m.GroupId)))
            {
                var summary = parties.End(meta.GroupId);
                if (summary != null)
                {
                    logger.LogInformation("Jellio: watch party ended with {Members} people", summary.Members.Count);
                }
            }
        }

        foreach (var due in parties.Schedules().Where(p => !p.StartNoticeSent && p.StartsAt <= now))
        {
            parties.UpdateSchedule(due.Id, p => p.StartNoticeSent = true);
            var people = new HashSet<Guid>(due.InviteeUserIds.Concat(due.Going.Keys)) { due.HostUserId };
            foreach (var userId in people)
            {
                Notify(userId, StartingKind, due, now);
            }
        }

        parties.PruneSchedules(now);
    }

    public void Notify(Guid userId, string kind, ScheduledParty party, DateTime now)
    {
        notifications.Update(userId, list =>
        {
            list.RemoveAll(n => n.SeriesKey == party.Id && (n.Kind == StartingKind || n.Kind == ScheduledKind));
            list.Insert(0, new WatchlistNotification(
                kind + "-" + party.Id + "-" + now.Ticks,
                party.ItemId ?? Guid.Empty,
                party.Name,
                "WatchParty",
                party.StartsAt,
                kind,
                party.HostName,
                now,
                false,
                party.Id));
        });
    }
}
