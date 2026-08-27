using System;
using System.Collections.Generic;
using System.Linq;
using Jellio.Services.Achievements;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

/// <summary>
/// Server wide "what has everyone been up to lately": watch activity
/// (the same real RecentActivity AchievementService already persists per
/// user, AchievementsController's own {userId} route header explains why
/// that exists rather than a second event pipeline) and badge unlocks
/// (that same user's own UnlockedBadgeIds/UnlockedAt), merged across
/// every real user on this server and re-sorted by OccurredAtUtc. A
/// private profile's own entries, watch or badge, are skipped outright
/// here, not just greyed out client side: real feedback specifically
/// asked that a private user's own activity never appear on this feed
/// at all.
///
/// Kind ("Watch" or "Badge") is a flat discriminator on one real record
/// rather than two separate response shapes: this whole feed is already
/// one merged, re-sorted list on the wire, splitting it into two typed
/// arrays would only push the same merge-by-time work onto
/// screens/feed.js instead of doing it once here.
///
/// userManager.GetUsers() rather than the Users property on purpose:
/// DefaultAvatarService's own header covers the exact real ABI drift
/// (a mismatched server build's own IUserManager surface) that made
/// the property crash live once already, GetUsers() is the confirmed
/// real 10.11.11 surface this plugin now targets everywhere it enumerates
/// every user.
///
/// ActivityGrouping.Group is real feedback too: an unbroken binge used
/// to post one row per episode, drowning out everyone else's own real
/// activity underneath a single user's own session. Grouped per user,
/// before this ever merges across users, not after: merging first and
/// grouping adjacency in the merged list would have grouped across two
/// different real users who happened to finish an episode close
/// together, which is not one real binge.
/// </summary>
[ApiController]
[Route("Jellio/feed")]
[Authorize]
public class FeedController(IUserManager userManager, AchievementStore achievementStore, ProfileSettingsStore profileSettingsStore) : ControllerBase
{
    private const int MaxEntries = 60;

    public record FeedEntry(
        Guid UserId,
        string UserName,
        string Kind,
        DateTime OccurredAtUtc,
        Guid? ItemId,
        string? ItemName,
        string? ItemType,
        string? SeriesName,
        Guid? SeriesId,
        int EpisodeCount,
        int? SeasonNumber,
        int? FirstEpisodeNumber,
        int? LastEpisodeNumber,
        string? BadgeId,
        string? BadgeName,
        string? BadgeDescription,
        string? BadgeRarity);

    [HttpGet]
    public IActionResult Get()
    {
        var entries = new List<FeedEntry>();

        foreach (var user in userManager.GetUsers())
        {
            if (profileSettingsStore.Load(user.Id).IsPrivate)
            {
                continue;
            }

            var stats = achievementStore.Load(user.Id);

            entries.AddRange(
                ActivityGrouping.Group(stats.RecentActivity).Select(group =>
                    new FeedEntry(
                        user.Id,
                        user.Username,
                        "Watch",
                        group.CompletedAtUtc,
                        group.ItemId,
                        group.ItemName,
                        group.ItemType,
                        group.SeriesName,
                        group.SeriesId,
                        group.EpisodeCount,
                        group.SeasonNumber,
                        group.FirstEpisodeNumber,
                        group.LastEpisodeNumber,
                        null,
                        null,
                        null,
                        null)));

            foreach (var badge in AchievementCatalog.All)
            {
                if (!stats.UnlockedBadgeIds.Contains(badge.Id) || !stats.UnlockedAt.TryGetValue(badge.Id, out var unlockedAt))
                {
                    continue;
                }

                entries.Add(new FeedEntry(
                    user.Id,
                    user.Username,
                    "Badge",
                    unlockedAt,
                    null,
                    null,
                    null,
                    null,
                    null,
                    0,
                    null,
                    null,
                    null,
                    badge.Id,
                    badge.Name,
                    badge.Description,
                    badge.Rarity.ToString()));
            }
        }

        var ordered = entries
            .OrderByDescending(entry => entry.OccurredAtUtc)
            .Take(MaxEntries);

        return Ok(ordered);
    }
}
