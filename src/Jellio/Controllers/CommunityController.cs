using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Security.Claims;
using Jellio.Services;
using Jellio.Services.Achievements;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellio.Controllers;

/// <summary>
/// Server wide "what others are watching" endpoint for recommendation rows.
/// Collects active streaming sessions, in-progress items, and recently finished items
/// across all non-private server users, collapsing multiple watchers per item/series.
/// </summary>
[ApiController]
[Route("Jellio/community")]
[Authorize]
public class CommunityController(
    ISessionManager sessionManager,
    ILibraryManager libraryManager,
    IUserManager userManager,
    IUserDataManager userDataManager,
    IDtoService dtoService,
    ProfileSettingsStore profileSettingsStore,
    CommunityWatchingCache cache,
    ILogger<CommunityController> logger) : ControllerBase
{
    public record CommunityUserDto(Guid Id, string Name, string? PrimaryImageTag);

    public record CommunityWatcherDto(
        Guid UserId,
        string UserName,
        string? PrimaryImageTag,
        string Activity
    );

    public record CommunityWatchingItem(
        BaseItemDto Item,
        List<CommunityWatcherDto> Watchers
    );

    public record CommunityWatchingResponse(
        List<CommunityWatchingItem> Items
    );

    public record HistoricalActivity(
        Guid ItemId,
        Guid UserId,
        string Activity,
        int Priority,
        DateTime Date
    );

    [HttpGet("users")]
    public ActionResult<List<CommunityUserDto>> GetUsers()
    {
        var users = userManager.GetUsers()
            .Where(u => !profileSettingsStore.Load(u.Id).IsPrivate)
            .Select(u => new CommunityUserDto(
                u.Id,
                u.Username,
                u.ProfileImage != null ? u.Id.ToString("N") : null
            ))
            .ToList();

        return Ok(users);
    }

    [HttpGet("watching")]
    public ActionResult<CommunityWatchingResponse> GetWatching([FromQuery] string? excludedUserIds)
    {
        var callerUserId = HttpContext.User.Identity is ClaimsIdentity identity && Guid.TryParse(identity.FindFirst("Jellyfin-UserId")?.Value, out var cid) ? cid : Guid.Empty;
        var caller = callerUserId != Guid.Empty ? userManager.GetUserById(callerUserId) : null;
        if (caller is null)
        {
            return Unauthorized();
        }

        var cacheKey = callerUserId.ToString("N") + "|" + string.Join(',', (excludedUserIds ?? string.Empty).Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Order(StringComparer.OrdinalIgnoreCase));
        if (cache.TryGet(cacheKey, out var cachedResponse) && cachedResponse is CommunityWatchingResponse hit)
        {
            return Ok(hit);
        }

        var timer = Stopwatch.StartNew();
        var excludedSet = new HashSet<Guid>();
        if (!string.IsNullOrWhiteSpace(excludedUserIds))
        {
            foreach (var part in excludedUserIds.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                if (Guid.TryParse(part, out var guid))
                {
                    excludedSet.Add(guid);
                }
            }
        }

        var eligibleUsers = userManager.GetUsers()
            .Where(u => u.Id != callerUserId && !profileSettingsStore.Load(u.Id).IsPrivate && !excludedSet.Contains(u.Id))
            .ToList();

        if (eligibleUsers.Count == 0)
        {
            var empty = new CommunityWatchingResponse([]);
            cache.Set(cacheKey, empty);
            return Ok(empty);
        }

        var eligibleUserIds = eligibleUsers.Select(u => u.Id).ToHashSet();
        var userMap = eligibleUsers.ToDictionary(u => u.Id, u => u);

        var candidates = new Dictionary<Guid, (BaseItem Item, List<CommunityWatcherDto> Watchers, int Priority, DateTime LastActivity)>();

        void RegisterWatcher(BaseItem rawItem, Guid userId, string activity, int priority, DateTime activityTime)
        {
            if (rawItem is null) return;
            var targetItem = rawItem is Episode ep
                ? (libraryManager.GetItemById(ep.SeriesId) ?? ep.Series ?? (BaseItem)ep)
                : rawItem;
            if (!targetItem.IsVisible(caller)) return;

            var user = userMap.GetValueOrDefault(userId);
            if (user is null) return;

            var primaryTag = user.ProfileImage != null ? user.Id.ToString("N") : null;
            var watcher = new CommunityWatcherDto(user.Id, user.Username, primaryTag, activity);

            if (candidates.TryGetValue(targetItem.Id, out var existing))
            {
                if (!existing.Watchers.Any(w => w.UserId == user.Id))
                {
                    existing.Watchers.Add(watcher);
                }
                var bestPriority = Math.Min(existing.Priority, priority);
                var latestTime = activityTime > existing.LastActivity ? activityTime : existing.LastActivity;
                candidates[targetItem.Id] = (existing.Item, existing.Watchers, bestPriority, latestTime);
            }
            else
            {
                candidates[targetItem.Id] = (targetItem, new List<CommunityWatcherDto> { watcher }, priority, activityTime);
            }
        }

        // 1. Active video sessions
        var activeSessions = sessionManager.Sessions
            .Where(s => s.NowPlayingItem != null && eligibleUserIds.Contains(s.UserId))
            .ToList();

        foreach (var s in activeSessions)
        {
            var item = libraryManager.GetItemById(s.NowPlayingItem.Id);
            if (item != null)
            {
                var isPaused = s.PlayState?.IsPaused ?? false;
                RegisterWatcher(item, s.UserId, isPaused ? "paused" : "playing", 0, DateTime.UtcNow);
            }
        }

        // 2 & 3: In-progress / Resumable items and recently finished items across eligible users.
        // Uses a 5-minute historical cache so expensive SQLite database queries across all users
        // do not run on every page visit or playback start.
        if (!cache.TryGetHistory<List<HistoricalActivity>>(out var history) || history == null)
        {
            var fourteenDaysAgo = DateTime.UtcNow.AddDays(-14);
            history = eligibleUsers
                .AsParallel()
                .SelectMany(user =>
                {
                    var userHistory = new List<HistoricalActivity>();

                    var resumable = libraryManager.GetItemList(new InternalItemsQuery(user)
                    {
                        IncludeItemTypes = [BaseItemKind.Movie, BaseItemKind.Episode],
                        IsResumable = true,
                        Recursive = true,
                        OrderBy = [(ItemSortBy.DatePlayed, SortOrder.Descending)],
                        Limit = 8,
                    });

                    foreach (var item in resumable)
                    {
                        var date = userDataManager.GetUserData(user, item)?.LastPlayedDate ?? DateTime.MinValue;
                        userHistory.Add(new HistoricalActivity(item.Id, user.Id, "watching", 1, date));
                    }

                    var played = libraryManager.GetItemList(new InternalItemsQuery(user)
                    {
                        IncludeItemTypes = [BaseItemKind.Movie, BaseItemKind.Episode],
                        IsPlayed = true,
                        Recursive = true,
                        OrderBy = [(ItemSortBy.DatePlayed, SortOrder.Descending)],
                        Limit = 12,
                    });

                    foreach (var item in played)
                    {
                        var date = userDataManager.GetUserData(user, item)?.LastPlayedDate ?? DateTime.MinValue;
                        if (date >= fourteenDaysAgo)
                        {
                            userHistory.Add(new HistoricalActivity(item.Id, user.Id, "finished", 2, date));
                        }
                    }

                    return userHistory;
                })
                .ToList();

            cache.SetHistory(history);
        }

        foreach (var entry in history)
        {
            if (eligibleUserIds.Contains(entry.UserId))
            {
                var item = libraryManager.GetItemById(entry.ItemId);
                if (item != null)
                {
                    RegisterWatcher(item, entry.UserId, entry.Activity, entry.Priority, entry.Date);
                }
            }
        }

        var dtoOptions = new DtoOptions
        {
            Fields = [ItemFields.PrimaryImageAspectRatio, ItemFields.Genres],
            EnableUserData = true,
            EnableImages = true,
        };

        var orderedCandidates = candidates.Values
            .OrderBy(c => c.Priority)
            .ThenByDescending(c => c.LastActivity)
            .Take(24)
            .ToList();

        var resultItems = new List<CommunityWatchingItem>();
        foreach (var candidate in orderedCandidates)
        {
            var item = libraryManager.GetItemById(candidate.Item.Id) ?? candidate.Item;
            var dto = dtoService.GetBaseItemDto(item, dtoOptions, caller);
            resultItems.Add(new CommunityWatchingItem(dto, candidate.Watchers));
        }

        var response = new CommunityWatchingResponse(resultItems);
        cache.Set(cacheKey, response);
        logger.LogInformation(
            "Jellio: community watching built in {Ms} ms for {Users} users, {Items} items",
            timer.ElapsedMilliseconds,
            eligibleUsers.Count,
            resultItems.Count);
        return Ok(response);
    }
}
