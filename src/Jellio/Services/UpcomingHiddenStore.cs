using System;
using System.Collections.Generic;
using System.Linq;
using MediaBrowser.Common.Configuration;

namespace Jellio.Services;

// Titles a user took out of Upcoming. A series they watched one episode of
// is otherwise followed for years (CalendarService.ShouldMonitorSeries).
public class UpcomingHiddenStore(IApplicationPaths applicationPaths)
{
    private readonly JsonUserStore<List<string>> _store = new(applicationPaths, "upcoming-hidden", () => []);

    public HashSet<Guid> Load(Guid userId) =>
        _store.Load(userId).Select(id => Guid.TryParse(id, out var guid) ? guid : Guid.Empty).Where(id => id != Guid.Empty).ToHashSet();

    public bool Hide(Guid userId, Guid itemId)
    {
        var key = itemId.ToString("N");
        var changed = false;
        _store.UpdateIfChanged(userId, hidden =>
        {
            changed = !hidden.Contains(key, StringComparer.OrdinalIgnoreCase);
            if (changed)
            {
                hidden.Add(key);
            }

            return changed;
        });

        return changed;
    }

    public bool Unhide(Guid userId, Guid itemId)
    {
        var key = itemId.ToString("N");
        var changed = false;
        _store.UpdateIfChanged(userId, hidden =>
        {
            changed = hidden.RemoveAll(id => string.Equals(id, key, StringComparison.OrdinalIgnoreCase)) > 0;
            return changed;
        });

        return changed;
    }
}
