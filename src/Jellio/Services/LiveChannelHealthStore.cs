using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using MediaBrowser.Common.Configuration;

namespace Jellio.Services;

public sealed class LiveChannelHealthRecord
{
    public int FailedOpens { get; set; }

    public DateTime? LastFailureAt { get; set; }

    public DateTime? LastSuccessAt { get; set; }

    public string? LastError { get; set; }
}

public sealed record LiveChannelStatus(string Status, DateTime Since, string? LastError);

// Which Live TV channels fail to start, from what Jellio clients report
// when they open one. Nothing is probed: opening a channel takes a tuner.
// Shared by every user of the server, one small JSON file.
public class LiveChannelHealthStore
{
    public const int FailuresBeforeBroken = 2;
    public static readonly TimeSpan BrokenLifetime = TimeSpan.FromHours(24);
    private const int MaxRecords = 5000;

    private readonly object _lock = new();
    private readonly string _path;
    private readonly Func<DateTime> _now;
    private Dictionary<string, LiveChannelHealthRecord>? _records;

    public LiveChannelHealthStore(IApplicationPaths applicationPaths)
        : this(Path.Combine(applicationPaths.PluginConfigurationsPath, "Jellio", "live-channel-health.json"), () => DateTime.UtcNow)
    {
    }

    public LiveChannelHealthStore(string path, Func<DateTime> now)
    {
        _path = path;
        _now = now;
    }

    public void Report(string channelId, bool ok, string? error)
    {
        lock (_lock)
        {
            var records = Load();
            if (!records.TryGetValue(channelId, out var record))
            {
                if (ok)
                {
                    // Nothing to clear; no need to remember a channel that works.
                    return;
                }

                record = new LiveChannelHealthRecord();
                records[channelId] = record;
            }

            if (ok)
            {
                records.Remove(channelId);
            }
            else
            {
                record.FailedOpens++;
                record.LastFailureAt = _now();
                record.LastError = error is { Length: > 60 } ? error[..60] : error;
            }

            Trim(records);
            Save(records);
        }
    }

    // Channels that failed to start at least twice with no success since,
    // the last time within a day. Older marks lapse so the channel gets
    // tried again.
    public Dictionary<string, LiveChannelStatus> Broken()
    {
        lock (_lock)
        {
            var now = _now();
            return Load()
                .Where(pair => pair.Value.FailedOpens >= FailuresBeforeBroken
                    && pair.Value.LastFailureAt is { } last
                    && now - last < BrokenLifetime)
                .ToDictionary(pair => pair.Key, pair => new LiveChannelStatus("failing", pair.Value.LastFailureAt!.Value, pair.Value.LastError));
        }
    }

    private void Trim(Dictionary<string, LiveChannelHealthRecord> records)
    {
        var now = _now();
        foreach (var stale in records.Where(pair => pair.Value.LastFailureAt is not { } last || now - last > BrokenLifetime * 2).Select(pair => pair.Key).ToList())
        {
            records.Remove(stale);
        }

        if (records.Count > MaxRecords)
        {
            foreach (var oldest in records.OrderBy(pair => pair.Value.LastFailureAt).Take(records.Count - MaxRecords).Select(pair => pair.Key).ToList())
            {
                records.Remove(oldest);
            }
        }
    }

    private Dictionary<string, LiveChannelHealthRecord> Load()
    {
        if (_records != null)
        {
            return _records;
        }

        try
        {
            _records = File.Exists(_path)
                ? JsonSerializer.Deserialize<Dictionary<string, LiveChannelHealthRecord>>(File.ReadAllText(_path)) ?? new()
                : new();
        }
        catch (Exception err) when (err is JsonException or IOException)
        {
            _records = new();
        }

        return _records;
    }

    private void Save(Dictionary<string, LiveChannelHealthRecord> records)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        File.WriteAllText(_path, JsonSerializer.Serialize(records));
    }
}
