using System;
using System.Collections.Generic;
using System.Linq;
using Jellio.Services.Achievements;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

[ApiController]
[Route("Jellio/feed")]
[Authorize]
public class FeedController(
    IUserManager userManager,
    AchievementStore achievementStore,
    ProfileSettingsStore profileSettingsStore,
    Jellio.Services.Parties.PartyService parties,
    ILibraryManager libraryManager) : ControllerBase
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
        string? BadgeRarity,
        int? PagesRead = null,
        int? CurrentPage = null,
        int? PageCount = null,
        long? ListenedTicks = null,
        bool Finished = false,
        bool Rewatch = false,
        string? PartyName = null,
        IReadOnlyList<string>? PartyMembers = null,
        IReadOnlyList<string>? PartyReactions = null,
        int PartyTitleCount = 0);

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

            // Reading and listening only show once finished; older progress
            // entries stay in the profile history but not on the feed.
            var finishedOrWatched = stats.RecentActivity
                .Where(entry => entry.ItemType is not ("Book" or "Manga" or "AudioBook") || entry.Finished)
                .ToList();
            entries.AddRange(
                ActivityGrouping.Group(finishedOrWatched).Select(group =>
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
                        null,
                        group.PagesRead,
                        group.CurrentPage,
                        group.PageCount,
                        group.ListenedTicks,
                        group.Finished,
                        group.Rewatch)));

            foreach (var badge in AchievementCatalog.All)
            {
                if (!stats.UnlockedBadgeIds.Contains(badge.Id)
                    || stats.HiddenFeedBadgeIds.Contains(badge.Id)
                    || !stats.UnlockedAt.TryGetValue(badge.Id, out var unlockedAt))
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

        // Watch parties: one entry each, under the host.
        foreach (var summary in parties.Summaries())
        {
            if (profileSettingsStore.Load(summary.HostUserId).IsPrivate)
            {
                continue;
            }

            var first = summary.ItemIds.Count > 0 ? libraryManager.GetItemById(summary.ItemIds[0]) : null;
            var episode = first as MediaBrowser.Controller.Entities.TV.Episode;
            entries.Add(new FeedEntry(
                summary.HostUserId,
                summary.HostName,
                "Party",
                summary.EndedAt,
                first?.Id,
                first?.Name,
                first?.GetBaseItemKind().ToString(),
                episode?.SeriesName,
                episode?.SeriesId,
                0,
                episode?.ParentIndexNumber,
                episode?.IndexNumber,
                episode?.IndexNumber,
                null,
                null,
                null,
                null,
                PartyName: summary.Name,
                PartyMembers: summary.Members,
                PartyReactions: summary.TopReactions,
                PartyTitleCount: summary.ItemIds.Count));
        }

        var ordered = entries
            .OrderByDescending(entry => entry.OccurredAtUtc)
            .Take(MaxEntries);

        return Ok(ordered);
    }
}
