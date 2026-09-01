using System;
using System.Collections.Generic;
using Jellio.Services;
using MediaBrowser.Common.Configuration;

namespace Jellio.Services.Grouplist;

// One of these per user, same JSON-per-user-id shape JsonUserStore exists
// for. Item ids only, no real BaseItemDto snapshot kept here: Controllers/
// GrouplistController.cs stays deliberately thin, no IDtoService/DtoOptions
// resolution this plugin has never needed before, the same real reason
// components/groupWatch.js's own chat watch-card already just carries an
// ItemId and lets the frontend's own getItem() resolve real display details
// fresh, rather than trusting a stale snapshot.
public class GrouplistStore(IApplicationPaths applicationPaths)
{
    // Every other real user growable list in this plugin is capped (chat
    // 200/group, invites 20/user, AchievementService's own RecentActivity
    // 20); generous here, a real personal watchlist genuinely can run long
    // over a real year of use, not tuned down to the bone the way a short
    // lived feed can be.
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
