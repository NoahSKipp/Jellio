using System.Collections.Concurrent;
using System.Diagnostics;
using Jellio.Services.Manga;
using Microsoft.Extensions.Logging;
using Xunit;

namespace Jellio.Tests;

public class MangaSearchServiceTests
{
    // Short timeouts so the tests run quickly; the shape matches the defaults.
    private static readonly MangaSearchOptions Options = new(
        PerSourceTimeout: TimeSpan.FromSeconds(2),
        Budget: TimeSpan.FromSeconds(10),
        FailuresToOpen: 3,
        FailureWindow: TimeSpan.FromMinutes(10),
        OpenFor: TimeSpan.FromMinutes(10),
        CacheFor: TimeSpan.FromMinutes(5));

    private static readonly SuwayomiSource Fast = new(1, "Fast", "en");
    private static readonly SuwayomiSource Dead = new(2, "Dead", "en");
    private static readonly SuwayomiSource Slowish = new(3, "Slowish", "en");

    private DateTime _now = new(2026, 1, 1, 12, 0, 0, DateTimeKind.Utc);

    private MangaSearchService Service(FakeSearch search, CapturingLogger? logger = null) =>
        new(search, logger ?? new CapturingLogger(), Options, () => _now);

    private static Task<IReadOnlyList<SuwayomiManga>?> Answer(params string[] titles) =>
        Task.FromResult<IReadOnlyList<SuwayomiManga>?>(titles.Select((title, i) => new SuwayomiManga(i + 1, title, null, null, false)).ToList());

    // Never answers and ignores cancellation, like a source stuck behind Cloudflare.
    private static Task<IReadOnlyList<SuwayomiManga>?> Never() =>
        new TaskCompletionSource<IReadOnlyList<SuwayomiManga>?>().Task;

    private static async Task<List<(MangaSourceOutcome Outcome, long AtMs)>> Collect(MangaSearchService service, IReadOnlyList<SuwayomiSource> sources, string query, CancellationToken token = default)
    {
        var clock = Stopwatch.StartNew();
        var outcomes = new List<(MangaSourceOutcome, long)>();
        await foreach (var outcome in service.SearchAsync(sources, query, token))
        {
            outcomes.Add((outcome, clock.ElapsedMilliseconds));
        }

        return outcomes;
    }

    [Fact]
    public async Task FirstResultsArriveLongBeforeADeadSourceTimesOut()
    {
        var search = new FakeSearch();
        search.Behaviour[Fast.Id] = _ => Answer("Berserk", "Berserk of Gluttony");
        search.Behaviour[Dead.Id] = _ => Never();
        search.Behaviour[Slowish.Id] = async token =>
        {
            await Task.Delay(300, token);
            return await Answer("Berserk");
        };
        var service = Service(search);

        var outcomes = await Collect(service, [Dead, Slowish, Fast], "Berserk");

        Assert.Equal(Fast.Id, outcomes[0].Outcome.Source.Id);
        Assert.Equal(MangaSourceStatus.Ok, outcomes[0].Outcome.Status);
        Assert.True(outcomes[0].AtMs < 500, $"first source arrived after {outcomes[0].AtMs} ms");
        Assert.Equal(Slowish.Id, outcomes[1].Outcome.Source.Id);
        Assert.True(outcomes[1].AtMs < 1500, $"second source arrived after {outcomes[1].AtMs} ms");

        var dead = outcomes.Single(o => o.Outcome.Source.Id == Dead.Id);
        Assert.Equal(MangaSourceStatus.Timeout, dead.Outcome.Status);
        Assert.InRange(dead.AtMs, 1500, 4000);
        Assert.Equal(3, outcomes.Count);
    }

    [Fact]
    public async Task ASourceFailingThreeTimesIsSkippedForTenMinutes()
    {
        var search = new FakeSearch();
        search.Behaviour[Dead.Id] = _ => Task.FromResult<IReadOnlyList<SuwayomiManga>?>(null);
        var service = Service(search);

        for (var i = 0; i < 3; i++)
        {
            var outcome = (await Collect(service, [Dead], "query " + i)).Single().Outcome;
            Assert.Equal(MangaSourceStatus.Failed, outcome.Status);
        }

        Assert.True(service.IsUnavailable(Dead.Id));
        var skipped = await Collect(service, [Dead], "query 4");
        Assert.Equal(MangaSourceStatus.Unavailable, skipped.Single().Outcome.Status);
        Assert.True(skipped.Single().AtMs < 200);
        Assert.Equal(3, search.Calls[Dead.Id]);

        _now += TimeSpan.FromMinutes(11);
        Assert.False(service.IsUnavailable(Dead.Id));
        await Collect(service, [Dead], "query 5");
        Assert.Equal(4, search.Calls[Dead.Id]);
    }

    [Fact]
    public async Task FailuresSpreadOverMoreThanTenMinutesDoNotTripIt()
    {
        var search = new FakeSearch();
        search.Behaviour[Dead.Id] = _ => Task.FromResult<IReadOnlyList<SuwayomiManga>?>(null);
        var service = Service(search);

        for (var i = 0; i < 3; i++)
        {
            await Collect(service, [Dead], "query " + i);
            _now += TimeSpan.FromMinutes(6);
        }

        Assert.False(service.IsUnavailable(Dead.Id));
    }

    [Fact]
    public async Task AnswersAreReusedForFiveMinutesPerSourceAndQuery()
    {
        var search = new FakeSearch();
        search.Behaviour[Fast.Id] = _ => Answer("One Piece");
        var service = Service(search);

        Assert.Equal(MangaSourceStatus.Ok, (await Collect(service, [Fast], "One Piece")).Single().Outcome.Status);
        var again = (await Collect(service, [Fast], "  one   PIECE ")).Single().Outcome;
        Assert.Equal(MangaSourceStatus.Cached, again.Status);
        Assert.Equal("One Piece", again.Results.Single().Title);
        Assert.Equal(1, search.Calls[Fast.Id]);

        Assert.Equal(MangaSourceStatus.Ok, (await Collect(service, [Fast], "Naruto")).Single().Outcome.Status);
        Assert.Equal(2, search.Calls[Fast.Id]);

        _now += TimeSpan.FromMinutes(6);
        Assert.Equal(MangaSourceStatus.Ok, (await Collect(service, [Fast], "One Piece")).Single().Outcome.Status);
        Assert.Equal(3, search.Calls[Fast.Id]);
    }

    [Fact]
    public async Task AReaderLeavingDoesNotCountAgainstTheSource()
    {
        var search = new FakeSearch();
        search.Behaviour[Dead.Id] = async token =>
        {
            await Task.Delay(Timeout.Infinite, token);
            return null;
        };
        var service = Service(search);

        for (var i = 0; i < 3; i++)
        {
            using var leave = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Collect(service, [Dead], "query " + i, leave.Token));
        }

        await Task.Delay(100);
        Assert.False(service.IsUnavailable(Dead.Id));
    }

    [Fact]
    public async Task EachSearchLogsOneLineWithEverySource()
    {
        var search = new FakeSearch();
        search.Behaviour[Fast.Id] = _ => Answer("Berserk");
        search.Behaviour[Dead.Id] = _ => Never();
        var logger = new CapturingLogger();
        var service = Service(search, logger);

        await Collect(service, [Fast, Dead], "Berserk");

        var line = Assert.Single(logger.Lines);
        Assert.Contains("Fast ok", line, StringComparison.Ordinal);
        Assert.Contains("Dead timed out", line, StringComparison.Ordinal);
    }

    private sealed class FakeSearch : IMangaSourceSearch
    {
        public Dictionary<long, Func<CancellationToken, Task<IReadOnlyList<SuwayomiManga>?>>> Behaviour { get; } = [];

        public ConcurrentDictionary<long, int> Calls { get; } = new();

        public Task<IReadOnlyList<SuwayomiManga>?> SearchAsync(long sourceId, string query, CancellationToken cancellationToken)
        {
            Calls.AddOrUpdate(sourceId, 1, (_, count) => count + 1);
            return Behaviour[sourceId](cancellationToken);
        }
    }

    private sealed class CapturingLogger : ILogger
    {
        public ConcurrentQueue<string> Lines { get; } = new();

        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            if (logLevel >= LogLevel.Information)
            {
                Lines.Enqueue(formatter(state, exception));
            }
        }
    }
}
