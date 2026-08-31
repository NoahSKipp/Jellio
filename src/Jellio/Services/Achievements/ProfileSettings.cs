namespace Jellio.Services.Achievements;

// One of these per user, same JSON-per-user-id shape everything else in
// this plugin's own data directory already uses. Banner image bytes live
// as their own file under BannersController's own directory instead of
// base64 in here, same real reason avatars are files rather than a JSON
// blob. Kept its own store separate from UserAchievementStats: different
// write cadence (a hosted service writes stats off every playback stop,
// a user writes this off a settings/profile screen edit), no real reason
// to share a file between them.
public class ProfileSettings
{
    public bool IsPrivate { get; set; }

    public string? Bio { get; set; }

    // Off by default, real feedback's own explicit ask: a reader who
    // never turns this on should see nothing different at all, not a
    // watchlist button that now asks Watchlist or Grouplist every
    // single click. Gates screens/home.js's own Grouplist tab, the
    // watchlist button's own list-picker popover, and Group Watch
    // chat's own ranking session trigger alike, one flag for all three
    // rather than a separate toggle per surface.
    public bool GrouplistEnabled { get; set; }
}
