using MediaBrowser.Model.Plugins;

namespace Jellio.Configuration;

public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>Master switch. Disabling this restores the stock web client on next start.</summary>
    public bool EnableReskin { get; set; } = true;

    public bool SeasonalEffectsEnabled { get; set; } = true;

    public bool SeasonalHalloweenEnabled { get; set; } = true;
    public int SeasonalHalloweenStartMonth { get; set; } = 10;
    public int SeasonalHalloweenStartDay { get; set; } = 24;
    public int SeasonalHalloweenEndMonth { get; set; } = 11;
    public int SeasonalHalloweenEndDay { get; set; } = 2;

    public bool SeasonalNewYearEnabled { get; set; } = true;
    public int SeasonalNewYearStartMonth { get; set; } = 12;
    public int SeasonalNewYearStartDay { get; set; } = 28;
    public int SeasonalNewYearEndMonth { get; set; } = 1;
    public int SeasonalNewYearEndDay { get; set; } = 2;

    public bool SeasonalValentineEnabled { get; set; } = true;
    public int SeasonalValentineStartMonth { get; set; } = 2;
    public int SeasonalValentineStartDay { get; set; } = 10;
    public int SeasonalValentineEndMonth { get; set; } = 2;
    public int SeasonalValentineEndDay { get; set; } = 18;

    public bool SeasonalChristmasEnabled { get; set; } = true;
    public int SeasonalChristmasStartMonth { get; set; } = 12;
    public int SeasonalChristmasStartDay { get; set; } = 1;
    public int SeasonalChristmasEndMonth { get; set; } = 12;
    public int SeasonalChristmasEndDay { get; set; } = 26;

    public string TmdbAccessToken { get; set; } = string.Empty;

    public string TheIntroDbApiKey { get; set; } = string.Empty;

    public bool EnableSkipMeDb { get; set; }

    public string IntroDbApiKey { get; set; } = string.Empty;

    public string SimklClientId { get; set; } = string.Empty;

    public string AnimeSkipClientId { get; set; } = string.Empty;

    public bool SkipIntroCreditsAdminMenuEnabled { get; set; }

    public string VideoTranscodePolicy { get; set; } = "Allow";

    public bool HomeRowCache { get; set; } = true;

    public string ChaptarrUrl { get; set; } = string.Empty;

    public string ChaptarrApiKey { get; set; } = string.Empty;

    public string DeepLApiKey { get; set; } = string.Empty;

    public string SuwayomiUrl { get; set; } = string.Empty;

    public string SuwayomiUsername { get; set; } = string.Empty;

    public string SuwayomiPassword { get; set; } = string.Empty;

    public string SuwayomiLanguages { get; set; } = "en";

    // Search sources Suwayomi flags NSFW. Most general manga aggregators
    // carry the flag for the whole source, so with it off they're skipped.
    public bool SuwayomiIncludeNsfw { get; set; }

    public bool SuwayomiDownloadRequests { get; set; }

    public string MangaSourcePriority { get; set; } = string.Empty;

    public string AniListClientId { get; set; } = string.Empty;

    // A stream a user added by link that has not worked for this many days
    // is removed from their My streams, with a notification. 0 keeps them.
    public int StreamLinkAutoRemoveDays { get; set; } = 14;

    public string StreamFinderUrl { get; set; } = string.Empty;
}
