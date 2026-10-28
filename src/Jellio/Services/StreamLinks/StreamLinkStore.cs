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
            saved.Kind = resolved.Entries != null ? StreamLinkKinds.Playlist : StreamLinkKinds.Stream;
            saved.Entries = resolved.Entries ?? [];
            saved.RefreshedAt = DateTime.UtcNow;
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

            updated.Kind = resolved.Entries != null ? StreamLinkKinds.Playlist : StreamLinkKinds.Stream;
            updated.Entries = resolved.Entries ?? [];
            updated.RefreshedAt = DateTime.UtcNow;
        });

        return updated;
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
