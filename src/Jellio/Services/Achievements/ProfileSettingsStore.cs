using System;
using Jellio.Services;
using MediaBrowser.Common.Configuration;

namespace Jellio.Services.Achievements;

public class ProfileSettingsStore(IApplicationPaths applicationPaths)
{
    private readonly JsonUserStore<ProfileSettings> _store =
        new(applicationPaths, "profile-settings", () => new ProfileSettings());

    public ProfileSettings Load(Guid userId) => _store.Load(userId);

    public ProfileSettings Update(Guid userId, Action<ProfileSettings> mutate) => _store.Update(userId, mutate);

    public void Save(Guid userId, ProfileSettings settings) => _store.Save(userId, settings);
}
