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

    // From the page the link points at, when it says.
    public string? Description { get; set; }

    public string? ImageUrl { get; set; }

    public string? SiteName { get; set; }

    // Best rendition the stream offers, e.g. "1080p".
    public string? Quality { get; set; }

    // Kept up by StreamLinkHealthService: "ok" or "failing".
    public string? Health { get; set; }

    public DateTime? LastCheckedAt { get; set; }

    public int FailedChecks { get; set; }

    public string? LastError { get; set; }

    // Channels the user removed from a playlist; a refresh leaves them out.
    public List<string> HiddenEntries { get; set; } = [];
}

public static class StreamLinkHealth
{
    public const string Ok = "ok";
    public const string Failing = "failing";
}

public sealed record StreamLinkMetadata(string? Title, string? Description, string? ImageUrl, string? SiteName)
{
    public static readonly StreamLinkMetadata Empty = new(null, null, null, null);

    // Values already here win; the other fills the gaps.
    public StreamLinkMetadata Or(StreamLinkMetadata? other) => other == null
        ? this
        : new(Title ?? other.Title, Description ?? other.Description, ImageUrl ?? other.ImageUrl, SiteName ?? other.SiteName);
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
public sealed record ResolveResult(ResolvedStream? Stream, List<StreamLinkEntry>? Entries, string? Title)
{
    public StreamLinkMetadata Metadata { get; init; } = StreamLinkMetadata.Empty;

    public string? Quality { get; init; }
}

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
