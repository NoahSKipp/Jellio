using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Claims;
using Jellio.Services.Parties;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Controller.SyncPlay;
using MediaBrowser.Controller.SyncPlay.Requests;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

/// <summary>
/// Watch parties: Group Watch groups with a host, privacy, join codes, a
/// ready check and countdown, schedules and a summary in the Feed.
/// SyncPlay itself has no roles or privacy, so private parties and
/// host-only controls are kept by Jellio's own apps; another Jellyfin
/// client can still see and join any group.
/// </summary>
[ApiController]
[Route("Jellio/parties")]
[Authorize]
public class PartiesController(
    PartyService parties,
    PartyMonitor monitor,
    ISessionManager sessionManager,
    ISyncPlayManager syncPlayManager,
    IUserManager userManager,
    ILibraryManager libraryManager) : ControllerBase
{
    public sealed record SetupRequest(bool? Private, bool? HostOnly, string? ScheduleId);

    public sealed record ItemRequest(Guid ItemId);

    public sealed record HostRequest(Guid UserId);

    public sealed record ControlRequest(string Kind, long? PositionTicks);

    public sealed record ReadyRequest(string PlaylistItemId, bool Ready);

    public sealed record CountdownRequest(string PlaylistItemId, int Seconds);

    public sealed record CodeRequest(string Code);

    public sealed record ScheduleRequest(string? Name, Guid? ItemId, DateTime StartsAt, bool Private, bool HostOnly, List<Guid>? InviteeUserIds);

    public sealed record RsvpRequest(bool Going);

    public sealed record StartedRequest(Guid GroupId);

    public sealed record PartyItem(Guid Id, string Name, string Type, string? SeriesName, Guid ImageItemId, int? SeasonNumber, int? EpisodeNumber, long? RunTimeTicks);

    [HttpGet]
    public IActionResult List()
    {
        var (userId, userName) = Caller();
        if (userId == Guid.Empty)
        {
            return Unauthorized();
        }

        var idsByName = userManager.GetUsers().GroupBy(u => u.Username, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First().Id, StringComparer.Ordinal);
        var schedules = parties.Schedules();
        var live = new List<object>();
        foreach (var group in Groups(userId))
        {
            var meta = parties.Get(group.GroupId);
            var participants = group.Participants.ToList();
            var isMember = participants.Contains(userName, StringComparer.Ordinal);
            var isHost = meta != null && meta.HostUserId == userId;
            var invited = meta?.ScheduleId is { } sid && schedules.Any(s => s.Id == sid && (s.InviteeUserIds.Contains(userId) || s.Going.ContainsKey(userId)));
            if (meta is { Private: true } && !isMember && !isHost && !invited)
            {
                continue;
            }

            var (positionTicks, isPlaying) = meta?.ItemId is { } playing ? Position(participants, playing) : (null, false);
            live.Add(new
            {
                group.GroupId,
                group.GroupName,
                State = group.State.ToString(),
                Participants = participants.Select(name => new { Name = name, UserId = idsByName.TryGetValue(name, out var id) ? id : (Guid?)null }),
                HostName = meta?.HostName,
                HostUserId = meta?.HostUserId,
                Private = meta?.Private ?? false,
                HostOnly = meta?.HostOnly ?? false,
                Code = isMember || isHost ? meta?.Code : null,
                Item = meta?.ItemId is { } itemId ? Describe(itemId) : null,
                PositionTicks = positionTicks,
                IsPlaying = isPlaying,
                StartedAt = meta?.ItemStartedAt,
                ScheduleId = meta?.ScheduleId,
            });
        }

        var now = DateTime.UtcNow;
        var scheduled = schedules
            .Where(p => PartyService.CanSee(p, userId) && now - p.StartsAt < TimeSpan.FromHours(3))
            .OrderBy(p => p.StartsAt)
            .Select(p => ScheduleView(p, userId, now));
        return Ok(new { Live = live, Scheduled = scheduled, ServerNow = now });
    }

    [HttpPost("{groupId:guid}/setup")]
    public IActionResult Setup(Guid groupId, [FromBody] SetupRequest body)
    {
        var (userId, userName) = Caller();
        var group = Groups(userId).FirstOrDefault(g => g.GroupId == groupId);
        if (group == null)
        {
            return NotFound();
        }

        var meta = parties.Ensure(groupId, userId, userName, group.GroupName);
        if (!parties.IsHost(meta, userId))
        {
            return Forbid();
        }

        parties.Configure(meta, body.Private, body.HostOnly, body.ScheduleId);
        return Ok(State(meta, userId, 0));
    }

    [HttpGet("{groupId:guid}/state")]
    public IActionResult GetState(Guid groupId, [FromQuery] long after = 0)
    {
        var (userId, userName) = Caller();
        var meta = parties.Get(groupId);
        if (meta == null)
        {
            var group = Groups(userId).FirstOrDefault(g => g.GroupId == groupId);
            if (group == null)
            {
                return NotFound();
            }

            meta = parties.Ensure(groupId, userId, userName, group.GroupName);
        }
        else
        {
            parties.MarkSeen(meta, userId, userName);
        }

        return Ok(State(meta, userId, after));
    }

    [HttpPost("{groupId:guid}/item")]
    public IActionResult SetItem(Guid groupId, [FromBody] ItemRequest body)
    {
        var (userId, userName) = Caller();
        var group = Groups(userId).FirstOrDefault(g => g.GroupId == groupId);
        if (group == null)
        {
            return NotFound();
        }

        var meta = parties.Ensure(groupId, userId, userName, group.GroupName);
        parties.SetItem(meta, body.ItemId);
        return Ok();
    }

    [HttpPost("{groupId:guid}/host")]
    public IActionResult Transfer(Guid groupId, [FromBody] HostRequest body)
    {
        var (userId, _) = Caller();
        var meta = parties.Get(groupId);
        var target = userManager.GetUserById(body.UserId);
        if (meta == null || target == null)
        {
            return NotFound();
        }

        if (!parties.IsHost(meta, userId))
        {
            return Forbid();
        }

        parties.TransferHost(meta, target.Id, target.Username);
        return Ok();
    }

    // Asking the host to pause, play or seek when only the host controls.
    [HttpPost("{groupId:guid}/request")]
    public IActionResult Request(Guid groupId, [FromBody] ControlRequest body)
    {
        var (userId, userName) = Caller();
        var meta = parties.Get(groupId);
        if (meta == null)
        {
            return NotFound();
        }

        var kind = body.Kind is "pause" or "play" or "seek" ? body.Kind : null;
        if (kind == null)
        {
            return BadRequest();
        }

        return Ok(parties.AddRequest(meta, userId, userName, kind, body.PositionTicks));
    }

    [HttpPost("{groupId:guid}/ready")]
    public IActionResult Ready(Guid groupId, [FromBody] ReadyRequest body)
    {
        var (userId, userName) = Caller();
        var meta = parties.Get(groupId);
        if (meta == null || string.IsNullOrEmpty(body.PlaylistItemId))
        {
            return NotFound();
        }

        parties.SetReady(meta, userId, userName, body.PlaylistItemId, body.Ready);
        return Ok();
    }

    [HttpPost("{groupId:guid}/countdown")]
    public IActionResult Countdown(Guid groupId, [FromBody] CountdownRequest body)
    {
        var meta = parties.Get(groupId);
        if (meta == null || string.IsNullOrEmpty(body.PlaylistItemId))
        {
            return NotFound();
        }

        var endsAt = parties.StartCountdown(meta, body.PlaylistItemId, body.Seconds);
        return Ok(new { EndsAt = endsAt, ServerNow = DateTime.UtcNow });
    }

    [HttpPost("code")]
    public IActionResult ResolveCode([FromBody] CodeRequest body)
    {
        var (userId, _) = Caller();
        if (parties.IsCodeThrottled(userId))
        {
            return StatusCode(429);
        }

        var groupId = parties.ResolveCode(userId, body.Code);
        return groupId is { } id ? Ok(new { GroupId = id }) : NotFound();
    }

    [HttpPost("schedule")]
    public IActionResult Schedule([FromBody] ScheduleRequest body)
    {
        var (userId, userName) = Caller();
        var startsAt = body.StartsAt.Kind == DateTimeKind.Unspecified ? DateTime.SpecifyKind(body.StartsAt, DateTimeKind.Utc) : body.StartsAt.ToUniversalTime();
        if (startsAt < DateTime.UtcNow.AddMinutes(-5) || startsAt > DateTime.UtcNow.AddDays(60))
        {
            return BadRequest(new { Error = "bad_time" });
        }

        var name = (body.Name ?? string.Empty).Trim();
        if (name.Length == 0 && body.ItemId is { } titleId)
        {
            name = Describe(titleId)?.Name ?? string.Empty;
        }

        var party = parties.AddSchedule(new ScheduledParty
        {
            Name = name.Length == 0 ? "Watch party" : name.Length > 100 ? name[..100] : name,
            HostUserId = userId,
            HostName = userName,
            ItemId = body.ItemId,
            StartsAt = startsAt,
            Private = body.Private,
            HostOnly = body.HostOnly,
            InviteeUserIds = (body.InviteeUserIds ?? []).Where(id => id != userId && userManager.GetUserById(id) != null).Distinct().Take(50).ToList(),
            Going = new Dictionary<Guid, string> { [userId] = userName },
        });
        var now = DateTime.UtcNow;
        foreach (var invitee in party.InviteeUserIds)
        {
            monitor.Notify(invitee, PartyMonitor.ScheduledKind, party, now);
        }

        return Ok(ScheduleView(party, userId, now));
    }

    [HttpPost("schedule/{id}/rsvp")]
    public IActionResult Rsvp(string id, [FromBody] RsvpRequest body)
    {
        var (userId, userName) = Caller();
        var party = parties.Schedules().FirstOrDefault(p => p.Id == id);
        if (party == null || !PartyService.CanSee(party, userId))
        {
            return NotFound();
        }

        var updated = parties.UpdateSchedule(id, p =>
        {
            if (body.Going)
            {
                p.Going[userId] = userName;
            }
            else if (p.HostUserId != userId)
            {
                p.Going.Remove(userId);
            }
        });
        return Ok(ScheduleView(updated!, userId, DateTime.UtcNow));
    }

    [HttpDelete("schedule/{id}")]
    public IActionResult Cancel(string id)
    {
        var (userId, _) = Caller();
        var party = parties.Schedules().FirstOrDefault(p => p.Id == id);
        if (party == null)
        {
            return NotFound();
        }

        if (party.HostUserId != userId)
        {
            return Forbid();
        }

        parties.RemoveSchedule(id);
        return Ok();
    }

    // The group a scheduled party now runs in; everyone invited is told.
    [HttpPost("schedule/{id}/started")]
    public IActionResult Started(string id, [FromBody] StartedRequest body)
    {
        var (userId, userName) = Caller();
        var party = parties.Schedules().FirstOrDefault(p => p.Id == id);
        var group = Groups(userId).FirstOrDefault(g => g.GroupId == body.GroupId);
        if (party == null || group == null || !PartyService.CanSee(party, userId))
        {
            return NotFound();
        }

        var meta = parties.Ensure(body.GroupId, party.HostUserId, party.HostName, group.GroupName);
        if (meta.HostUserId != party.HostUserId && meta.HostUserId == userId)
        {
            // Whoever started it hosts until the planned host arrives.
            parties.TransferHost(meta, userId, userName);
        }

        parties.Configure(meta, party.Private, party.HostOnly, party.Id);
        var updated = parties.UpdateSchedule(id, p => p.GroupId = body.GroupId);
        var now = DateTime.UtcNow;
        foreach (var person in party.InviteeUserIds.Concat(party.Going.Keys).Append(party.HostUserId).Distinct().Where(p => p != userId))
        {
            monitor.Notify(person, PartyMonitor.StartingKind, updated!, now);
        }

        return Ok(ScheduleView(updated!, userId, now));
    }

    private object State(PartyMeta meta, Guid userId, long after)
    {
        lock (meta)
        {
            return new
            {
                meta.GroupId,
                meta.HostUserId,
                meta.HostName,
                IsHost = meta.HostUserId == userId,
                meta.Private,
                meta.HostOnly,
                meta.Code,
                meta.ItemId,
                CountdownEndsAt = meta.CountdownEndsAt,
                meta.CountdownPlaylistItemId,
                Ready = meta.Ready.Select(pair => new { UserId = pair.Key, pair.Value.Name, pair.Value.PlaylistItemId }).ToList(),
                Requests = meta.Requests.Where(r => r.Id > after).ToList(),
                ServerNow = DateTime.UtcNow,
            };
        }
    }

    private object ScheduleView(ScheduledParty party, Guid userId, DateTime now)
    {
        var groupLive = party.GroupId is { } gid && Groups(userId).Any(g => g.GroupId == gid);
        var invited = party.InviteeUserIds.Contains(userId);
        return new
        {
            party.Id,
            party.Name,
            party.HostName,
            party.HostUserId,
            party.StartsAt,
            party.Private,
            party.HostOnly,
            Item = party.ItemId is { } itemId ? Describe(itemId) : null,
            Going = party.Going.Values.ToList(),
            IsGoing = party.Going.ContainsKey(userId),
            IsHost = party.HostUserId == userId,
            Invited = invited,
            GroupId = groupLive ? party.GroupId : null,
            // The host any time; the others once it is due and the host
            // hasn't started it.
            CanStart = !groupLive && (party.HostUserId == userId || (now >= party.StartsAt && (invited || party.Going.ContainsKey(userId)))),
        };
    }

    private PartyItem? Describe(Guid itemId)
    {
        var item = libraryManager.GetItemById(itemId);
        if (item == null)
        {
            return null;
        }

        var series = item as Episode;
        return new PartyItem(
            item.Id,
            item.Name,
            item.GetBaseItemKind().ToString(),
            series?.SeriesName,
            series != null && series.SeriesId != Guid.Empty ? series.SeriesId : item.Id,
            series?.ParentIndexNumber,
            series?.IndexNumber,
            item.RunTimeTicks);
    }

    // Where the party's members have got to in its title, from their sessions.
    private (long? PositionTicks, bool IsPlaying) Position(List<string> participants, Guid itemId)
    {
        var session = sessionManager.Sessions
            .Where(s => s.NowPlayingItem != null && s.NowPlayingItem.Id == itemId && participants.Contains(s.UserName, StringComparer.Ordinal))
            .OrderByDescending(s => s.LastActivityDate)
            .FirstOrDefault();
        return session == null ? (null, false) : (session.PlayState?.PositionTicks, !(session.PlayState?.IsPaused ?? true));
    }

    private IEnumerable<MediaBrowser.Model.SyncPlay.GroupInfoDto> Groups(Guid userId)
    {
        var session = sessionManager.Sessions.FirstOrDefault(s => s.UserId == userId) ?? sessionManager.Sessions.FirstOrDefault();
        return session == null ? [] : syncPlayManager.ListGroups(session, new ListGroupsRequest());
    }

    private (Guid UserId, string UserName) Caller()
    {
        if (HttpContext.User.Identity is ClaimsIdentity identity
            && Guid.TryParse(identity.FindFirst("Jellyfin-UserId")?.Value, out var userId))
        {
            return (userId, userManager.GetUserById(userId)?.Username ?? "Someone");
        }

        return (Guid.Empty, string.Empty);
    }
}
