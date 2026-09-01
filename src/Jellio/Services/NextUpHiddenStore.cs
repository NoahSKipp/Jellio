using System;
using System.Collections.Generic;
using System.Linq;
using MediaBrowser.Common.Configuration;

namespace Jellio.Services;

// Real gap in stock Jellyfin: GET /Shows/NextUp has no matching endpoint
// that hides one series from it permanently, only ever the side effect
// of marking an episode played (which just advances that same series to
// its own next episode, real bug reported live, components/
// cardOptionsMenu.js's own "Remove from Up Next" button). This stores a
// per user set of series ids to exclude from that row, same JsonUserStore
// one-file-per-user-id shape everything else in this plugin's own data
// directory already uses.
public class NextUpHiddenStore(IApplicationPaths applicationPaths)
{
    private readonly JsonUserStore<List<string>> _store =
        new(applicationPaths, "next-up-hidden", () => []);

    public List<string> Load(Guid userId) => _store.Load(userId);

    public List<string> Hide(Guid userId, string seriesId) =>
        _store.Update(userId, hidden =>
        {
            if (!hidden.Contains(seriesId, StringComparer.OrdinalIgnoreCase))
            {
                hidden.Add(seriesId);
            }
        });
}
