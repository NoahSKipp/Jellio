using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using MediaBrowser.Common.Configuration;

namespace Jellio.Services.Parties;

/// <summary>
/// Watch parties on top of Jellyfin's SyncPlay groups: SyncPlay keeps
/// playback in step, this keeps the social side (host, privacy, ready check,
/// countdown, schedules and the summary afterwards). Schedules and summaries
/// survive a restart; a live party's details live as long as its group.
/// </summary>
public class PartyService(IApplicationPaths applicationPaths)
{
    private const string CodeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    private const int MaxRequests = 50;
    private const int MaxSummaries = 60;
    private const int MaxCodeFailures = 10;
    private static readonly TimeSpan CodeFailureWindow = TimeSpan.FromMinutes(10);

    private readonly ConcurrentDictionary<Guid, PartyMeta> _parties = new();
    private readonly ConcurrentDictionary<string, Guid> _codes = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<Guid, (DateTime Since, int Count)> _codeFailures = new();
    private readonly JsonUserStore<List<ScheduledParty>> _schedules = new(applicationPaths, "parties", () => []);
    private readonly JsonUserStore<List<PartySummary>> _summaries = new(applicationPaths, "party-summaries", () => []);
    private long _nextRequestId;

    // Both files hold everyone's entries under one key.
    private static readonly Guid AllUsers = Guid.Empty;

    public PartyMeta? Get(Guid groupId) => _parties.TryGetValue(groupId, out var meta) ? meta : null;

    public IReadOnlyCollection<PartyMeta> All() => _parties.Values.ToList();

    // The first caller becomes the host.
    public PartyMeta Ensure(Guid groupId, Guid userId, string userName, string groupName)
    {
        var meta = _parties.GetOrAdd(groupId, id =>
        {
            var created = new PartyMeta { GroupId = id, HostUserId = userId, HostName = userName, Code = NewCode() };
            _codes[created.Code] = id;
            return created;
        });
        lock (meta)
        {
            if (!string.IsNullOrEmpty(groupName))
            {
                meta.GroupName = groupName;
            }

            meta.Attendees[userId] = userName;
        }

        return meta;
    }

    public bool IsHost(PartyMeta meta, Guid userId) => meta.HostUserId == userId;

    public void Configure(PartyMeta meta, bool? isPrivate, bool? hostOnly, string? scheduleId)
    {
        lock (meta)
        {
            if (isPrivate.HasValue)
            {
                meta.Private = isPrivate.Value;
            }

            if (hostOnly.HasValue)
            {
                meta.HostOnly = hostOnly.Value;
            }

            if (!string.IsNullOrEmpty(scheduleId))
            {
                meta.ScheduleId = scheduleId;
            }
        }
    }

    public void TransferHost(PartyMeta meta, Guid userId, string userName)
    {
        lock (meta)
        {
            meta.HostUserId = userId;
            meta.HostName = userName;
        }
    }

    // A new title for the group: the ready check and countdown start over.
    public void SetItem(PartyMeta meta, Guid itemId)
    {
        lock (meta)
        {
            meta.ItemId = itemId;
            meta.ItemStartedAt = DateTime.UtcNow;
            meta.Ready.Clear();
            meta.CountdownEndsAt = null;
            meta.CountdownPlaylistItemId = null;
            if (!meta.ItemsWatched.Contains(itemId))
            {
                meta.ItemsWatched.Add(itemId);
            }
        }
    }

    public void SetReady(PartyMeta meta, Guid userId, string userName, string playlistItemId, bool ready)
    {
        lock (meta)
        {
            if (ready)
            {
                meta.Ready[userId] = (userName, playlistItemId);
            }
            else
            {
                meta.Ready.Remove(userId);
            }

            meta.Attendees[userId] = userName;
        }
    }

    // Starts once per title; later calls keep the countdown already running.
    public DateTime StartCountdown(PartyMeta meta, string playlistItemId, int seconds)
    {
        lock (meta)
        {
            if (meta.CountdownEndsAt is { } running && meta.CountdownPlaylistItemId == playlistItemId)
            {
                return running;
            }

            meta.CountdownEndsAt = DateTime.UtcNow.AddSeconds(Math.Clamp(seconds, 1, 30));
            meta.CountdownPlaylistItemId = playlistItemId;
            return meta.CountdownEndsAt.Value;
        }
    }

    public PartyRequest AddRequest(PartyMeta meta, Guid userId, string userName, string kind, long? positionTicks)
    {
        var request = new PartyRequest(System.Threading.Interlocked.Increment(ref _nextRequestId), userId, userName, kind, positionTicks, DateTime.UtcNow);
        lock (meta)
        {
            meta.Requests.Add(request);
            if (meta.Requests.Count > MaxRequests)
            {
                meta.Requests.RemoveRange(0, meta.Requests.Count - MaxRequests);
            }
        }

        return request;
    }

    public void CountReaction(Guid groupId, string emoji)
    {
        if (!_parties.TryGetValue(groupId, out var meta))
        {
            return;
        }

        lock (meta)
        {
            meta.Reactions[emoji] = meta.Reactions.GetValueOrDefault(emoji) + 1;
        }
    }

    public void MarkSeen(PartyMeta meta, Guid userId, string userName)
    {
        lock (meta)
        {
            meta.Attendees[userId] = userName;
        }
    }

    // Wrong codes count per user, so a code can't be guessed by trying them.
    public Guid? ResolveCode(Guid userId, string code)
    {
        var now = DateTime.UtcNow;
        if (_codeFailures.TryGetValue(userId, out var record) && now - record.Since < CodeFailureWindow && record.Count >= MaxCodeFailures)
        {
            return null;
        }

        var clean = new string((code ?? string.Empty).Where(char.IsLetterOrDigit).ToArray()).ToUpperInvariant();
        if (_codes.TryGetValue(clean, out var groupId) && _parties.ContainsKey(groupId))
        {
            return groupId;
        }

        _codeFailures.AddOrUpdate(userId, _ => (now, 1), (_, current) => now - current.Since > CodeFailureWindow ? (now, 1) : (current.Since, current.Count + 1));
        return null;
    }

    public bool IsCodeThrottled(Guid userId) =>
        _codeFailures.TryGetValue(userId, out var record) && DateTime.UtcNow - record.Since < CodeFailureWindow && record.Count >= MaxCodeFailures;

    // A group that no longer exists: its party ends, with a summary when at
    // least two people watched something together.
    public PartySummary? End(Guid groupId)
    {
        if (!_parties.TryRemove(groupId, out var meta))
        {
            return null;
        }

        _codes.TryRemove(meta.Code, out _);
        lock (meta)
        {
            if (meta.ItemsWatched.Count == 0 || meta.Attendees.Count < 2)
            {
                return null;
            }

            var summary = new PartySummary
            {
                Id = groupId.ToString("N"),
                Name = string.IsNullOrEmpty(meta.GroupName) ? "Group Watch" : meta.GroupName,
                HostUserId = meta.HostUserId,
                HostName = meta.HostName,
                Members = meta.Attendees.Values.Distinct(StringComparer.Ordinal).ToList(),
                ItemIds = meta.ItemsWatched.ToList(),
                TopReactions = meta.Reactions.OrderByDescending(pair => pair.Value).Take(3).Select(pair => pair.Key).ToList(),
                StartedAt = meta.ItemStartedAt ?? meta.CreatedAt,
                EndedAt = DateTime.UtcNow,
            };
            _summaries.Update(AllUsers, list =>
            {
                list.Insert(0, summary);
                if (list.Count > MaxSummaries)
                {
                    list.RemoveRange(MaxSummaries, list.Count - MaxSummaries);
                }
            });
            return summary;
        }
    }

    public List<PartySummary> Summaries() => _summaries.Load(AllUsers);

    public List<ScheduledParty> Schedules() => _schedules.Load(AllUsers);

    public ScheduledParty AddSchedule(ScheduledParty party)
    {
        party.Id = Guid.NewGuid().ToString("N")[..12];
        _schedules.Update(AllUsers, list => list.Add(party));
        return party;
    }

    public ScheduledParty? UpdateSchedule(string id, Action<ScheduledParty> change)
    {
        ScheduledParty? found = null;
        _schedules.Update(AllUsers, list =>
        {
            found = list.FirstOrDefault(p => p.Id == id);
            if (found != null)
            {
                change(found);
            }
        });
        return found;
    }

    public bool RemoveSchedule(string id)
    {
        var removed = false;
        _schedules.UpdateIfChanged(AllUsers, list =>
        {
            removed = list.RemoveAll(p => p.Id == id) > 0;
            return removed;
        });
        return removed;
    }

    // Schedules long past their start, gone.
    public void PruneSchedules(DateTime now) =>
        _schedules.UpdateIfChanged(AllUsers, list => list.RemoveAll(p => now - p.StartsAt > TimeSpan.FromHours(6)) > 0);

    public static bool CanSee(ScheduledParty party, Guid userId) =>
        !party.Private || party.HostUserId == userId || party.InviteeUserIds.Contains(userId) || party.Going.ContainsKey(userId);

    private string NewCode()
    {
        while (true)
        {
            var code = string.Concat(Enumerable.Range(0, 6).Select(_ => CodeAlphabet[RandomNumberGenerator.GetInt32(CodeAlphabet.Length)]));
            if (!_codes.ContainsKey(code))
            {
                return code;
            }
        }
    }
}
