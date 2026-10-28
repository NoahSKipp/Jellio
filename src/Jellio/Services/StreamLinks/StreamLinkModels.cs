using System;
using System.Collections.Generic;

namespace Jellio.Services.StreamLinks;

public sealed class StreamLinkEntry
{
    public string Name { get; set; } = string.Empty;

    public string Url { get; set; } = string.Empty;

    public string? Logo { get; set; }

    public string? Group { get; set; }
}

// A link a user saved: one stream, or a playlist of channels.
public sealed class StreamLink
{
    public string Id { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    public string SourceUrl { get; set; } = string.Empty;

    public string Kind { get; set; } = StreamLinkKinds.Stream;

    public List<StreamLinkEntry> Entries { get; set; } = [];

    public DateTime AddedAt { get; set; }

    public DateTime? RefreshedAt { get; set; }
}

public static class StreamLinkKinds
{
    public const string Stream = "stream";
    public const string Playlist = "playlist";
}

public static class StreamFormats
{
    public const string Hls = "hls";
    public const string Ts = "ts";
    public const string Mp4 = "mp4";
    public const string Other = "other";
}

public sealed record ResolvedStream(string Format, Uri Url, Uri? Referer);

// What a link turned out to be: a playable stream, or a channel list.
public sealed record ResolveResult(ResolvedStream? Stream, List<StreamLinkEntry>? Entries, string? Title);

public sealed class StreamLinkException(string code, string? detail = null) : Exception(detail ?? code)
{
    public string Code { get; } = code;
}

public static class StreamLinkErrors
{
    public const string InvalidUrl = "invalid_url";
    public const string BlockedAddress = "blocked_address";
    public const string Unreachable = "unreachable";
    public const string Timeout = "timeout";
    public const string NoStream = "no_stream_found";
    public const string TooMany = "too_many_links";
    public const string NotFound = "not_found";
}
