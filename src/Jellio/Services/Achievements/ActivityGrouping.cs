using System.Collections.Generic;
using System.Linq;

namespace Jellio.Services.Achievements;

// Shared by AchievementsController's own per user feed and
// FeedController's own server wide merge, same real grouping either
// way: a binge (same series, same UTC day, consecutive in this user's
// own newest-first RecentActivity) collapses into one entry instead of
// one row per episode, real feedback specifically asked not to drown
// the rest of a feed out under a single sitting.
public static class ActivityGrouping
{
    public static IEnumerable<GroupedActivityEntry> Group(List<ActivityEntry> activity)
    {
        var i = 0;
        while (i < activity.Count)
        {
            var first = activity[i];
            var end = i;
            if (first.ItemType == "Episode" && first.SeriesName is not null)
            {
                while (
                    end + 1 < activity.Count
                    && activity[end + 1].ItemType == "Episode"
                    && activity[end + 1].SeriesName == first.SeriesName
                    && activity[end + 1].SeasonNumber == first.SeasonNumber
                    && activity[end + 1].CompletedAtUtc.Date == first.CompletedAtUtc.Date)
                {
                    end++;
                }
            }

            var episodeNumbers = activity
                .Skip(i)
                .Take(end - i + 1)
                .Where(entry => entry.EpisodeNumber.HasValue)
                .Select(entry => entry.EpisodeNumber!.Value)
                .ToList();

            yield return new GroupedActivityEntry(
                first.ItemId,
                first.ItemName,
                first.ItemType,
                first.SeriesName,
                first.SeriesId,
                first.CompletedAtUtc,
                end - i + 1,
                first.SeasonNumber,
                episodeNumbers.Count > 0 ? episodeNumbers.Min() : null,
                episodeNumbers.Count > 0 ? episodeNumbers.Max() : null);

            i = end + 1;
        }
    }
}
