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

    // Real feedback, live: a reader watching the flat timer's own real
    // countdown wanted to actually see it counting down, not just a
    // fixed RoundDeadlineUtc to do their own math against. Constant for
    // the life of a session (RoundDurationSeconds below never changes
    // round to round), set once at Start() rather than re-set on every
    // real round after that for the identical reason ExpectedVoterCount
    // above is.
    public int RoundLengthSeconds { get; set; }

    public long Version { get; set; }

    [JsonIgnore]
    public int ExpectedVoterCount { get; set; }
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
/// Round resolution: real group membership at any given moment is not
/// something this plugin can see server side (confirmed against real
/// SyncPlayController.cs before writing this, the same real gap
/// GroupWatchChatController's own header already lives with), so
/// ExpectedVoterCount below is a snapshot, GroupWatchRankingController's
/// own real participant list at the moment a pick was started, not a
/// live membership check. A round resolves the instant every pair in it
/// already has a vote from that many distinct voters (real feedback,
/// live: a two title pick between one solo reader sat waiting on the
/// flat timer below regardless, no real reason to once the only real
/// voter already had), and the flat timer below is still what a round
/// falls back on otherwise, so someone leaving mid vote (or simply never
/// voting) never leaves it stuck. Ties and zero vote pairs still broken
/// at random either way.
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

    // Real bug, audit-found: a session's own Pairs/Votes/Round/Status/
    // Version were mutated straight from Vote()/ResolveRoundIfDue() with
    // no lock at all, unlike GroupWatchChatService/GroupWatchInviteService's
    // own real `lock (list)` around their own mutable state. This is the
    // exact real scenario the whole feature exists for, several group
    // members voting within the same real second, a plain Dictionary
    // never safe for that without one. One flat lock rather than a real
    // per-session lock registry: every real operation here is in memory
    // and fast, no I/O, so a single lock never holds long enough for this
    // real friends-only scale to notice, and it needs no lifecycle
    // management the way a per-session lock object keyed alongside
    // _sessionsByGroup would.
    private readonly object _lock = new();

    // Real bug, audit-found: a session only ever left _sessionsByGroup
    // through an explicit real Cancel() call; one that finished
    // normally, or whose own initiator just closed the tab mid bracket,
    // sat there forever, one real permanent dictionary entry per
    // GroupId a pick was ever started for. Swept here in Start(),
    // already run under _lock and already the one real place a fresh
    // session is about to exist regardless, rather than a dedicated
    // background loop just for this.
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
                    // Real feedback, live: the vote that is itself the last one a
                    // round needs used to still sit until the next real poll tick
                    // picked it up (Get()'s own call to this exact same method),
                    // this exact caller's own response still reading Voting for a
                    // real vote that had already made the round due. Resolved
                    // again right here so the one response this exact vote
                    // returns already carries whatever it resolved to.
                    ResolveRoundIfDue(session);
                }
            }

            return session;
        }
    }

    public void Cancel(Guid groupId)
    {
        lock (_lock)
        {
            _sessionsByGroup.TryRemove(groupId, out _);
        }
    }

    // RoundDeadlineUtc rather than a second real "last activity" field:
    // a Finished session's own copy stays fixed at whatever its last
    // real round set it to, and a genuinely abandoned Voting one (nobody
    // ever polled or voted again) never advances past its own real
    // deadline either, so both real cases already read as stale the
    // same way once enough real time has passed.
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
