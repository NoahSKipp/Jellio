using System;
using System.Collections.Generic;
using System.Linq;

namespace Jellio.Services.Friends;

public class Friendship
{
    public Guid UserA { get; set; }

    public Guid UserB { get; set; }

    public DateTime Since { get; set; }

    public bool MutedByA { get; set; }

    public bool MutedByB { get; set; }
}

public class FriendRequest
{
    public string Id { get; set; } = string.Empty;

    public Guid From { get; set; }

    public Guid To { get; set; }

    public DateTime At { get; set; }
}

public class DeclinedRequest
{
    public Guid From { get; set; }

    public Guid To { get; set; }

    public DateTime At { get; set; }
}

public class FriendsData
{
    public List<Friendship> Friendships { get; set; } = [];

    public List<FriendRequest> Requests { get; set; } = [];

    public List<DeclinedRequest> Declines { get; set; } = [];
}

public enum SendOutcome
{
    Sent,
    AutoAccepted,
    Self,
    AlreadyFriends,
    AlreadyPending,
    Cooldown,
    FriendLimit,
    PendingLimit,
}

public enum RespondOutcome
{
    Done,
    NotFound,
    FriendLimit,
}

public record SendResult(SendOutcome Outcome, FriendRequest? Request);

public record RespondResult(RespondOutcome Outcome, FriendRequest? Request);

public record FriendStatus(string Status, string? RequestId);

// Pure friendship state machine over FriendsData. Callers hold the lock.
public static class FriendsGraph
{
    public const int MaxFriends = 200;
    public const int MaxPendingOutgoing = 50;
    public static readonly TimeSpan DeclineCooldown = TimeSpan.FromHours(24);

    public static Friendship? Find(FriendsData data, Guid a, Guid b) =>
        data.Friendships.FirstOrDefault(f =>
            (f.UserA == a && f.UserB == b) || (f.UserA == b && f.UserB == a));

    public static bool AreFriends(FriendsData data, Guid a, Guid b) => Find(data, a, b) != null;

    public static int FriendCount(FriendsData data, Guid user) =>
        data.Friendships.Count(f => f.UserA == user || f.UserB == user);

    public static IEnumerable<Guid> FriendIds(FriendsData data, Guid user) =>
        data.Friendships
            .Where(f => f.UserA == user || f.UserB == user)
            .Select(f => f.UserA == user ? f.UserB : f.UserA);

    // True when `muter` muted `friend`.
    public static bool IsMuted(FriendsData data, Guid muter, Guid friend)
    {
        var f = Find(data, muter, friend);
        return f != null && (f.UserA == muter ? f.MutedByA : f.MutedByB);
    }

    public static bool SetMuted(FriendsData data, Guid muter, Guid friend, bool muted)
    {
        var f = Find(data, muter, friend);
        if (f == null)
        {
            return false;
        }

        if (f.UserA == muter)
        {
            f.MutedByA = muted;
        }
        else
        {
            f.MutedByB = muted;
        }

        return true;
    }

    public static bool InCooldown(FriendsData data, Guid from, Guid to, DateTime now) =>
        data.Declines.Any(d => d.From == from && d.To == to && now - d.At < DeclineCooldown);

    public static FriendStatus StatusFor(FriendsData data, Guid viewer, Guid other)
    {
        if (viewer == other)
        {
            return new FriendStatus("self", null);
        }

        if (AreFriends(data, viewer, other))
        {
            return new FriendStatus("friends", null);
        }

        var outgoing = data.Requests.FirstOrDefault(r => r.From == viewer && r.To == other);
        if (outgoing != null)
        {
            return new FriendStatus("outgoing", outgoing.Id);
        }

        var incoming = data.Requests.FirstOrDefault(r => r.From == other && r.To == viewer);
        return incoming != null ? new FriendStatus("incoming", incoming.Id) : new FriendStatus("none", null);
    }

    public static bool CanRequest(FriendsData data, Guid viewer, Guid other, DateTime now) =>
        StatusFor(data, viewer, other).Status == "none"
        && !InCooldown(data, viewer, other, now)
        && FriendCount(data, viewer) < MaxFriends
        && data.Requests.Count(r => r.From == viewer) < MaxPendingOutgoing;

    public static SendResult Send(FriendsData data, Guid from, Guid to, DateTime now, Func<string>? newId = null)
    {
        PruneDeclines(data, now);
        if (from == to)
        {
            return new SendResult(SendOutcome.Self, null);
        }

        if (AreFriends(data, from, to))
        {
            return new SendResult(SendOutcome.AlreadyFriends, null);
        }

        var existing = data.Requests.FirstOrDefault(r => r.From == from && r.To == to);
        if (existing != null)
        {
            return new SendResult(SendOutcome.AlreadyPending, existing);
        }

        var reverse = data.Requests.FirstOrDefault(r => r.From == to && r.To == from);
        if (reverse != null)
        {
            var accepted = Accept(data, reverse.Id, from, now);
            return accepted.Outcome == RespondOutcome.Done
                ? new SendResult(SendOutcome.AutoAccepted, reverse)
                : new SendResult(SendOutcome.FriendLimit, reverse);
        }

        if (InCooldown(data, from, to, now))
        {
            return new SendResult(SendOutcome.Cooldown, null);
        }

        if (FriendCount(data, from) >= MaxFriends)
        {
            return new SendResult(SendOutcome.FriendLimit, null);
        }

        if (data.Requests.Count(r => r.From == from) >= MaxPendingOutgoing)
        {
            return new SendResult(SendOutcome.PendingLimit, null);
        }

        var request = new FriendRequest
        {
            Id = (newId ?? (() => Guid.NewGuid().ToString("N")))(),
            From = from,
            To = to,
            At = now,
        };
        data.Requests.Add(request);
        return new SendResult(SendOutcome.Sent, request);
    }

    public static RespondResult Accept(FriendsData data, string requestId, Guid acceptor, DateTime now)
    {
        var request = data.Requests.FirstOrDefault(r => r.Id == requestId && r.To == acceptor);
        if (request == null)
        {
            return new RespondResult(RespondOutcome.NotFound, null);
        }

        if (FriendCount(data, request.From) >= MaxFriends || FriendCount(data, request.To) >= MaxFriends)
        {
            return new RespondResult(RespondOutcome.FriendLimit, request);
        }

        data.Requests.Remove(request);
        // Drop a crossed request between the same pair so no stale one lingers.
        data.Requests.RemoveAll(r => r.From == request.To && r.To == request.From);
        data.Friendships.Add(new Friendship { UserA = request.From, UserB = request.To, Since = now });
        return new RespondResult(RespondOutcome.Done, request);
    }

    public static RespondResult Decline(FriendsData data, string requestId, Guid decliner, DateTime now)
    {
        var request = data.Requests.FirstOrDefault(r => r.Id == requestId && r.To == decliner);
        if (request == null)
        {
            return new RespondResult(RespondOutcome.NotFound, null);
        }

        data.Requests.Remove(request);
        data.Declines.RemoveAll(d => d.From == request.From && d.To == request.To);
        data.Declines.Add(new DeclinedRequest { From = request.From, To = request.To, At = now });
        PruneDeclines(data, now);
        return new RespondResult(RespondOutcome.Done, request);
    }

    public static RespondResult Cancel(FriendsData data, string requestId, Guid sender)
    {
        var request = data.Requests.FirstOrDefault(r => r.Id == requestId && r.From == sender);
        if (request == null)
        {
            return new RespondResult(RespondOutcome.NotFound, null);
        }

        data.Requests.Remove(request);
        return new RespondResult(RespondOutcome.Done, request);
    }

    public static bool Remove(FriendsData data, Guid a, Guid b) =>
        data.Friendships.RemoveAll(f =>
            (f.UserA == a && f.UserB == b) || (f.UserA == b && f.UserB == a)) > 0;

    public static void PruneDeclines(FriendsData data, DateTime now) =>
        data.Declines.RemoveAll(d => now - d.At >= DeclineCooldown);

    // Drops everything that references a user that no longer exists.
    public static void ForgetUser(FriendsData data, Guid user)
    {
        data.Friendships.RemoveAll(f => f.UserA == user || f.UserB == user);
        data.Requests.RemoveAll(r => r.From == user || r.To == user);
        data.Declines.RemoveAll(d => d.From == user || d.To == user);
    }
}
