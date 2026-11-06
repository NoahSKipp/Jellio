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
    private readonly Dictionary<Guid, T> _cache = new();

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
            var ids = new HashSet<Guid>(_cache.Keys);
            if (Directory.Exists(StoreDirectory))
            {
                foreach (var file in Directory.EnumerateFiles(StoreDirectory, "*.json"))
                {
                    if (string.Equals(Path.GetExtension(file), ".json", StringComparison.OrdinalIgnoreCase) &&
                        Guid.TryParse(Path.GetFileNameWithoutExtension(file), out var id) &&
                        id != Guid.Empty)
                    {
                        ids.Add(id);
                    }
                }
            }

            ids.Remove(Guid.Empty);
            return ids.ToList();
        }
    }

    public void Save(Guid userId, T value)
    {
        lock (_lock)
        {
            _cache[userId] = value;
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

    public void ClearCache()
    {
        lock (_lock)
        {
            _cache.Clear();
        }
    }

    private T LoadLocked(Guid userId)
    {
        if (_cache.TryGetValue(userId, out var cached))
        {
            return cached;
        }

        var path = StorePath(userId);
        if (File.Exists(path))
        {
            try
            {
                var deserialized = JsonSerializer.Deserialize<T>(File.ReadAllText(path));
                if (deserialized != null)
                {
                    _cache[userId] = deserialized;
                    return deserialized;
                }
            }
            catch (JsonException)
            {
                var corruptBackup = path + ".corrupted." + DateTimeOffset.UtcNow.ToUnixTimeSeconds() + ".bak";
                try
                {
                    File.Copy(path, corruptBackup, overwrite: true);
                }
                catch
                {
                }

                if (TryRecover(path, userId, out var recovered))
                {
                    return recovered!;
                }
            }
        }
        else
        {
            if (TryRecover(path, userId, out var recovered))
            {
                return recovered!;
            }
        }

        return defaultFactory();
    }

    private bool TryRecover(string path, Guid userId, out T? recovered)
    {
        var bakPath = path + ".bak";
        if (File.Exists(bakPath))
        {
            try
            {
                var bakDeserialized = JsonSerializer.Deserialize<T>(File.ReadAllText(bakPath));
                if (bakDeserialized != null)
                {
                    _cache[userId] = bakDeserialized;
                    recovered = bakDeserialized;
                    return true;
                }
            }
            catch (JsonException)
            {
            }
        }

        var tmpPath = path + ".tmp";
        if (File.Exists(tmpPath))
        {
            try
            {
                var tmpDeserialized = JsonSerializer.Deserialize<T>(File.ReadAllText(tmpPath));
                if (tmpDeserialized != null)
                {
                    _cache[userId] = tmpDeserialized;
                    recovered = tmpDeserialized;
                    return true;
                }
            }
            catch (JsonException)
            {
            }
        }

        if (Directory.Exists(StoreDirectory))
        {
            var filePrefix = Path.GetFileName(path) + ".";
            var tmpFiles = Directory.EnumerateFiles(StoreDirectory, filePrefix + "*.tmp")
                .OrderByDescending(File.GetLastWriteTimeUtc);
            foreach (var file in tmpFiles)
            {
                try
                {
                    var tmpDeserialized = JsonSerializer.Deserialize<T>(File.ReadAllText(file));
                    if (tmpDeserialized != null)
                    {
                        _cache[userId] = tmpDeserialized;
                        recovered = tmpDeserialized;
                        return true;
                    }
                }
                catch (JsonException)
                {
                }
            }
        }

        recovered = default;
        return false;
    }

    private void SaveLocked(Guid userId, T value)
    {
        Directory.CreateDirectory(StoreDirectory);
        var path = StorePath(userId);
        var tempPath = path + "." + Guid.NewGuid().ToString("N") + ".tmp";

        try
        {
            File.WriteAllText(tempPath, JsonSerializer.Serialize(value));

            var bakPath = path + ".bak";
            if (File.Exists(path))
            {
                File.Copy(path, bakPath, overwrite: true);
            }

            File.Move(tempPath, path, overwrite: true);
            _cache[userId] = value;
        }
        catch
        {
            if (File.Exists(tempPath))
            {
                try
                {
                    File.Delete(tempPath);
                }
                catch
                {
                }
            }
            throw;
        }
    }
}
