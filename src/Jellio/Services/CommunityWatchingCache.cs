using System;
using System.Collections.Concurrent;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;

namespace Jellio.Services;

/// <summary>
/// "What others are watching" cache:
/// Keeps the full response for 30 seconds per reader, and caches the multi-user
/// historical database queries (resumables and 14-day history) for 5 minutes.
/// Active video sessions are always read fresh from memory on every request.
/// </summary>
public sealed class CommunityWatchingCache : IDisposable
{
    private static readonly TimeSpan ResponseTtl = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan HistoryTtl = TimeSpan.FromMinutes(5);

    private readonly ConcurrentDictionary<string, (DateTime At, object Value)> _entries = new(StringComparer.Ordinal);
    private (DateTime At, object History)? _cachedHistory;
    private readonly object _historyLock = new();
    private readonly ISessionManager _sessionManager;

    public CommunityWatchingCache(ISessionManager sessionManager)
    {
        _sessionManager = sessionManager;
        _sessionManager.PlaybackStart += OnPlayback;
        _sessionManager.PlaybackStopped += OnPlayback;
    }

    public bool TryGet(string key, out object? value)
    {
        if (_entries.TryGetValue(key, out var hit) && DateTime.UtcNow - hit.At < ResponseTtl)
        {
            value = hit.Value;
            return true;
        }

        value = null;
        return false;
    }

    public void Set(string key, object value) => _entries[key] = (DateTime.UtcNow, value);

    public bool TryGetHistory<T>(out T? history) where T : class
    {
        var current = _cachedHistory;
        if (current.HasValue && DateTime.UtcNow - current.Value.At < HistoryTtl && current.Value.History is T hit)
        {
            history = hit;
            return true;
        }

        history = null;
        return false;
    }

    public void SetHistory(object history)
    {
        lock (_historyLock)
        {
            _cachedHistory = (DateTime.UtcNow, history);
        }
    }

    public void Clear()
    {
        _entries.Clear();
        lock (_historyLock)
        {
            _cachedHistory = null;
        }
    }

    public void Dispose()
    {
        _sessionManager.PlaybackStart -= OnPlayback;
        _sessionManager.PlaybackStopped -= OnPlayback;
    }

    private void OnPlayback(object? sender, PlaybackProgressEventArgs e)
    {
        // When someone starts or stops playing, clear response entries so updated state can be returned.
        // Historical database entries expire naturally after 5 minutes or on full clear.
        _entries.Clear();
    }
}
