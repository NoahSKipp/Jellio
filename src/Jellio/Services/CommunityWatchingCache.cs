using System;
using System.Collections.Concurrent;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;

namespace Jellio.Services;

public sealed class CommunityWatchingCache : IDisposable
{
    private static readonly TimeSpan ResponseTtl = TimeSpan.FromSeconds(30);

    private readonly ConcurrentDictionary<string, (DateTime At, object Value)> _entries = new(StringComparer.Ordinal);
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

    public void Clear() => _entries.Clear();

    public void Dispose()
    {
        _sessionManager.PlaybackStart -= OnPlayback;
        _sessionManager.PlaybackStopped -= OnPlayback;
    }

    private void OnPlayback(object? sender, PlaybackProgressEventArgs e)
    {
        // When someone starts or stops playing, clear response entries so updated state can be returned.
        _entries.Clear();
    }
}
