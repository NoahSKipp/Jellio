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
    private string StoreDirectory =>
        Path.Combine(applicationPaths.PluginConfigurationsPath, "Jellio", "grouplist");

    private string StorePath(Guid userId) => Path.Combine(StoreDirectory, userId + ".json");

    public List<Guid> Load(Guid userId)
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

    public void Add(Guid userId, Guid itemId)
    {
        var items = Load(userId);
        if (items.Contains(itemId))
        {
            return;
        }

        items.Add(itemId);
        Save(userId, items);
    }

    public void Remove(Guid userId, Guid itemId)
    {
        var items = Load(userId);
        if (!items.Remove(itemId))
        {
            return;
        }

        Save(userId, items);
    }

    private void Save(Guid userId, List<Guid> itemIds)
    {
        Directory.CreateDirectory(StoreDirectory);
        File.WriteAllText(StorePath(userId), JsonSerializer.Serialize(itemIds));
    }
}
