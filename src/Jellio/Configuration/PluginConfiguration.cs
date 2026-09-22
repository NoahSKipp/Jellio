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

    // Services/CommunitySkip's own real Skip Intro/Credits tier, the
    // same real approach a real open source reference (NuvioTV's own
    // SkipIntroRepository.kt, read before writing any of this) already
    // ships: a community timestamp database keyed by a title's own real
    // external ids, not this plugin's own audio analysis. Tried first,
    // no key required at all: TheIntroDB's own real public GET /media
    // (api.theintrodb.org, its own official Jellyfin plugin's own real
    // TheIntroDbClient.cs read directly before writing this) already
    // works anonymously off ProviderIds.Tmdb alone, general TV/movie
    // coverage, not anime only. An optional Bearer key from
    // theintrodb.org just weights a reader's own pending/accepted
    // submissions higher and likely raises the real shared rate limit,
    // never required for this tier to answer at all.
    public string TheIntroDbApiKey { get; set; } = string.Empty;

    // SkipMe.db, tried right alongside TheIntroDB above (Services/
    // CommunitySkip/SkipMeDbClient.cs, ported from the official
    // intro-skipper org's own real skipme.db-plugin, GPL-3.0, its own
    // Services/SkipMeApiClient.cs read directly before writing this):
    // another genuinely public, free, general TV/movie database, also
    // keyed directly off ProviderIds.Tmdb, no key of any kind needed.
    // Independently crowdsourced from TheIntroDB, so a title one of them
    // has nothing for is still worth asking the other - real coverage
    // gain confirmed live against a real sparse show (TheIntroDB alone
    // only covered 12 of 128 real episodes). Their own real NOTICE file
    // explicitly permits local caching of this data for the one real
    // purpose this plugin already uses it for, unlike SkipDB's own real
    // reciprocity clause (checked before adding this, not assumed) -
    // SkipDB itself was left out entirely: its own public data dump
    // turned out to be a stalled ~3 month old snapshot covering only 51
    // real titles, with zero coverage for either real show this was
    // tested against.
    // No config field needed here: SkipMe.db's own real API takes no key
    // of any kind, reads or writes.

    // IntroDB (Services/CommunitySkip/IntroDbClient.cs, api.introdb.app,
    // ported from a real third party open source client's own
    // IntroDBClient.swift/Models.swift read directly before writing
    // this - api.introdb.app itself unreachable from this environment to
    // read their own real docs page directly): a third independently
    // crowdsourced TV show database, unlike TheIntroDB/SkipMe.db above
    // keyed by IMDb id rather than TMDB id, so this tier only ever runs
    // once Services/CommunitySkip/TmdbExternalIdResolver.cs has resolved
    // one (needs TmdbAccessToken above configured, one real extra round
    // trip per series, cached after that). An optional API key here
    // mirrors TheIntroDbApiKey's own real graceful-blank behaviour;
    // never required for this tier to answer at all.
    public string IntroDbApiKey { get; set; } = string.Empty;

    // AniSkip/Anime-Skip below cover what TheIntroDB itself does not:
    // anime specifically, submitted against MyAnimeList/AniList rather
    // than TMDB. A free client_id from simkl.com's own developer
    // settings, used only to map a Gelato import's own real
    // ProviderIds.Tmdb onto the MyAnimeList/AniList id AniSkip/Anime-Skip
    // below actually key off. Left blank, that whole tier is skipped,
    // same real graceful-miss behaviour TmdbAccessToken above already
    // has.
    public string SimklClientId { get; set; } = string.Empty;

    // A free client_id from anime-skip.com's own developer settings
    // (a real separate real signup from Simkl's own, confirmed against
    // NuvioTV's own real AnimeSkipApi.kt before writing this): the one
    // other real community database NuvioTV also queries, real fallback
    // coverage for whatever AniSkip itself does not have. Left blank,
    // this one tier alone is skipped, AniSkip and this plugin's own real
    // fallbacks still apply.
    public string AnimeSkipClientId { get; set; } = string.Empty;

    // components/cardOptionsMenu.js's own real admin-only "Find Skip
    // Intro/Credits" right-click action (Controllers/IntroCreditsController.cs's
    // own POST .../scan/{itemId}, IntroCreditsBulkScanner's own real
    // trigger). Real feedback: an admin does not always want that extra
    // entry sitting on every single Movie/Series card's own right click
    // menu - off by default, only shows up once explicitly switched on
    // here, and can be switched back off again once a real sweep is done.
    public bool SkipIntroCreditsAdminMenuEnabled { get; set; }
}
