using MediaBrowser.Model.Plugins;

namespace Jellio.Configuration;

public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>Master switch. Disabling this restores the stock web client on next start.</summary>
    public bool EnableReskin { get; set; } = true;

    // Server wide, admin controlled, applies to every user: this whole
    // block is Jellio's own server side config for
    // Frontend/components/seasonalEffects.js's own overlay, the same
    // real thing per user customization would need to layer on top of
    // later, not something to invent a second config surface for now.
    // Flat properties throughout, the same convention every other real
    // Jellyfin plugin config already confirmed against in this codebase
    // (Gelato's own CatalogConfig, CodeDevMLH/Jellyfin-Seasonals' own
    // PluginConfiguration.cs) uses rather than a nested class, since
    // BasePluginConfiguration's own real XmlSerializer has no real
    // reason here to need one. Date ranges default to that same real
    // Seasonals plugin's own real default schedule (this codebase's own
    // Frontend/components/seasonalEffects.js already ported those once
    // for its own now removed client only defaults, same real numbers
    // here instead).
    public bool SeasonalEffectsEnabled { get; set; } = true;

    public bool SeasonalWinterEnabled { get; set; } = true;
    public int SeasonalWinterStartMonth { get; set; } = 12;
    public int SeasonalWinterStartDay { get; set; } = 1;
    public int SeasonalWinterEndMonth { get; set; } = 2;
    public int SeasonalWinterEndDay { get; set; } = 29;

    public bool SeasonalSpringEnabled { get; set; } = true;
    public int SeasonalSpringStartMonth { get; set; } = 3;
    public int SeasonalSpringStartDay { get; set; } = 1;
    public int SeasonalSpringEndMonth { get; set; } = 5;
    public int SeasonalSpringEndDay { get; set; } = 31;

    public bool SeasonalSummerEnabled { get; set; } = true;
    public int SeasonalSummerStartMonth { get; set; } = 6;
    public int SeasonalSummerStartDay { get; set; } = 1;
    public int SeasonalSummerEndMonth { get; set; } = 8;
    public int SeasonalSummerEndDay { get; set; } = 31;

    public bool SeasonalAutumnEnabled { get; set; } = true;
    public int SeasonalAutumnStartMonth { get; set; } = 9;
    public int SeasonalAutumnStartDay { get; set; } = 1;
    public int SeasonalAutumnEndMonth { get; set; } = 11;
    public int SeasonalAutumnEndDay { get; set; } = 30;

    public bool SeasonalHalloweenEnabled { get; set; } = true;
    public int SeasonalHalloweenStartMonth { get; set; } = 10;
    public int SeasonalHalloweenStartDay { get; set; } = 24;
    public int SeasonalHalloweenEndMonth { get; set; } = 11;
    public int SeasonalHalloweenEndDay { get; set; } = 5;

    public bool SeasonalNewYearEnabled { get; set; } = true;
    public int SeasonalNewYearStartMonth { get; set; } = 12;
    public int SeasonalNewYearStartDay { get; set; } = 28;
    public int SeasonalNewYearEndMonth { get; set; } = 1;
    public int SeasonalNewYearEndDay { get; set; } = 5;

    // No real date range: Frontend/components/seasonalEffects.js's own
    // isFriday13() checks the calendar directly (day 13, a real Friday),
    // the one theme here that was never a fixed window to begin with.
    public bool SeasonalFriday13Enabled { get; set; } = true;

    // Ported from CodeDevMLH/Jellyfin-Seasonals' own real SeasonalRules
    // default schedule, same real numbers as that plugin's own default
    // config: Hearts through Snowflakes below all have a real fixed
    // calendar window there, on by default the same way. Birthday, Eid,
    // Resurrection, NightSky, Matrix and Frost have no real fixed window
    // in that plugin either (a personal occasion, a lunar Islamic date,
    // a movable Orthodox one, or just a generic mood board with no real
    // date tied to it at all), off by default here for the same reason;
    // an admin who wants one can still enable it and pick their own real
    // range, a full calendar year by default so it shows immediately
    // once turned on rather than needing a date picked first too.
    public bool SeasonalHeartsEnabled { get; set; } = true;
    public int SeasonalHeartsStartMonth { get; set; } = 2;
    public int SeasonalHeartsStartDay { get; set; } = 10;
    public int SeasonalHeartsEndMonth { get; set; } = 2;
    public int SeasonalHeartsEndDay { get; set; } = 18;

    public bool SeasonalCarnivalEnabled { get; set; } = true;
    public int SeasonalCarnivalStartMonth { get; set; } = 2;
    public int SeasonalCarnivalStartDay { get; set; } = 19;
    public int SeasonalCarnivalEndMonth { get; set; } = 2;
    public int SeasonalCarnivalEndDay { get; set; } = 28;

    public bool SeasonalOscarEnabled { get; set; } = true;
    public int SeasonalOscarStartMonth { get; set; } = 2;
    public int SeasonalOscarStartDay { get; set; } = 23;
    public int SeasonalOscarEndMonth { get; set; } = 3;
    public int SeasonalOscarEndDay { get; set; } = 5;

    public bool SeasonalFilmNoirEnabled { get; set; } = true;
    public int SeasonalFilmNoirStartMonth { get; set; } = 3;
    public int SeasonalFilmNoirStartDay { get; set; } = 17;
    public int SeasonalFilmNoirEndMonth { get; set; } = 3;
    public int SeasonalFilmNoirEndDay { get; set; } = 17;

    public bool SeasonalEarthDayEnabled { get; set; } = true;
    public int SeasonalEarthDayStartMonth { get; set; } = 4;
    public int SeasonalEarthDayStartDay { get; set; } = 22;
    public int SeasonalEarthDayEndMonth { get; set; } = 4;
    public int SeasonalEarthDayEndDay { get; set; } = 22;

    public bool SeasonalCherryBlossomEnabled { get; set; } = true;
    public int SeasonalCherryBlossomStartMonth { get; set; } = 4;
    public int SeasonalCherryBlossomStartDay { get; set; } = 1;
    public int SeasonalCherryBlossomEndMonth { get; set; } = 4;
    public int SeasonalCherryBlossomEndDay { get; set; } = 30;

    public bool SeasonalStarWarsEnabled { get; set; } = true;
    public int SeasonalStarWarsStartMonth { get; set; } = 5;
    public int SeasonalStarWarsStartDay { get; set; } = 4;
    public int SeasonalStarWarsEndMonth { get; set; } = 5;
    public int SeasonalStarWarsEndDay { get; set; } = 5;

    public bool SeasonalEurovisionEnabled { get; set; } = true;
    public int SeasonalEurovisionStartMonth { get; set; } = 5;
    public int SeasonalEurovisionStartDay { get; set; } = 6;
    public int SeasonalEurovisionEndMonth { get; set; } = 5;
    public int SeasonalEurovisionEndDay { get; set; } = 12;

    public bool SeasonalPrideEnabled { get; set; } = true;
    public int SeasonalPrideStartMonth { get; set; } = 6;
    public int SeasonalPrideStartDay { get; set; } = 1;
    public int SeasonalPrideEndMonth { get; set; } = 6;
    public int SeasonalPrideEndDay { get; set; } = 30;

    public bool SeasonalOktoberfestEnabled { get; set; } = true;
    public int SeasonalOktoberfestStartMonth { get; set; } = 9;
    public int SeasonalOktoberfestStartDay { get; set; } = 20;
    public int SeasonalOktoberfestEndMonth { get; set; } = 10;
    public int SeasonalOktoberfestEndDay { get; set; } = 5;

    public bool SeasonalSpookyEnabled { get; set; } = true;
    public int SeasonalSpookyStartMonth { get; set; } = 10;
    public int SeasonalSpookyStartDay { get; set; } = 1;
    public int SeasonalSpookyEndMonth { get; set; } = 10;
    public int SeasonalSpookyEndDay { get; set; } = 23;

    public bool SeasonalChristmasEnabled { get; set; } = true;
    public int SeasonalChristmasStartMonth { get; set; } = 12;
    public int SeasonalChristmasStartDay { get; set; } = 1;
    public int SeasonalChristmasEndMonth { get; set; } = 12;
    public int SeasonalChristmasEndDay { get; set; } = 26;

    public bool SeasonalSnowflakesEnabled { get; set; } = true;
    public int SeasonalSnowflakesStartMonth { get; set; } = 12;
    public int SeasonalSnowflakesStartDay { get; set; } = 1;
    public int SeasonalSnowflakesEndMonth { get; set; } = 12;
    public int SeasonalSnowflakesEndDay { get; set; } = 31;

    public bool SeasonalBirthdayEnabled { get; set; } = false;
    public int SeasonalBirthdayStartMonth { get; set; } = 1;
    public int SeasonalBirthdayStartDay { get; set; } = 1;
    public int SeasonalBirthdayEndMonth { get; set; } = 12;
    public int SeasonalBirthdayEndDay { get; set; } = 31;

    public bool SeasonalEidEnabled { get; set; } = false;
    public int SeasonalEidStartMonth { get; set; } = 1;
    public int SeasonalEidStartDay { get; set; } = 1;
    public int SeasonalEidEndMonth { get; set; } = 12;
    public int SeasonalEidEndDay { get; set; } = 31;

    public bool SeasonalResurrectionEnabled { get; set; } = false;
    public int SeasonalResurrectionStartMonth { get; set; } = 1;
    public int SeasonalResurrectionStartDay { get; set; } = 1;
    public int SeasonalResurrectionEndMonth { get; set; } = 12;
    public int SeasonalResurrectionEndDay { get; set; } = 31;

    public bool SeasonalNightSkyEnabled { get; set; } = false;
    public int SeasonalNightSkyStartMonth { get; set; } = 1;
    public int SeasonalNightSkyStartDay { get; set; } = 1;
    public int SeasonalNightSkyEndMonth { get; set; } = 12;
    public int SeasonalNightSkyEndDay { get; set; } = 31;

    public bool SeasonalMatrixEnabled { get; set; } = false;
    public int SeasonalMatrixStartMonth { get; set; } = 1;
    public int SeasonalMatrixStartDay { get; set; } = 1;
    public int SeasonalMatrixEndMonth { get; set; } = 12;
    public int SeasonalMatrixEndDay { get; set; } = 31;

    public bool SeasonalFrostEnabled { get; set; } = false;
    public int SeasonalFrostStartMonth { get; set; } = 1;
    public int SeasonalFrostStartDay { get; set; } = 1;
    public int SeasonalFrostEndMonth { get; set; } = 12;
    public int SeasonalFrostEndDay { get; set; } = 31;

    // Batch two: Space Day and Mario Day are both real single day
    // occasions in that same real SeasonalRules schedule, Santa and
    // Underwater both real ranged ones there too. Snowfall's own real
    // schedule there is actually two separate ranges (January, then
    // February again); one combined January to February range here
    // instead, Jellio's own one start/end pair per theme having no
    // real room for a second disjoint window, a real simplification
    // worth calling out rather than silently picking just one. Storm,
    // Rain, Sports and Snowstorm have no real fixed window in that
    // plugin either, off by default here the same way Birthday/Eid/
    // Resurrection/NightSky/Matrix/Frost already are.
    public bool SeasonalSpaceEnabled { get; set; } = true;
    public int SeasonalSpaceStartMonth { get; set; } = 4;
    public int SeasonalSpaceStartDay { get; set; } = 12;
    public int SeasonalSpaceEndMonth { get; set; } = 4;
    public int SeasonalSpaceEndDay { get; set; } = 12;

    public bool SeasonalUnderwaterEnabled { get; set; } = true;
    public int SeasonalUnderwaterStartMonth { get; set; } = 7;
    public int SeasonalUnderwaterStartDay { get; set; } = 1;
    public int SeasonalUnderwaterEndMonth { get; set; } = 8;
    public int SeasonalUnderwaterEndDay { get; set; } = 31;

    public bool SeasonalSantaEnabled { get; set; } = true;
    public int SeasonalSantaStartMonth { get; set; } = 12;
    public int SeasonalSantaStartDay { get; set; } = 22;
    public int SeasonalSantaEndMonth { get; set; } = 12;
    public int SeasonalSantaEndDay { get; set; } = 27;

    public bool SeasonalMarioDayEnabled { get; set; } = true;
    public int SeasonalMarioDayStartMonth { get; set; } = 3;
    public int SeasonalMarioDayStartDay { get; set; } = 10;
    public int SeasonalMarioDayEndMonth { get; set; } = 3;
    public int SeasonalMarioDayEndDay { get; set; } = 10;

    public bool SeasonalSnowfallEnabled { get; set; } = true;
    public int SeasonalSnowfallStartMonth { get; set; } = 1;
    public int SeasonalSnowfallStartDay { get; set; } = 1;
    public int SeasonalSnowfallEndMonth { get; set; } = 2;
    public int SeasonalSnowfallEndDay { get; set; } = 29;

    public bool SeasonalStormEnabled { get; set; } = false;
    public int SeasonalStormStartMonth { get; set; } = 1;
    public int SeasonalStormStartDay { get; set; } = 1;
    public int SeasonalStormEndMonth { get; set; } = 12;
    public int SeasonalStormEndDay { get; set; } = 31;

    public bool SeasonalRainEnabled { get; set; } = false;
    public int SeasonalRainStartMonth { get; set; } = 1;
    public int SeasonalRainStartDay { get; set; } = 1;
    public int SeasonalRainEndMonth { get; set; } = 12;
    public int SeasonalRainEndDay { get; set; } = 31;

    public bool SeasonalSportsEnabled { get; set; } = false;
    public int SeasonalSportsStartMonth { get; set; } = 1;
    public int SeasonalSportsStartDay { get; set; } = 1;
    public int SeasonalSportsEndMonth { get; set; } = 12;
    public int SeasonalSportsEndDay { get; set; } = 31;

    public bool SeasonalSnowstormEnabled { get; set; } = false;
    public int SeasonalSnowstormStartMonth { get; set; } = 1;
    public int SeasonalSnowstormStartDay { get; set; } = 1;
    public int SeasonalSnowstormEndMonth { get; set; } = 12;
    public int SeasonalSnowstormEndDay { get; set; } = 31;

    // Controllers/CalendarController.cs's own real source: a v4 TMDB
    // "API Read Access Token" (the long JWT looking one TMDB's own
    // dashboard issues under Settings > API, not the short v3 api_key),
    // sent as a real Bearer token, never a query string, so it never
    // ends up sitting in a server access log. Every Gelato imported item
    // this whole feature depends on already carries a real
    // ProviderIds.Tmdb (confirmed live against a real sample of
    // imports, ProviderIds.Imdb never once present even on mainstream
    // titles), so this is the one real external credential this whole
    // feature needs, nothing else.
    public string TmdbAccessToken { get; set; } = string.Empty;
}
