using System;
using System.Collections.Concurrent;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;

namespace Jellio.Services;

/// <summary>
/// "What others are watching", kept for five minutes per reader and
/// cleared whenever anyone starts or stops playing something, so the row
/// is fresh after real activity and cheap the rest of the time.
/// </summary>
public sealed class CommunityWatchingCache : IDisposable
{
    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(5);
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
        if (_entries.TryGetValue(key, out var hit) && DateTime.UtcNow - hit.At < Ttl)
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

    private void OnPlayback(object? sender, PlaybackProgressEventArgs e) => Clear();
}
