using System;
using System.IO;
using System.Text.Json;
using MediaBrowser.Common.Configuration;

namespace Jellio.Services;

// The same "one JSON file per user id under PluginConfigurationsPath"
// shape AchievementStore, ProfileSettingsStore, GrouplistStore,
// NextUpHiddenController and NotificationsController each carried their
// own separately drifted copy of, some locked, some not, before this
// (audit-found: every one of those real Load-then-Save call sites was
// its own real lost-update bug waiting to happen). One real
// implementation now; every caller above wraps this instead.
//
// Always locked, even for AchievementStore's own single-writer case:
// the lock costs nothing uncontended, and a shared implementation with
// one real behaviour is worth more than each caller deciding for
// itself whether it still qualifies as single-writer today.
public class JsonUserStore<T>(IApplicationPaths applicationPaths, string subdirectory, Func<T> defaultFactory)
{
    private readonly object _lock = new();

    private string StoreDirectory =>
        Path.Combine(applicationPaths.PluginConfigurationsPath, "Jellio", subdirectory);

    private string StorePath(Guid userId) => Path.Combine(StoreDirectory, userId + ".json");

    public T Load(Guid userId)
    {
        lock (_lock)
        {
            return LoadLocked(userId);
        }
    }

    public void Save(Guid userId, T value)
    {
        lock (_lock)
        {
            SaveLocked(userId, value);
        }
    }

    // The real atomic Load-mutate-Save every caller above needs instead
    // of its own separate Load()/Save() pair: real time between those
    // two steps, for another request to land in, is exactly the real
    // bug this closes off.
    public T Update(Guid userId, Action<T> mutate)
    {
        lock (_lock)
        {
            var value = LoadLocked(userId);
            mutate(value);
            SaveLocked(userId, value);
            return value;
        }
    }

    private T LoadLocked(Guid userId)
    {
        var path = StorePath(userId);
        if (!File.Exists(path))
        {
            return defaultFactory();
        }

        try
        {
            return JsonSerializer.Deserialize<T>(File.ReadAllText(path)) ?? defaultFactory();
        }
        catch (JsonException)
        {
            return defaultFactory();
        }
    }

    private void SaveLocked(Guid userId, T value)
    {
        Directory.CreateDirectory(StoreDirectory);
        File.WriteAllText(StorePath(userId), JsonSerializer.Serialize(value));
    }
}
