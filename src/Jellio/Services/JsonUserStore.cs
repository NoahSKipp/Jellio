using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using MediaBrowser.Common.Configuration;

namespace Jellio.Services;

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

    // Every user with a saved record.
    public IReadOnlyList<Guid> UserIds()
    {
        lock (_lock)
        {
            if (!Directory.Exists(StoreDirectory))
            {
                return [];
            }

            return Directory.EnumerateFiles(StoreDirectory, "*.json")
                .Select(file => Guid.TryParse(Path.GetFileNameWithoutExtension(file), out var id) ? id : Guid.Empty)
                .Where(id => id != Guid.Empty)
                .ToList();
        }
    }

    public void Save(Guid userId, T value)
    {
        lock (_lock)
        {
            SaveLocked(userId, value);
        }
    }

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

    // Saves only when mutate reports a change, so a poll that finds nothing
    // new does not rewrite the file.
    public T UpdateIfChanged(Guid userId, Func<T, bool> mutate)
    {
        lock (_lock)
        {
            var value = LoadLocked(userId);
            if (mutate(value))
            {
                SaveLocked(userId, value);
            }

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
