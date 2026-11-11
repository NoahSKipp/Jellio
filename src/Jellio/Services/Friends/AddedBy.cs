using System;
using System.Collections.Generic;
using System.Linq;
using MediaBrowser.Common.Configuration;

namespace Jellio.Services.Friends;

public class AddedByEntry
{
    public Guid FromUserId { get; set; }

    public DateTime At { get; set; }
}

// Pure operations over one recipient's item id (N format) to senders map.
public static class AddedByLogic
{
    public const int MaxPerItem = 3;

    public static string Key(Guid itemId) => itemId.ToString("N");

    public static void Record(Dictionary<string, List<AddedByEntry>> map, Guid itemId, Guid sender, DateTime at)
    {
        var key = Key(itemId);
        if (!map.TryGetValue(key, out var list))
        {
            list = [];
            map[key] = list;
        }

        list.RemoveAll(e => e.FromUserId == sender);
        list.Insert(0, new AddedByEntry { FromUserId = sender, At = at });
        if (list.Count > MaxPerItem)
        {
            list.RemoveRange(MaxPerItem, list.Count - MaxPerItem);
        }
    }

    public static bool RemoveItem(Dictionary<string, List<AddedByEntry>> map, Guid itemId) =>
        map.Remove(Key(itemId));

    public static bool RemoveSender(Dictionary<string, List<AddedByEntry>> map, Guid sender)
    {
        var changed = false;
        foreach (var key in map.Keys.ToList())
        {
            if (map[key].RemoveAll(e => e.FromUserId == sender) > 0)
            {
                changed = true;
            }

            if (map[key].Count == 0)
            {
                map.Remove(key);
            }
        }

        return changed;
    }
}

public class AddedByStore(IApplicationPaths applicationPaths)
{
    private readonly JsonUserStore<Dictionary<string, List<AddedByEntry>>> _store =
        new(applicationPaths, "added-by", () => []);

    public Dictionary<string, List<AddedByEntry>> Snapshot(Guid recipient)
    {
        Dictionary<string, List<AddedByEntry>> copy = [];
        _store.UpdateIfChanged(recipient, map =>
        {
            foreach (var (key, list) in map)
            {
                copy[key] = list.Select(e => new AddedByEntry { FromUserId = e.FromUserId, At = e.At }).ToList();
            }

            return false;
        });
        return copy;
    }

    public void Record(Guid recipient, Guid itemId, Guid sender, DateTime at) =>
        _store.Update(recipient, map => AddedByLogic.Record(map, itemId, sender, at));

    public void RemoveItem(Guid recipient, Guid itemId) =>
        _store.UpdateIfChanged(recipient, map => AddedByLogic.RemoveItem(map, itemId));

    public void RemoveSender(Guid recipient, Guid sender) =>
        _store.UpdateIfChanged(recipient, map => AddedByLogic.RemoveSender(map, sender));
}
