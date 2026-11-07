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

    public bool GrouplistEnabled { get; set; }

    public bool RemoveFromWatchlistAfterWatching { get; set; } = true;

    [JsonPropertyName("selectedGenres")]
    public List<string>? SelectedGenres { get; set; }

    [JsonPropertyName("customGenres")]
    public List<CustomGenreItemDto>? CustomGenres { get; set; }
}
