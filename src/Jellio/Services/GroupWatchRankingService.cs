using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Serialization;

namespace Jellio.Services;

// String rather than this plugin's own real default (a bare enum
// serializes as its plain integer value, confirmed against
// AchievementsController.cs's own explicit Rarity = badge.Rarity.ToString(),
// the same real reason that call is there at all): RankingSession is
// returned straight off GroupWatchRankingController, no anonymous
// projection re-listing every field the way that controller's own
// Build() does, so the enum needs to carry its own readable JSON shape
// instead.
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum RankingStatus
{
    Voting,
    Finished,
}

public class RankingPair
{
    public Guid ItemA { get; set; }

    public Guid? ItemB { get; set; }

    public Dictionary<Guid, Guid> Votes { get; set; } = new();
}

public class RankingSession
{
    public Guid GroupId { get; set; }

    public Guid InitiatorUserId { get; set; }

    public int Round { get; set; } = 1;

    public List<RankingPair> Pairs { get; set; } = new();

    public RankingStatus Status { get; set; } = RankingStatus.Voting;

    public Guid? WinnerItemId { get; set; }

    public DateTime RoundDeadlineUtc { get; set; }

    public long Version { get; set; }
}

/// <summary>
/// A real single elimination bracket over a Group Watch group's own
/// pooled Grouplists (Controllers/GroupWatchRankingController.cs's own
/// header explains why the pool itself is resolved there, not here), in
/// memory only, same real ephemeral tradeoff GroupWatchChatService's own
/// header already makes for the identical reason: a plugin restart
/// clearing an in progress pick is an acceptable cost, a persistence
/// schema for it is not a real need. One active session per group,
/// starting a new one while one is already running just replaces it,
/// same real lax trust GroupWatchInviteController's own header already
/// documents for this whole feature area.
///
/// Round resolution is a flat per round timer rather than waiting until
/// everyone in the group has actually voted: real group membership at
/// any given moment is not something this plugin can see server side
/// (confirmed against real SyncPlayController.cs before writing this,
/// the same real gap GroupWatchChatController's own header already
/// lives with), so there is no real way to know how many votes
/// "everyone" actually is. A flat timer means a round always resolves
/// eventually regardless of who is actually still there to vote, ties
/// and zero vote pairs broken at random rather than left stuck.
///
/// Byes: for a pool that is not already a power of two, real standard
/// tournament seeding, byes = 2P - N where P is the largest power of
/// two <= N, guarantees the survivor count after round one is exactly
/// P, a clean power of two every round after that needs no more byes
/// for.
/// </summary>
public class GroupWatchRankingService(GroupWatchChatService chatService)
{
    private const int RoundDurationSeconds = 45;

    private readonly ConcurrentDictionary<Guid, RankingSession> _sessionsByGroup = new();
    private readonly Random _random = new();

    public RankingSession Start(Guid groupId, Guid initiatorUserId, IReadOnlyList<Guid> itemIds)
    {
        var shuffled = itemIds.OrderBy(_ => _random.Next()).ToList();
        var session = new RankingSession
        {
            GroupId = groupId,
            InitiatorUserId = initiatorUserId,
            Round = 1,
            Pairs = BuildFirstRoundPairs(shuffled),
            RoundDeadlineUtc = DateTime.UtcNow.AddSeconds(RoundDurationSeconds),
        };

        _sessionsByGroup[groupId] = session;
        return session;
    }

    public RankingSession? Get(Guid groupId)
    {
        if (!_sessionsByGroup.TryGetValue(groupId, out var session))
        {
            return null;
        }

        ResolveRoundIfDue(session);
        return session;
    }

    public RankingSession? Vote(Guid groupId, Guid userId, Guid itemId)
    {
        if (!_sessionsByGroup.TryGetValue(groupId, out var session))
        {
            return null;
        }

        ResolveRoundIfDue(session);
        if (session.Status == RankingStatus.Voting)
        {
            var pair = session.Pairs.FirstOrDefault(p => p.ItemA == itemId || p.ItemB == itemId);
            if (pair != null)
            {
                pair.Votes[userId] = itemId;
                session.Version++;
            }
        }

        return session;
    }

    public void Cancel(Guid groupId)
    {
        _sessionsByGroup.TryRemove(groupId, out _);
    }

    private void ResolveRoundIfDue(RankingSession session)
    {
        if (session.Status != RankingStatus.Voting || DateTime.UtcNow < session.RoundDeadlineUtc)
        {
            return;
        }

        var winners = new List<Guid>();
        foreach (var pair in session.Pairs)
        {
            if (pair.ItemB is null)
            {
                winners.Add(pair.ItemA);
                continue;
            }

            var votesForA = pair.Votes.Values.Count(v => v == pair.ItemA);
            var votesForB = pair.Votes.Values.Count(v => v == pair.ItemB);
            if (votesForA == votesForB)
            {
                winners.Add(_random.Next(2) == 0 ? pair.ItemA : pair.ItemB.Value);
            }
            else
            {
                winners.Add(votesForA > votesForB ? pair.ItemA : pair.ItemB.Value);
            }
        }

        if (winners.Count <= 1)
        {
            session.Status = RankingStatus.Finished;
            session.WinnerItemId = winners.Count == 1 ? winners[0] : null;
            session.Version++;
            if (session.WinnerItemId is { } winnerId)
            {
                chatService.Add(session.GroupId, Guid.Empty, "Group Watch", "The group picked this to watch", winnerId);
            }

            return;
        }

        session.Round++;
        session.Pairs = BuildPairs(winners);
        session.RoundDeadlineUtc = DateTime.UtcNow.AddSeconds(RoundDurationSeconds);
        session.Version++;
    }

    private static List<RankingPair> BuildFirstRoundPairs(List<Guid> items)
    {
        var n = items.Count;
        var byes = IsPowerOfTwo(n) ? 0 : (2 * LargestPowerOfTwoLessThan(n)) - n;

        var pairs = new List<RankingPair>();
        var index = 0;
        for (var i = 0; i < byes; i++)
        {
            pairs.Add(new RankingPair { ItemA = items[index++], ItemB = null });
        }

        while (index < n)
        {
            var itemA = items[index++];
            var itemB = index < n ? items[index++] : (Guid?)null;
            pairs.Add(new RankingPair { ItemA = itemA, ItemB = itemB });
        }

        return pairs;
    }

    private static List<RankingPair> BuildPairs(List<Guid> items)
    {
        var pairs = new List<RankingPair>();
        for (var i = 0; i < items.Count; i += 2)
        {
            pairs.Add(new RankingPair
            {
                ItemA = items[i],
                ItemB = i + 1 < items.Count ? items[i + 1] : (Guid?)null,
            });
        }

        return pairs;
    }

    private static bool IsPowerOfTwo(int n) => n > 0 && (n & (n - 1)) == 0;

    private static int LargestPowerOfTwoLessThan(int n)
    {
        var p = 1;
        while (p * 2 < n)
        {
            p *= 2;
        }

        return p;
    }
}
