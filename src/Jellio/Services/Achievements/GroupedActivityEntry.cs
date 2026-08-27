using System;

namespace Jellio.Services.Achievements;

public record GroupedActivityEntry(
    Guid ItemId,
    string ItemName,
    string ItemType,
    string? SeriesName,
    Guid? SeriesId,
    DateTime CompletedAtUtc,
    int EpisodeCount,
    int? SeasonNumber,
    int? FirstEpisodeNumber,
    int? LastEpisodeNumber);
