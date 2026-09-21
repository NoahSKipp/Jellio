namespace Jellio.Services.CommunitySkip;

// Category, not each provider's own real raw type string (op/mixed-op/
// ed/mixed-ed/credits/ending/...): CommunitySkipProvider's own real
// mergeByPriority only ever needs to know which of the two real slots
// screens/player.js's own Introduction/Credits shape already has, the
// same real collapse NuvioTV's own segmentCategory() already does
// before this ever reaches its own real UI.
public enum CommunitySkipCategory
{
    Opening,
    Ending,
    Recap,
}

public record CommunitySkipInterval(double StartSeconds, double EndSeconds, CommunitySkipCategory Category, string Provider);
