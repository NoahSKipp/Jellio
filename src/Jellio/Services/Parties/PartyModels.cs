using System;
using System.Collections.Generic;

namespace Jellio.Services.Parties;

public sealed record PartyRequest(long Id, Guid UserId, string UserName, string Kind, long? PositionTicks, DateTime At);

// What Jellio keeps about a SyncPlay group on top of what Jellyfin knows:
// who hosts it, whether it is private, the ready check and the countdown.
// In memory: a party lives as long as its group.
public sealed class PartyMeta
{
    public Guid GroupId { get; init; }

    public Guid HostUserId { get; set; }

    public string HostName { get; set; } = string.Empty;

    public bool Private { get; set; }

    public bool HostOnly { get; set; }

    public string Code { get; set; } = string.Empty;

    public string? ScheduleId { get; set; }

    public DateTime CreatedAt { get; init; } = DateTime.UtcNow;

    public Guid? ItemId { get; set; }

    public DateTime? ItemStartedAt { get; set; }

    public DateTime? CountdownEndsAt { get; set; }

    public string? CountdownPlaylistItemId { get; set; }

    public Dictionary<Guid, (string Name, string PlaylistItemId)> Ready { get; } = new();

    public List<PartyRequest> Requests { get; } = new();

    public Dictionary<Guid, string> Attendees { get; } = new();

    // Let into a private party: by its code or by an invite.
    public HashSet<Guid> Admitted { get; } = new();

    public List<Guid> ItemsWatched { get; } = new();

    public Dictionary<string, int> Reactions { get; } = new(StringComparer.Ordinal);

    public string GroupName { get; set; } = string.Empty;
}

public sealed class ScheduledParty
{
    public string Id { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    public Guid HostUserId { get; set; }

    public string HostName { get; set; } = string.Empty;

    public Guid? ItemId { get; set; }

    public DateTime StartsAt { get; set; }

    public bool Private { get; set; }

    public bool HostOnly { get; set; }

    // Empty means everyone on the server may see it (when not private).
    public List<Guid> InviteeUserIds { get; set; } = [];

    public Dictionary<Guid, string> Going { get; set; } = new();

    public Guid? GroupId { get; set; }

    public bool StartNoticeSent { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class PartySummary
{
    public string Id { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    public Guid HostUserId { get; set; }

    public string HostName { get; set; } = string.Empty;

    public List<string> Members { get; set; } = [];

    public List<Guid> ItemIds { get; set; } = [];

    public List<string> TopReactions { get; set; } = [];

    public DateTime StartedAt { get; set; }

    public DateTime EndedAt { get; set; }
}
