namespace Jellio.Services.Manga;

// Suwayomi reports a series status as an enum name (ONGOING, PUBLISHING_FINISHED).
public static class MangaStatusText
{
    public static string? Format(string? status)
    {
        if (string.IsNullOrWhiteSpace(status))
        {
            return null;
        }

        return status.Trim().ToUpperInvariant().Replace(' ', '_') switch
        {
            "ONGOING" => "Ongoing",
            "COMPLETED" => "Completed",
            "LICENSED" => "Licensed",
            "PUBLISHING_FINISHED" => "Publishing finished",
            "CANCELLED" => "Cancelled",
            "ON_HIATUS" => "On hiatus",
            "UNKNOWN" => null,
            _ => status.Trim(),
        };
    }
}
