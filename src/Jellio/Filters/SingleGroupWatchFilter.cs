using System;
using System.Linq;
using System.Security.Claims;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Session;
using MediaBrowser.Controller.SyncPlay;
using MediaBrowser.Model.SyncPlay.Requests;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.Logging;

namespace Jellio.Filters;

/// <summary>
/// One Group Watch per person. Jellyfin keeps each session (device) in at
/// most one SyncPlay group, but the same person's browser, TV and Mac are
/// separate sessions and could each sit in a different group. Creating or
/// joining a group first takes the person's other devices out of theirs.
/// </summary>
public class SingleGroupWatchFilter(
    ISessionManager sessionManager,
    ISyncPlayManager syncPlayManager,
    ILogger<SingleGroupWatchFilter> logger) : IAsyncActionFilter
{
    public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
    {
        if (
            context.ActionDescriptor is ControllerActionDescriptor { ActionName: "SyncPlayCreateGroup" or "SyncPlayJoinGroup" }
            && Guid.TryParse(context.HttpContext.User.FindFirst("Jellyfin-UserId")?.Value, out var userId)
            && syncPlayManager.IsUserActive(userId)
        )
        {
            var deviceId = context.HttpContext.User.FindFirst("Jellyfin-DeviceId")?.Value;
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
}
