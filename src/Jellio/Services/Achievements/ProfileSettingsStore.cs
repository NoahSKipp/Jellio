using System;
using Jellio.Services;
using MediaBrowser.Common.Configuration;

namespace Jellio.Services.Achievements;

public class ProfileSettingsStore(IApplicationPaths applicationPaths)
{
    private readonly JsonUserStore<ProfileSettings> _store =
        new(applicationPaths, "profile-settings", () => new ProfileSettings());

    public ProfileSettings Load(Guid userId) => _store.Load(userId);

    // Real atomic Load-mutate-Save a caller needs instead of its own
    // separate Load()/Save() pair: JsonUserStore's own header explains
    // why a caller doing those two steps itself, with real time for
    // another request to land between them, is exactly the real bug
    // this exists to close off.
    public ProfileSettings Update(Guid userId, Action<ProfileSettings> mutate) => _store.Update(userId, mutate);

    public void Save(Guid userId, ProfileSettings settings) => _store.Save(userId, settings);
}
