using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace Jellio.Services.Achievements;

public class CustomGenreItemDto
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("category")]
    public string? Category { get; set; }

    [JsonPropertyName("enabled")]
    public bool Enabled { get; set; } = true;
}

public class ProfileSettings
{
    public bool IsPrivate { get; set; }

    public string? Bio { get; set; }

    public bool FriendsCanAddToWatchlist { get; set; } = true;

    // "everyone" or "nobody".
    public string FriendRequestsFrom { get; set; } = "everyone";

    public bool GrouplistEnabled { get; set; }

    public bool RemoveFromWatchlistAfterWatching { get; set; } = true;

    [JsonPropertyName("selectedGenres")]
    public List<string>? SelectedGenres { get; set; }

    [JsonPropertyName("customGenres")]
    public List<CustomGenreItemDto>? CustomGenres { get; set; }

    [JsonPropertyName("subtitleStyle")]
    public SubtitleStyleDto? SubtitleStyle { get; set; }
}

public class SubtitleStyleDto
{
    [JsonPropertyName("size")]
    public string? Size { get; set; }

    [JsonPropertyName("background")]
    public string? Background { get; set; }

    [JsonPropertyName("color")]
    public string? Color { get; set; }

    [JsonPropertyName("edge")]
    public string? Edge { get; set; }

    [JsonPropertyName("position")]
    public string? Position { get; set; }
}
