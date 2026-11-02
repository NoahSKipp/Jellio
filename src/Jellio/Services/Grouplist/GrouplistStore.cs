using System;
using System.Collections.Generic;
using Jellio.Services;
using MediaBrowser.Common.Configuration;

namespace Jellio.Services.Grouplist;

public class GrouplistStore(IApplicationPaths applicationPaths)
{
    private const int MaxItems = 500;

    private readonly JsonUserStore<List<Guid>> _store =
        new(applicationPaths, "grouplist", () => []);

    public List<Guid> Load(Guid userId) => _store.Load(userId);

    public List<Guid> Add(Guid userId, Guid itemId) =>
        _store.Update(userId, items =>
        {
            if (!items.Contains(itemId) && items.Count < MaxItems)
            {
                items.Add(itemId);
            }
        });

    public List<Guid> Remove(Guid userId, Guid itemId) =>
        _store.Update(userId, items => items.Remove(itemId));
}
