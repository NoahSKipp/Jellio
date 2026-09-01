using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using MediaBrowser.Common.Configuration;

namespace Jellio.Services.Grouplist;

// One of these per user, same JSON-per-user-id shape everything else in
// this plugin's own data directory already uses. Item ids only, no real
// BaseItemDto snapshot kept here: Controllers/GrouplistController.cs
// stays deliberately thin, no IDtoService/DtoOptions resolution this
// plugin has never needed before, the same real reason components/
// groupWatch.js's own chat watch-card already just carries an ItemId
// and lets the frontend's own getItem() resolve real display details
// fresh, rather than trusting a stale snapshot.
public class GrouplistStore(IApplicationPaths applicationPaths)
{
    // Real bug, audit-found: Add()/Remove() below each did their own
    // real Load then Save with real time between them for another
    // request to land in, the same real lost-update shape
    // ProfileSettingsStore.cs's own header now explains for the
    // identical reason. One flat lock, same real proportional-to-scale
    // reasoning used there.
    private readonly object _lock = new();

    // Real bug, audit-found: every other real user growable list in
    // this plugin is capped (chat 200/group, invites 20/user,
    // AchievementService's own RecentActivity 20) but this one never
    // was, read and rewritten in full on every real Add/Remove
    // regardless of how large it has grown. Generous, a real personal
    // watchlist genuinely can run long over a real year of use, not
    // tuned down to the bone the way a short lived feed can be.
    private const int MaxItems = 500;

    private string StoreDirectory =>
        Path.Combine(applicationPaths.PluginConfigurationsPath, "Jellio", "grouplist");

    private string StorePath(Guid userId) => Path.Combine(StoreDirectory, userId + ".json");

    public List<Guid> Load(Guid userId)
    {
        lock (_lock)
        {
            return LoadLocked(userId);
        }
    }

    public List<Guid> Add(Guid userId, Guid itemId)
    {
        lock (_lock)
        {
            var items = LoadLocked(userId);
            if (!items.Contains(itemId) && items.Count < MaxItems)
            {
                items.Add(itemId);
                SaveLocked(userId, items);
            }

            return items;
        }
    }

    public List<Guid> Remove(Guid userId, Guid itemId)
    {
        lock (_lock)
        {
            var items = LoadLocked(userId);
            if (items.Remove(itemId))
            {
                SaveLocked(userId, items);
            }

            return items;
        }
    }

    private List<Guid> LoadLocked(Guid userId)
    {
        var path = StorePath(userId);
        if (!File.Exists(path))
        {
            return [];
        }

        try
        {
            return JsonSerializer.Deserialize<List<Guid>>(File.ReadAllText(path)) ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }

    private void SaveLocked(Guid userId, List<Guid> itemIds)
    {
        Directory.CreateDirectory(StoreDirectory);
        File.WriteAllText(StorePath(userId), JsonSerializer.Serialize(itemIds));
    }
}
