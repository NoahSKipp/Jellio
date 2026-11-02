namespace Jellio.Services.CommunitySkip;

public enum CommunitySkipCategory
{
    Opening,
    Ending,
    Recap,
}

public record CommunitySkipInterval(double StartSeconds, double EndSeconds, CommunitySkipCategory Category, string Provider);
