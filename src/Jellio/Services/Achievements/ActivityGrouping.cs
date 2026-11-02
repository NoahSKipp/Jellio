using System.Collections.Generic;
using System.Linq;

namespace Jellio.Services.Achievements;

public static class ActivityGrouping
{
    public static int SpanEnd(List<ActivityEntry> activity, int start)
    {
        var first = activity[start];
        var end = start;
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

        return end;
    }

    public static IEnumerable<GroupedActivityEntry> Group(List<ActivityEntry> activity)
    {
        var i = 0;
        while (i < activity.Count)
        {
            var first = activity[i];
            var end = SpanEnd(activity, i);

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
                episodeNumbers.Count > 0 ? episodeNumbers.Max() : null,
                first.PagesRead,
                first.CurrentPage,
                first.PageCount,
                first.ListenedTicks,
                first.Finished,
                activity.Skip(i).Take(end - i + 1).All(entry => entry.Rewatch));

            i = end + 1;
        }
    }
}
