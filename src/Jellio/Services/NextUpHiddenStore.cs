using System;
using System.Collections.Generic;
using System.Linq;
using MediaBrowser.Common.Configuration;

namespace Jellio.Services;

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
