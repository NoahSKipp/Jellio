using MediaBrowser.Model.Plugins;

namespace Jellio.Configuration;

public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>Master switch. Disabling this restores the stock web client on next start.</summary>
    public bool EnableReskin { get; set; } = true;

    // Server wide, admin controlled, applies to every user: this whole
    // block is Jellio's own server side config for
    // Frontend/components/seasons.js's own reskin, the same real thing
    // per user customization would need to layer on top of later, not
    // something to invent a second config surface for now. Flat
    // properties throughout, the same convention every other real
    // Jellyfin plugin config already confirmed against in this codebase
    // uses rather than a nested class, since BasePluginConfiguration's
    // own real XmlSerializer has no real reason here to need one.
    //
    // Four real occasions, not the three dozen the first pass of this
    // ported wholesale from CodeDevMLH/Jellyfin-Seasonals: real feedback
    // was that flooding the page with particles read as spam rather than
    // a themed page, so this replaces that whole catalogue rather than
    // adding to it. Easter dropped again almost immediately: unlike the
    // other four it has no fixed calendar date, a real yearly maintenance
    // burden nobody asked for. Each one still keeps its own Start/End
    // Month/Day pair, the one real mechanism admins already had for
    // letting a theme span more than a single day (Halloween week, not
    // just October 31st), carried forward unchanged.
    public bool SeasonalEffectsEnabled { get; set; } = true;

    public bool SeasonalHalloweenEnabled { get; set; } = true;
    public int SeasonalHalloweenStartMonth { get; set; } = 10;
    public int SeasonalHalloweenStartDay { get; set; } = 24;
    public int SeasonalHalloweenEndMonth { get; set; } = 11;
    public int SeasonalHalloweenEndDay { get; set; } = 2;

    // Wraps New Year's Eve into January, the one theme here that
    // actually needs the wrap-around range comparison Frontend/
    // components/seasons.js's own inRange() carries for exactly this.
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
