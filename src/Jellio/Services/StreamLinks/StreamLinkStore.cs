using System;
using System.Collections.Generic;
using System.Linq;
using MediaBrowser.Common.Configuration;

namespace Jellio.Services.StreamLinks;

public class StreamLinkStore(IApplicationPaths applicationPaths)
{
    public const int MaxLinksPerUser = 100;

    private readonly JsonUserStore<List<StreamLink>> _store = new(applicationPaths, "stream-links", () => []);

    public List<StreamLink> List(Guid userId) => _store.Load(userId);

    public IReadOnlyList<Guid> UserIds() => _store.UserIds();

    public StreamLink? Get(Guid userId, string id) =>
        _store.Load(userId).FirstOrDefault(link => link.Id == id);

    public StreamLink Add(Guid userId, string sourceUrl, string name, ResolveResult resolved)
    {
        StreamLink? saved = null;
        _store.Update(userId, links =>
        {
            // The same address again refreshes the one already saved.
            var existing = links.FirstOrDefault(link => link.SourceUrl == sourceUrl);
            if (existing == null && links.Count >= MaxLinksPerUser)
            {
                throw new StreamLinkException(StreamLinkErrors.TooMany);
            }

            saved = existing ?? new StreamLink
            {
                Id = Guid.NewGuid().ToString("N")[..12],
                SourceUrl = sourceUrl,
                AddedAt = DateTime.UtcNow,
            };
            saved.Name = name;
            Apply(saved, resolved);
            if (existing == null)
            {
                links.Insert(0, saved);
            }
        });

        return saved!;
    }

    public StreamLink? Refresh(Guid userId, string id, ResolveResult resolved)
    {
        StreamLink? updated = null;
        _store.Update(userId, links =>
        {
            updated = links.FirstOrDefault(link => link.Id == id);
            if (updated == null)
            {
                return;
            }

            Apply(updated, resolved);
        });

        return updated;
    }

    // A refresh keeps what the page no longer says rather than blanking it.
    private static void Apply(StreamLink link, ResolveResult resolved)
    {
        var hidden = new HashSet<string>(link.HiddenEntries, StringComparer.Ordinal);
        link.Kind = resolved.Entries != null ? StreamLinkKinds.Playlist : StreamLinkKinds.Stream;
        link.Entries = (resolved.Entries ?? []).Where(entry => !hidden.Contains(entry.Url)).ToList();
        link.RefreshedAt = DateTime.UtcNow;
        link.Description = resolved.Metadata.Description ?? link.Description;
        link.ImageUrl = resolved.Metadata.ImageUrl ?? link.ImageUrl;
        link.SiteName = resolved.Metadata.SiteName ?? link.SiteName;
        link.Quality = resolved.Quality ?? link.Quality;
        MarkHealthy(link);
    }

    private static void MarkHealthy(StreamLink link)
    {
        link.Health = StreamLinkHealth.Ok;
        link.FailingSince = null;
        link.FailedChecks = 0;
        link.LastError = null;
        link.LastCheckedAt = DateTime.UtcNow;
    }

    // One channel out of a playlist, by its address so a refresh that
    // reorders the list still leaves it out.
    public bool RemoveEntry(Guid userId, string id, int index)
    {
        var removed = false;
        _store.UpdateIfChanged(userId, links =>
        {
            var link = links.FirstOrDefault(l => l.Id == id);
            if (link == null || link.Kind != StreamLinkKinds.Playlist || index < 0 || index >= link.Entries.Count)
            {
                return false;
            }

            var url = link.Entries[index].Url;
            link.Entries.RemoveAt(index);
            if (!link.HiddenEntries.Contains(url))
            {
                link.HiddenEntries.Add(url);
            }

            removed = true;
            return true;
        });

        return removed;
    }

    // Two failed checks in a row before a link counts as failing, so one
    // bad moment on the site doesn't flag it. True when it has just
    // started failing.
    public bool RecordCheck(Guid userId, string id, string? error, int failuresBeforeFailing)
    {
        var turnedFailing = false;
        _store.Update(userId, links =>
        {
            var link = links.FirstOrDefault(l => l.Id == id);
            if (link == null)
            {
                return;
            }

            if (error == null)
            {
                MarkHealthy(link);
                return;
            }

            link.FailedChecks++;
            link.LastError = error;
            link.LastCheckedAt = DateTime.UtcNow;
            if (link.FailedChecks >= failuresBeforeFailing && link.Health != StreamLinkHealth.Failing)
            {
                link.Health = StreamLinkHealth.Failing;
                link.FailingSince = DateTime.UtcNow;
                turnedFailing = true;
            }
        });

        return turnedFailing;
    }

    public bool Rename(Guid userId, string id, string name)
    {
        var found = false;
        _store.UpdateIfChanged(userId, links =>
        {
            var link = links.FirstOrDefault(l => l.Id == id);
            if (link == null || link.Name == name)
            {
                found = link != null;
                return false;
            }

            link.Name = name;
            found = true;
            return true;
        });

        return found;
    }

    // Links that have been failing since before the cutoff, taken out.
    public List<StreamLink> RemoveFailingSince(Guid userId, DateTime cutoff)
    {
        var removed = new List<StreamLink>();
        _store.UpdateIfChanged(userId, links =>
        {
            removed.AddRange(links.Where(l => l.Health == StreamLinkHealth.Failing && l.FailingSince is { } since && since < cutoff));
            links.RemoveAll(removed.Contains);
            return removed.Count > 0;
        });

        return removed;
    }

    public bool Remove(Guid userId, string id)
    {
        var removed = false;
        _store.UpdateIfChanged(userId, links =>
        {
            removed = links.RemoveAll(link => link.Id == id) > 0;
            return removed;
        });

        return removed;
    }
}
