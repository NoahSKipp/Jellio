using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Logging;

namespace Jellio.Services.Subtitles;

/// <summary>
/// Orchestrates a real item's own automatic subtitle fetch: resolves its
/// own real ProviderIds.Tmdb server side (a movie's own, or an episode's
/// own parent Series, same real field Controllers/CalendarController.cs
/// already reads for the identical real reason, Gelato never populating
/// ProviderIds.Imdb), then asks SubDlClient for whichever of the admin's
/// own configured languages SubtitleCacheStore says this item has not
/// already either found or recently ruled out. Nothing here blocks a
/// real caller on this: Controllers/SubtitlesController.cs's own
/// EnsureAsync route fires this and returns immediately, the same real
/// "kick off, do not wait" shape this whole feature needs to stay
/// invisible to actual playback start time.
/// </summary>
public class SubtitleFetchService(
    ILibraryManager libraryManager,
    SubDlClient client,
    SubtitleCacheStore cacheStore,
    ILogger<SubtitleFetchService> logger
)
{
    public async Task EnsureAsync(Guid itemId, string apiKey, string[] languages)
    {
        if (string.IsNullOrWhiteSpace(apiKey))
        {
            return;
        }

        var item = libraryManager.GetItemById(itemId);
        if (item == null)
        {
            return;
        }

        string? tmdbId = null;
        var isEpisode = item is Episode;
        int? seasonNumber = null;
        int? episodeNumber = null;

        if (item is Episode episode)
        {
            seasonNumber = episode.ParentIndexNumber;
            episodeNumber = episode.IndexNumber;
            if (libraryManager.GetItemById(episode.SeriesId) is Series series && series.ProviderIds.TryGetValue("Tmdb", out var seriesTmdb))
            {
                tmdbId = seriesTmdb;
            }
        }
        else if (item.ProviderIds.TryGetValue("Tmdb", out var itemTmdb))
        {
            tmdbId = itemTmdb;
        }

        if (string.IsNullOrEmpty(tmdbId))
        {
            return;
        }

        foreach (var language in languages)
        {
            var lang = language.Trim().ToLowerInvariant();
            if (lang.Length == 0 || cacheStore.ShouldSkip(itemId, lang))
            {
                continue;
            }

            // Real quota is global (SubtitleCacheStore's own header
            // explains why), checked fresh on every real iteration
            // rather than once up front: a 429 caught on an earlier
            // language in this exact same loop should stop the rest of
            // it too, not just the one call that actually drew it.
            if (cacheStore.IsThrottled())
            {
                return;
            }

            try
            {
                var downloadUrl = await client
                    .SearchAsync(apiKey, lang, tmdbId, isEpisode, seasonNumber, episodeNumber)
                    .ConfigureAwait(false);
                if (downloadUrl == null)
                {
                    cacheStore.SaveNotFound(itemId, lang);
                    continue;
                }

                var srt = await client.DownloadAsync(downloadUrl).ConfigureAwait(false);
                var vtt = SrtToVtt(srt);
                cacheStore.SaveFound(itemId, lang, vtt);
            }
            catch (SubDlQuotaExceededException)
            {
                logger.LogInformation("Jellio: SubDL download limit reached, backing off");
                cacheStore.SetThrottled(null);
                return;
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or InvalidOperationException)
            {
                logger.LogWarning(ex, "Jellio: could not fetch a {Language} subtitle for {ItemId}", lang, itemId);
            }
        }
    }

    // Real, common problem across every free community subtitle site,
    // not something particular to SubDL: an uploader's own "synced by",
    // a bare promo URL, a site's own name, added as its own real cue,
    // almost always standalone rather than mixed into real dialogue
    // (real dialogue is never just a bare URL or just "subtitles by
    // X"). Bazarr's own project explicitly declined to filter this
    // itself, telling users to pay a provider for VIP instead
    // (confirmed against its own real feature request tracker before
    // writing this); KBlixt/subcleaner is the real, actively maintained
    // community tool built for exactly this gap instead, its own real
    // regex_profiles/default/{global,english}.conf (confirmed against
    // that real source before writing this) the actual origin of the
    // patterns below, not invented fresh here. No German profile exists
    // upstream to draw from, but AdLinePatterns's own global patterns
    // (a site's own name, a bare URL, decorative ad symbols) apply
    // regardless of the subtitle's own spoken language, an uploader's
    // own tagline never itself translated.
    private static readonly Regex[] AdLinePatterns =
    [
        new(@"\b(sub(title|s)?|caption(s|ed)?|(re-?)?sync(h|ed|ro(nized)?)?|rip(ped)?|translat(e|ed|ion)|correct(ions?|ed)|transcri(be|bed|pt|ption)|encoded|provided|edited?)\W*(by|from)\b", RegexOptions.IgnoreCase | RegexOptions.Compiled),
        new(@"\b(opensubtitles?|subdl|subscene|addic7ed|podnapisi|tvsubtitles?|yify|yts)\b", RegexOptions.IgnoreCase | RegexOptions.Compiled),
        new(@"(www\.|https?[:\s]|\.(com|org|net|app|tv|to|io|xyz|link)\b)", RegexOptions.IgnoreCase | RegexOptions.Compiled),
        new(@"^\s*present(s|ing)?\s*[:.]?\s*$", RegexOptions.IgnoreCase | RegexOptions.Compiled),
        new(@"[©★]|==|>>|<<|=-|-=|::|\^\^", RegexOptions.Compiled),
    ];

    // Only a cue whose ENTIRE real text matches is dropped, never one
    // line inside a longer real one: this method's own header above
    // explains why that is enough, a real ad cue is its own standalone
    // real block almost every real time.
    private static bool IsAdCue(string text)
    {
        var trimmed = text.Trim();
        return trimmed.Length > 0 && AdLinePatterns.Any(pattern => pattern.IsMatch(trimmed));
    }

    // WebVTT needs a real "WEBVTT" magic header a bare SubRip file
    // never has, and a real period rather than SubRip's own comma
    // inside every timestamp; everything else about the two real
    // formats already matches closely enough that a native <video>
    // track element parses the result cleanly, confirmed live against
    // a real sample file before writing this rather than assumed.
    // SubDL's own real download, unpacked or extracted from its own
    // zip either way (SubDlClient.cs's own header explains which), is
    // always a bare SubRip file, so this conversion is not an edge
    // case, it is the one real path every fetch here actually takes.
    // Real cue numbers are dropped outright rather than renumbered
    // around whatever IsAdCue below removes: WebVTT's own real cue
    // identifier is optional, a real timestamp line plus real text is
    // already a complete real cue on its own, nothing left to keep in
    // step.
    private static string SrtToVtt(string srt)
    {
        var withoutBom = srt.TrimStart('\uFEFF');
        var normalized = withoutBom.Replace("\r\n", "\n").Trim();
        var blocks = normalized.Split("\n\n", StringSplitOptions.RemoveEmptyEntries);

        var cues = new List<string>();
        foreach (var block in blocks)
        {
            var lines = block.Split('\n');
            var timestampIndex = Array.FindIndex(lines, line => line.Contains("-->"));
            if (timestampIndex == -1)
            {
                continue;
            }

            var text = string.Join('\n', lines.Skip(timestampIndex + 1)).Trim();
            if (text.Length == 0 || IsAdCue(text))
            {
                continue;
            }

            var timestamp = Regex.Replace(lines[timestampIndex], @"(\d{2}:\d{2}:\d{2}),(\d{3})", "$1.$2");
            cues.Add(timestamp + "\n" + text);
        }

        return "WEBVTT\n\n" + string.Join("\n\n", cues) + "\n";
    }
}
