using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace Jellio.Services.StreamLinks;

// Pure text work on what a link returned: playlists, channel lists and
// web pages that embed a player.
public static partial class StreamLinkParser
{
    public const int MaxEntries = 2000;
    public const int MaxCandidates = 10;

    public static bool IsHlsPlaylist(string text)
    {
        var trimmed = text.TrimStart('﻿', ' ', '\t', '\r', '\n');
        return trimmed.StartsWith("#EXTM3U", StringComparison.Ordinal)
            && (trimmed.Contains("#EXT-X-TARGETDURATION", StringComparison.Ordinal)
                || trimmed.Contains("#EXT-X-STREAM-INF", StringComparison.Ordinal)
                || trimmed.Contains("#EXT-X-MEDIA-SEQUENCE", StringComparison.Ordinal));
    }

    public static bool IsChannelList(string text)
    {
        var trimmed = text.TrimStart('﻿', ' ', '\t', '\r', '\n');
        return !IsHlsPlaylist(text)
            && (trimmed.StartsWith("#EXTM3U", StringComparison.Ordinal) || trimmed.StartsWith("#EXTINF", StringComparison.Ordinal));
    }

    // TS packets start with 0x47 every 188 bytes; MP4 opens with an ftyp box.
    public static string? SniffMedia(ReadOnlySpan<byte> head)
    {
        if (head.Length >= 1 && head[0] == 0x47 && (head.Length < 189 || head[188] == 0x47))
        {
            return StreamFormats.Ts;
        }

        if (head.Length >= 8 && head[4] == (byte)'f' && head[5] == (byte)'t' && head[6] == (byte)'y' && head[7] == (byte)'p')
        {
            return StreamFormats.Mp4;
        }

        return null;
    }

    public static string FormatFromPath(Uri uri)
    {
        var path = uri.AbsolutePath;
        if (path.EndsWith(".m3u8", StringComparison.OrdinalIgnoreCase) || path.EndsWith(".m3u", StringComparison.OrdinalIgnoreCase))
        {
            return StreamFormats.Hls;
        }

        if (path.EndsWith(".ts", StringComparison.OrdinalIgnoreCase) || path.EndsWith(".mpegts", StringComparison.OrdinalIgnoreCase))
        {
            return StreamFormats.Ts;
        }

        if (path.EndsWith(".mp4", StringComparison.OrdinalIgnoreCase) || path.EndsWith(".m4v", StringComparison.OrdinalIgnoreCase))
        {
            return StreamFormats.Mp4;
        }

        return StreamFormats.Other;
    }

    public static List<StreamLinkEntry> ParseChannelList(string text, Uri baseUri)
    {
        var entries = new List<StreamLinkEntry>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        string? pendingInfo = null;
        foreach (var raw in text.Split('\n'))
        {
            var line = raw.Trim();
            if (line.Length == 0)
            {
                continue;
            }

            if (line.StartsWith("#EXTINF", StringComparison.OrdinalIgnoreCase))
            {
                pendingInfo = line;
                continue;
            }

            if (line.StartsWith('#'))
            {
                continue;
            }

            if (!TryResolve(baseUri, line, out var url) || !seen.Add(url.AbsoluteUri))
            {
                pendingInfo = null;
                continue;
            }

            var entry = new StreamLinkEntry { Url = url.AbsoluteUri };
            if (pendingInfo != null)
            {
                var comma = NameComma(pendingInfo);
                entry.Name = comma >= 0 ? pendingInfo[(comma + 1)..].Trim() : string.Empty;
                entry.Logo = Attribute(pendingInfo, "tvg-logo");
                entry.Group = Attribute(pendingInfo, "group-title");
                if (string.IsNullOrEmpty(entry.Name))
                {
                    entry.Name = Attribute(pendingInfo, "tvg-name") ?? string.Empty;
                }
            }

            if (string.IsNullOrEmpty(entry.Name))
            {
                entry.Name = NameFromUrl(url);
            }

            if (entry.Logo != null)
            {
                entry.Logo = TryResolve(baseUri, entry.Logo, out var logo) ? logo.AbsoluteUri : null;
            }

            entries.Add(entry);
            pendingInfo = null;
            if (entries.Count >= MaxEntries)
            {
                break;
            }
        }

        return entries;
    }

    // What a page says about itself: Open Graph first, then plain tags.
    public static StreamLinkMetadata PageMetadata(string html, Uri pageUri)
    {
        string? Meta(params string[] names)
        {
            foreach (var name in names)
            {
                foreach (Match tag in MetaTagRegex().Matches(html))
                {
                    var attributes = tag.Value;
                    var key = MetaKeyRegex().Match(attributes);
                    if (!key.Success || !key.Groups[2].Value.Equals(name, StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }

                    var content = MetaContentRegex().Match(attributes);
                    if (content.Success)
                    {
                        var value = Clean(content.Groups[2].Value, 300);
                        if (value != null)
                        {
                            return value;
                        }
                    }
                }
            }

            return null;
        }

        string? image = null;
        foreach (var candidate in new[] { Meta("og:image", "og:image:url", "og:image:secure_url", "twitter:image"), IconHref(html) })
        {
            if (candidate != null && TryResolve(pageUri, candidate, out var imageUri) && imageUri.Scheme == Uri.UriSchemeHttps)
            {
                image = imageUri.AbsoluteUri;
                break;
            }
        }

        return new StreamLinkMetadata(
            Meta("og:title", "twitter:title") ?? PageTitle(html),
            Meta("og:description", "description", "twitter:description"),
            image,
            Meta("og:site_name", "application-name"));
    }

    // Highest RESOLUTION a master playlist offers, as "1080p".
    public static string? HlsQuality(string playlist)
    {
        var best = 0;
        foreach (Match m in ResolutionRegex().Matches(playlist))
        {
            if (int.TryParse(m.Groups[1].Value, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var height) && height > best)
            {
                best = height;
            }
        }

        return best switch
        {
            >= 2000 => "4K",
            > 0 => best + "p",
            _ => null,
        };
    }

    private static string? IconHref(string html)
    {
        string? fallback = null;
        foreach (Match link in LinkTagRegex().Matches(html))
        {
            var rel = LinkRelRegex().Match(link.Value);
            var href = LinkHrefRegex().Match(link.Value);
            if (!rel.Success || !href.Success)
            {
                continue;
            }

            var relValue = rel.Groups[2].Value.ToLowerInvariant();
            if (relValue.Contains("apple-touch-icon", StringComparison.Ordinal))
            {
                return href.Groups[2].Value;
            }

            if (relValue.Split(' ').Contains("icon"))
            {
                fallback ??= href.Groups[2].Value;
            }
        }

        return fallback;
    }

    private static string? Clean(string value, int max)
    {
        var text = WebUtility.HtmlDecode(value).Trim();
        text = Regex.Replace(text, @"\s+", " ");
        return text.Length == 0 ? null : text.Length > max ? text[..max].TrimEnd() + "…" : text;
    }

    public static string? PageTitle(string html)
    {
        var og = OgTitleRegex().Match(html);
        var value = og.Success ? og.Groups[1].Value : TitleRegex().Match(html) is { Success: true } t ? t.Groups[1].Value : null;
        if (value == null)
        {
            return null;
        }

        value = WebUtility.HtmlDecode(value).Trim();
        return value.Length == 0 ? null : value.Length > 120 ? value[..120] : value;
    }

    // Stream addresses a page mentions, most likely first: playlists, then
    // video sources, then embedded players to look inside.
    public static List<Uri> FindCandidates(string html, Uri pageUri)
    {
        var text = html.Replace("\\/", "/", StringComparison.Ordinal)
            .Replace("\\u002F", "/", StringComparison.OrdinalIgnoreCase)
            .Replace("\\u0026", "&", StringComparison.OrdinalIgnoreCase);
        var found = new List<Uri>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        void Add(string value)
        {
            if (found.Count >= MaxCandidates)
            {
                return;
            }

            var decoded = WebUtility.HtmlDecode(value).Trim();
            if (TryResolve(pageUri, decoded, out var uri) && uri.AbsoluteUri != pageUri.AbsoluteUri && seen.Add(uri.AbsoluteUri))
            {
                found.Add(uri);
            }
        }

        foreach (Match m in AbsolutePlaylistRegex().Matches(text))
        {
            Add(m.Value);
        }

        foreach (Match m in RelativePlaylistRegex().Matches(text))
        {
            Add(m.Groups[1].Value);
        }

        foreach (Match m in MediaSourceRegex().Matches(text))
        {
            Add(m.Groups[1].Value);
        }

        foreach (Match m in IframeRegex().Matches(text))
        {
            Add(m.Groups[1].Value);
        }

        // Pages that offer several players as buttons keep each player's
        // page in a data attribute; those are the last ones worth trying.
        foreach (Match m in DataPlayerRegex().Matches(text))
        {
            Add(m.Groups[1].Value);
        }

        return found;
    }

    // Points every address in an HLS playlist through proxify, so the
    // player fetches segments the same way it fetched the playlist.
    public static string RewritePlaylist(string playlist, Uri playlistUri, Func<Uri, string> proxify)
    {
        var output = new StringBuilder(playlist.Length + 256);
        foreach (var raw in playlist.Split('\n'))
        {
            var line = raw.TrimEnd('\r');
            var trimmed = line.Trim();
            if (trimmed.Length == 0)
            {
                output.Append('\n');
                continue;
            }

            if (trimmed.StartsWith('#'))
            {
                output.Append(UriAttributeRegex().Replace(line, m =>
                    TryResolve(playlistUri, m.Groups[1].Value, out var inner) ? "URI=\"" + proxify(inner) + "\"" : m.Value));
            }
            else
            {
                output.Append(TryResolve(playlistUri, trimmed, out var uri) ? proxify(uri) : line);
            }

            output.Append('\n');
        }

        return output.ToString();
    }

    public static bool TryResolve(Uri baseUri, string value, out Uri uri)
    {
        uri = null!;
        if (string.IsNullOrWhiteSpace(value) || value.StartsWith("data:", StringComparison.OrdinalIgnoreCase) || value.StartsWith("blob:", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        if (!Uri.TryCreate(baseUri, value.Trim(), out var resolved))
        {
            return false;
        }

        if (resolved.Scheme != Uri.UriSchemeHttp && resolved.Scheme != Uri.UriSchemeHttps)
        {
            return false;
        }

        uri = resolved;
        return true;
    }

    private static string NameFromUrl(Uri url)
    {
        var segment = url.Segments.LastOrDefault()?.Trim('/') ?? string.Empty;
        var name = Uri.UnescapeDataString(segment);
        var dot = name.LastIndexOf('.');
        if (dot > 0)
        {
            name = name[..dot];
        }

        return string.IsNullOrWhiteSpace(name) ? url.Host : name;
    }

    private static string? Attribute(string info, string name)
    {
        var match = Regex.Match(info, Regex.Escape(name) + "=\"([^\"]*)\"", RegexOptions.IgnoreCase);
        return match.Success && match.Groups[1].Value.Trim().Length > 0 ? match.Groups[1].Value.Trim() : null;
    }

    private static int NameComma(string info)
    {
        var inQuotes = false;
        var found = -1;
        for (var i = 0; i < info.Length; i++)
        {
            if (info[i] == '"')
            {
                inQuotes = !inQuotes;
            }
            else if (info[i] == ',' && !inQuotes)
            {
                // The name follows the first comma after the attributes.
                found = i;
                break;
            }
        }

        return found;
    }

    [GeneratedRegex(@"https?://[^\s""'<>`\\]+?\.m3u8?(?![\w])(?:\?[^\s""'<>`\\]*)?", RegexOptions.IgnoreCase)]
    private static partial Regex AbsolutePlaylistRegex();

    [GeneratedRegex(@"(?:src|href|file|source|url|hls|stream)[""']?\s*[:=]\s*[""']([^""'\s]+?\.m3u8?(?:\?[^""'\s]*)?)[""']", RegexOptions.IgnoreCase)]
    private static partial Regex RelativePlaylistRegex();

    [GeneratedRegex(@"<(?:source|video)\b[^>]*?\bsrc\s*=\s*[""']([^""']+)[""']", RegexOptions.IgnoreCase)]
    private static partial Regex MediaSourceRegex();

    [GeneratedRegex(@"<iframe\b[^>]*?\bsrc\s*=\s*[""']([^""']+)[""']", RegexOptions.IgnoreCase)]
    private static partial Regex IframeRegex();

    [GeneratedRegex(@"\bdata-(?:url|src|embed|player)\s*=\s*[""']([^""']+)[""']", RegexOptions.IgnoreCase)]
    private static partial Regex DataPlayerRegex();

    [GeneratedRegex(@"URI=""([^""]+)""")]
    private static partial Regex UriAttributeRegex();

    [GeneratedRegex(@"<meta[^>]+property\s*=\s*[""']og:title[""'][^>]*content\s*=\s*[""']([^""']+)[""']", RegexOptions.IgnoreCase)]
    private static partial Regex OgTitleRegex();

    [GeneratedRegex(@"<title[^>]*>([^<]+)</title>", RegexOptions.IgnoreCase)]
    private static partial Regex TitleRegex();

    [GeneratedRegex(@"<meta\b[^>]*>", RegexOptions.IgnoreCase)]
    private static partial Regex MetaTagRegex();

    [GeneratedRegex(@"\b(property|name)\s*=\s*[""']([^""']+)[""']", RegexOptions.IgnoreCase)]
    private static partial Regex MetaKeyRegex();

    [GeneratedRegex(@"\b(content)\s*=\s*[""']([^""']*)[""']", RegexOptions.IgnoreCase)]
    private static partial Regex MetaContentRegex();

    [GeneratedRegex(@"<link\b[^>]*>", RegexOptions.IgnoreCase)]
    private static partial Regex LinkTagRegex();

    [GeneratedRegex(@"\b(rel)\s*=\s*[""']([^""']+)[""']", RegexOptions.IgnoreCase)]
    private static partial Regex LinkRelRegex();

    [GeneratedRegex(@"\b(href)\s*=\s*[""']([^""']+)[""']", RegexOptions.IgnoreCase)]
    private static partial Regex LinkHrefRegex();

    [GeneratedRegex(@"RESOLUTION=\d+x(\d+)", RegexOptions.IgnoreCase)]
    private static partial Regex ResolutionRegex();
}
