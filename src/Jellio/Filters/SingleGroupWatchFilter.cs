using System;
using Jellio.Extensions;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Controller.SyncPlay;
using MediaBrowser.Controller.SyncPlay.Requests;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.Logging;

namespace Jellio.Filters;

/// <summary>
/// One Group Watch per person. Jellyfin keeps each session (device) in at
/// most one SyncPlay group, but the same person's browser, TV and Mac are
/// separate sessions and could each sit in a different group. Creating or
/// joining a group first takes the person's other devices out of theirs,
/// except when joining a group they are already in on another device: then
/// both devices watch together instead of throwing each other out.
/// </summary>
public class SingleGroupWatchFilter(
    ISessionManager sessionManager,
    ISyncPlayManager syncPlayManager,
    IUserManager userManager,
    Jellio.Services.Parties.PartyService parties,
    ILogger<SingleGroupWatchFilter> logger) : IAsyncActionFilter
{
    public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
    {
        // A private party takes only people let in by its code or an invite.
        if (context.ActionDescriptor is ControllerActionDescriptor { ActionName: "SyncPlayJoinGroup" }
            && context.HttpContext.User.TryGetJellyfinUserId(out var joiningUserId)
            && TargetGroupId(context) is { } joiningGroupId
            && parties.Get(joiningGroupId) is { Private: true } meta
            && !parties.IsAdmitted(meta, joiningUserId)
            && !AlreadyInTargetGroup(context, joiningUserId, context.HttpContext.User.FindFirst("Jellyfin-DeviceId")?.Value))
        {
            context.Result = new StatusCodeResult(403);
            return;
        }

        if (
            context.ActionDescriptor is ControllerActionDescriptor { ActionName: "SyncPlayCreateGroup" or "SyncPlayJoinGroup" }
            && context.HttpContext.User.TryGetJellyfinUserId(out var userId)
            && syncPlayManager.IsUserActive(userId)
        )
        {
            var deviceId = context.HttpContext.User.FindFirst("Jellyfin-DeviceId")?.Value;
            if (context.ActionDescriptor is ControllerActionDescriptor { ActionName: "SyncPlayJoinGroup" }
                && AlreadyInTargetGroup(context, userId, deviceId))
            {
                await next().ConfigureAwait(false);
                return;
            }

            var others = sessionManager.Sessions
                .Where(s => s.UserId == userId && !string.Equals(s.DeviceId, deviceId, StringComparison.Ordinal))
                .ToList();
            foreach (var session in others)
            {
                try
                {
                    syncPlayManager.LeaveGroup(session, new LeaveGroupRequest(), CancellationToken.None);
                }
                catch (Exception ex)
                {
                    logger.LogDebug(ex, "Jellio: could not take {Device} out of its Group Watch", session.DeviceName);
                }
            }
        }

        await next().ConfigureAwait(false);
    }

    private static Guid? TargetGroupId(ActionExecutingContext context)
    {
        var id = context.ActionArguments.Values
            .Select(value => value?.GetType().GetProperty("GroupId")?.GetValue(value))
            .OfType<Guid>()
            .FirstOrDefault();
        return id == Guid.Empty ? null : id;
    }

    // Whether this person is already a participant of the group being
    // joined (on another of their devices). Groups only list names.
    private bool AlreadyInTargetGroup(ActionExecutingContext context, Guid userId, string? deviceId)
    {
        var targetId = TargetGroupId(context) ?? Guid.Empty;
        var userName = userManager.GetUserById(userId)?.Username;
        if (targetId == Guid.Empty || string.IsNullOrEmpty(userName))
        {
            return false;
        }

        var session = sessionManager.Sessions.FirstOrDefault(s => s.UserId == userId && string.Equals(s.DeviceId, deviceId, StringComparison.Ordinal))
            ?? sessionManager.Sessions.FirstOrDefault(s => s.UserId == userId);
        if (session == null)
        {
            return false;
        }

        try
        {
            var target = syncPlayManager.ListGroups(session, new ListGroupsRequest()).FirstOrDefault(g => g.GroupId == targetId);
            return target != null && target.Participants.Contains(userName, StringComparer.Ordinal);
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Jellio: could not read the Group Watch being joined");
            return false;
        }
    }
}
