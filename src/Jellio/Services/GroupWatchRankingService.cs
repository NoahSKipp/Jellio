using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Serialization;

namespace Jellio.Services;

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

    public int RoundLengthSeconds { get; set; }

    public long Version { get; set; }

    [JsonIgnore]
    public int ExpectedVoterCount { get; set; }
}

public class GroupWatchRankingService(GroupWatchChatService chatService)
{
    private const int RoundDurationSeconds = 45;

    private readonly ConcurrentDictionary<Guid, RankingSession> _sessionsByGroup = new();
    private readonly Random _random = new();

    private readonly object _lock = new();

    private static readonly TimeSpan StaleSessionAge = TimeSpan.FromHours(24);

    public RankingSession Start(Guid groupId, Guid initiatorUserId, IReadOnlyList<Guid> itemIds, int expectedVoterCount)
    {
        lock (_lock)
        {
            SweepStaleSessions();

            var shuffled = itemIds.OrderBy(_ => _random.Next()).ToList();
            var session = new RankingSession
            {
                GroupId = groupId,
                InitiatorUserId = initiatorUserId,
                Round = 1,
                Pairs = BuildFirstRoundPairs(shuffled),
                RoundDeadlineUtc = DateTime.UtcNow.AddSeconds(RoundDurationSeconds),
                RoundLengthSeconds = RoundDurationSeconds,
                ExpectedVoterCount = Math.Max(1, expectedVoterCount),
            };

            _sessionsByGroup[groupId] = session;
            return session;
        }
    }

    public RankingSession? Get(Guid groupId)
    {
        lock (_lock)
        {
            if (!_sessionsByGroup.TryGetValue(groupId, out var session))
            {
                return null;
            }

            ResolveRoundIfDue(session);
            return session;
        }
    }

    public RankingSession? Vote(Guid groupId, Guid userId, Guid itemId)
    {
        lock (_lock)
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
                    ResolveRoundIfDue(session);
                }
            }

            return session;
        }
    }

    private void SweepStaleSessions()
    {
        var cutoff = DateTime.UtcNow - StaleSessionAge;
        foreach (var (groupId, session) in _sessionsByGroup)
        {
            if (session.RoundDeadlineUtc < cutoff)
            {
                _sessionsByGroup.TryRemove(groupId, out _);
            }
        }
    }

    private void ResolveRoundIfDue(RankingSession session)
    {
        if (session.Status != RankingStatus.Voting)
        {
            return;
        }

        var everyPairFullyVoted = session.Pairs.All(
            p => p.ItemB is null || p.Votes.Count >= session.ExpectedVoterCount);
        if (!everyPairFullyVoted && DateTime.UtcNow < session.RoundDeadlineUtc)
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
