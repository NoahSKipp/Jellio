using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellio.Services.Manga;

/// <summary>Searches one Suwayomi source. SuwayomiClient in production, fakes in tests.</summary>
public interface IMangaSourceSearch
{
    Task<IReadOnlyList<SuwayomiManga>?> SearchAsync(long sourceId, string query, CancellationToken cancellationToken);
}

/// <summary>How a source answered one search.</summary>
public enum MangaSourceStatus
{
    Ok,
    Cached,
    Failed,
    Timeout,
    Unavailable,
}

public record MangaSourceOutcome(SuwayomiSource Source, MangaSourceStatus Status, IReadOnlyList<SuwayomiManga> Results, long ElapsedMs);

public record MangaSearchOptions(
    TimeSpan PerSourceTimeout,
    TimeSpan Budget,
    int FailuresToOpen,
    TimeSpan FailureWindow,
    TimeSpan OpenFor,
    TimeSpan CacheFor)
{
    public static MangaSearchOptions Default { get; } = new(
        TimeSpan.FromSeconds(7),
        TimeSpan.FromSeconds(25),
        3,
        TimeSpan.FromMinutes(10),
        TimeSpan.FromMinutes(10),
        TimeSpan.FromMinutes(5));
}

/// <summary>
/// Manga search across Suwayomi sources, every source at once, each with
/// its own timeout under one overall budget, yielding each source's
/// outcome the moment it has one. A source that times out or errors
/// three times within ten minutes is skipped (reported unavailable) for
/// the next ten, and answers are reused for five minutes per source and
/// query, so one dead or Cloudflare-blocked source no longer holds every
/// search up.
/// </summary>
public sealed class MangaSearchService
{
    private const int MaxCacheEntries = 1000;

    private readonly IMangaSourceSearch _searcher;
    private readonly ILogger _logger;
    private readonly MangaSearchOptions _options;
    private readonly Func<DateTime> _utcNow;
    private readonly ConcurrentDictionary<long, SourceHealth> _health = new();
    private readonly ConcurrentDictionary<string, CachedAnswer> _cache = new(StringComparer.Ordinal);

    public MangaSearchService(IMangaSourceSearch searcher, ILogger logger, MangaSearchOptions? options = null, Func<DateTime>? utcNow = null)
    {
        _searcher = searcher;
        _logger = logger;
        _options = options ?? MangaSearchOptions.Default;
        _utcNow = utcNow ?? (() => DateTime.UtcNow);
    }

    public bool IsUnavailable(long sourceId)
    {
        if (!_health.TryGetValue(sourceId, out var health))
        {
            return false;
        }

        lock (health)
        {
            return _utcNow() < health.OpenUntil;
        }
    }

    /// <summary>Each source's outcome, in the order they finish.</summary>
    public async IAsyncEnumerable<MangaSourceOutcome> SearchAsync(
        IReadOnlyList<SuwayomiSource> sources,
        string query,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var key = NormalizeQuery(query);
        var channel = Channel.CreateUnbounded<MangaSourceOutcome>();
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        budget.CancelAfter(_options.Budget);
        var started = Stopwatch.GetTimestamp();
        var outcomes = new List<MangaSourceOutcome>(sources.Count);

        var searches = sources
            .Select(source => SearchOneAsync(source, query, key, budget.Token, cancellationToken, channel.Writer))
            .ToArray();
        _ = Task.WhenAll(searches).ContinueWith(
            _ => channel.Writer.TryComplete(),
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);

        try
        {
            await foreach (var outcome in channel.Reader.ReadAllAsync(cancellationToken).ConfigureAwait(false))
            {
                outcomes.Add(outcome);
                yield return outcome;
            }
        }
        finally
        {
            budget.Cancel();
            LogSearch(query, outcomes, sources.Count, Stopwatch.GetElapsedTime(started));
        }
    }

    private async Task SearchOneAsync(
        SuwayomiSource source,
        string query,
        string key,
        CancellationToken budgetToken,
        CancellationToken clientToken,
        ChannelWriter<MangaSourceOutcome> writer)
    {
        if (IsUnavailable(source.Id))
        {
            writer.TryWrite(new MangaSourceOutcome(source, MangaSourceStatus.Unavailable, [], 0));
            return;
        }

        var cacheKey = source.Id.ToString(CultureInfo.InvariantCulture) + "|" + key;
        if (_cache.TryGetValue(cacheKey, out var cached) && _utcNow() - cached.At < _options.CacheFor)
        {
            writer.TryWrite(new MangaSourceOutcome(source, MangaSourceStatus.Cached, cached.Results, 0));
            return;
        }

        var started = Stopwatch.GetTimestamp();
        long Elapsed() => (long)Stopwatch.GetElapsedTime(started).TotalMilliseconds;
        using var perSource = CancellationTokenSource.CreateLinkedTokenSource(budgetToken);
        perSource.CancelAfter(_options.PerSourceTimeout);
        MangaSourceOutcome outcome;
        try
        {
            // WaitAsync: a source that ignores cancellation still can't
            // hold the search past its timeout.
            var found = await _searcher.SearchAsync(source.Id, query, perSource.Token)
                .WaitAsync(perSource.Token)
                .ConfigureAwait(false);
            if (found is null)
            {
                RecordFailure(source.Id);
                outcome = new MangaSourceOutcome(source, MangaSourceStatus.Failed, [], Elapsed());
            }
            else
            {
                RecordSuccess(source.Id);
                StoreAnswer(cacheKey, found);
                outcome = new MangaSourceOutcome(source, MangaSourceStatus.Ok, found, Elapsed());
            }
        }
        catch (OperationCanceledException)
        {
            // The reader left: not the source's fault.
            if (clientToken.IsCancellationRequested)
            {
                return;
            }

            RecordFailure(source.Id);
            outcome = new MangaSourceOutcome(source, MangaSourceStatus.Timeout, [], Elapsed());
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Jellio: Suwayomi source {Source} search failed", source.Name);
            RecordFailure(source.Id);
            outcome = new MangaSourceOutcome(source, MangaSourceStatus.Failed, [], Elapsed());
        }

        writer.TryWrite(outcome);
    }

    private void RecordFailure(long sourceId)
    {
        var health = _health.GetOrAdd(sourceId, _ => new SourceHealth());
        var now = _utcNow();
        lock (health)
        {
            health.Failures.RemoveAll(at => now - at > _options.FailureWindow);
            health.Failures.Add(now);
            if (health.Failures.Count >= _options.FailuresToOpen)
            {
                health.OpenUntil = now + _options.OpenFor;
                health.Failures.Clear();
            }
        }
    }

    private void RecordSuccess(long sourceId)
    {
        if (!_health.TryGetValue(sourceId, out var health))
        {
            return;
        }

        lock (health)
        {
            health.Failures.Clear();
        }
    }

    private void StoreAnswer(string cacheKey, IReadOnlyList<SuwayomiManga> results)
    {
        var now = _utcNow();
        if (_cache.Count >= MaxCacheEntries)
        {
            foreach (var entry in _cache.Where(entry => now - entry.Value.At >= _options.CacheFor).ToList())
            {
                _cache.TryRemove(entry.Key, out _);
            }

            if (_cache.Count >= MaxCacheEntries)
            {
                _cache.Clear();
            }
        }

        _cache[cacheKey] = new CachedAnswer(now, results);
    }

    private void LogSearch(string query, List<MangaSourceOutcome> outcomes, int asked, TimeSpan elapsed)
    {
        var parts = outcomes.Select(outcome => outcome.Status switch
        {
            MangaSourceStatus.Ok => string.Create(CultureInfo.InvariantCulture, $"{outcome.Source.Name} ok {outcome.ElapsedMs} ms ({outcome.Results.Count})"),
            MangaSourceStatus.Cached => string.Create(CultureInfo.InvariantCulture, $"{outcome.Source.Name} cached ({outcome.Results.Count})"),
            MangaSourceStatus.Unavailable => $"{outcome.Source.Name} unavailable",
            MangaSourceStatus.Timeout => string.Create(CultureInfo.InvariantCulture, $"{outcome.Source.Name} timed out after {outcome.ElapsedMs} ms"),
            _ => string.Create(CultureInfo.InvariantCulture, $"{outcome.Source.Name} failed after {outcome.ElapsedMs} ms"),
        });
        var missing = asked - outcomes.Count;
        _logger.LogInformation(
            "Jellio manga search {Query}: {Sources}{Missing} in {Elapsed} ms",
            query,
            string.Join(", ", parts),
            missing > 0 ? string.Create(CultureInfo.InvariantCulture, $", {missing} not finished") : string.Empty,
            (long)elapsed.TotalMilliseconds);
    }

    public static string NormalizeQuery(string query) =>
        string.Join(' ', (query ?? string.Empty).Trim().ToLowerInvariant().Split(' ', StringSplitOptions.RemoveEmptyEntries));

    private sealed class SourceHealth
    {
        public List<DateTime> Failures { get; } = [];

        public DateTime OpenUntil { get; set; }
    }

    private sealed record CachedAnswer(DateTime At, IReadOnlyList<SuwayomiManga> Results);
}
