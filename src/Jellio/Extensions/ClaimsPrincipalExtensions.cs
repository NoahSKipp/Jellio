using System;
using System.Security.Claims;

namespace Jellio.Extensions;

public static class ClaimsPrincipalExtensions
{
    public static bool TryGetJellyfinUserId(this ClaimsPrincipal? user, out Guid userId)
    {
        userId = Guid.Empty;
        return user != null && Guid.TryParse(user.FindFirst("Jellyfin-UserId")?.Value, out userId);
    }

    public static Guid GetJellyfinUserId(this ClaimsPrincipal? user) =>
        user.TryGetJellyfinUserId(out var userId) ? userId : Guid.Empty;
}
