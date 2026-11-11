using System;
using MediaBrowser.Common.Configuration;

namespace Jellio.Services.Friends;

// One shared record for the whole server, so both sides of a friendship change
// atomically. It reuses the per-user store under a fixed key.
public class FriendsStore(IApplicationPaths applicationPaths)
{
    private static readonly Guid Key = Guid.Empty;

    private readonly JsonUserStore<FriendsData> _store =
        new(applicationPaths, "friends", () => new FriendsData());

    public T Read<T>(Func<FriendsData, T> read)
    {
        var result = default(T)!;
        _store.UpdateIfChanged(Key, data =>
        {
            result = read(data);
            return false;
        });
        return result;
    }

    public T Mutate<T>(Func<FriendsData, T> mutate)
    {
        var result = default(T)!;
        _store.Update(Key, data => result = mutate(data));
        return result;
    }
}
