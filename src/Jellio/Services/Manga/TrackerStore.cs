using System.Collections.Generic;
using MediaBrowser.Common.Configuration;

namespace Jellio.Services.Manga;

public class TrackLink
{
    public int MediaId { get; set; }

    public string Title { get; set; } = string.Empty;

    public string? CoverUrl { get; set; }
}

public class TrackerData
{
    // The reader's AniList access token. Server side only: no endpoint
    // ever returns it.
    public string? AniListToken { get; set; }

    public string? AniListName { get; set; }

    // Series shelf key ("s:...") to the AniList entry it tracks.
    public Dictionary<string, TrackLink> Links { get; set; } = [];
}

public class TrackerStore(IApplicationPaths applicationPaths)
{
    private readonly JsonUserStore<TrackerData> _store = new(applicationPaths, "trackers", () => new TrackerData());

    public TrackerData Load(System.Guid userId) => _store.Load(userId);

    public TrackerData Update(System.Guid userId, System.Action<TrackerData> mutate) => _store.Update(userId, mutate);
}
