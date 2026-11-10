using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Jellyfin.Database.Implementations.Enums;

namespace Jellio.Services.Segments;

public record NormalizedSegment(string Type, int StartMs, int EndMs);

public record NormalizedSegments(IReadOnlyList<NormalizedSegment> Segments, string Source);

// One shape for skip segments from Jellyfin's Media Segments and from the
// Intro Skipper plugin's Timestamps, picked the way both clients pick them
// (runtime/api.js getIntroSkipperSegments, TV getIntroSkipperSegments):
// Media Segments win when they have an Intro or an Outro, Intro Skipper
// is asked only when they have neither. Like the clients, only the first
// Intro and the first Outro count.
public static class SkipSegmentNormalizer
{
    public const string MediaSegmentsSource = "media-segments";
    public const string IntroSkipperSource = "intro-skipper";
    public const string NoSource = "none";

    private const long TicksPerMs = 10_000;

    private static readonly (string Key, string Type)[] IntroSkipperKeys =
    [
        ("Introduction", "Intro"),
        ("Credits", "Outro"),
        ("Recap", "Recap"),
        ("Preview", "Preview"),
        ("Commercial", "Commercial"),
    ];

    public static string? TypeName(MediaSegmentType type) => type switch
    {
        MediaSegmentType.Intro => "Intro",
        MediaSegmentType.Outro => "Outro",
        MediaSegmentType.Recap => "Recap",
        MediaSegmentType.Preview => "Preview",
        MediaSegmentType.Commercial => "Commercial",
        _ => null,
    };

    public static bool HasIntroOrOutro(IEnumerable<(MediaSegmentType Type, long StartTicks, long EndTicks)> native) =>
        native.Any(s => s.Type is MediaSegmentType.Intro or MediaSegmentType.Outro);

    public static IReadOnlyList<NormalizedSegment> FromMediaSegments(IEnumerable<(MediaSegmentType Type, long StartTicks, long EndTicks)> native) =>
        Normalize(native.Select(s => (TypeName(s.Type), TicksToMs(s.StartTicks), TicksToMs(s.EndTicks))));

    // Timestamps answer: { "Introduction": { "Start": s, "End": s, ... }, "Credits": ... } in seconds.
    public static IReadOnlyList<NormalizedSegment> FromIntroSkipper(JsonElement timestamps)
    {
        if (timestamps.ValueKind != JsonValueKind.Object)
        {
            return [];
        }

        var raw = new List<(string?, long, long)>();
        foreach (var (key, type) in IntroSkipperKeys)
        {
            if (TryGetProperty(timestamps, key, out var segment) && segment.ValueKind == JsonValueKind.Object
                && TryGetSeconds(segment, "Start", out var start) && TryGetSeconds(segment, "End", out var end))
            {
                raw.Add((type, SecondsToMs(start), SecondsToMs(end)));
            }
        }

        return Normalize(raw);
    }

    // fromIntroSkipper is only looked at when native has no Intro or Outro.
    public static NormalizedSegments Choose(
        IReadOnlyList<(MediaSegmentType Type, long StartTicks, long EndTicks)> native,
        IReadOnlyList<NormalizedSegment> fromIntroSkipper)
    {
        var fromNative = FromMediaSegments(native);
        if (HasIntroOrOutro(native))
        {
            return new NormalizedSegments(fromNative, MediaSegmentsSource);
        }

        if (fromIntroSkipper.Count > 0)
        {
            return new NormalizedSegments(fromIntroSkipper, IntroSkipperSource);
        }

        return fromNative.Count > 0
            ? new NormalizedSegments(fromNative, MediaSegmentsSource)
            : new NormalizedSegments([], NoSource);
    }

    // First Intro and first Outro only (dropped when unusable, as the
    // clients' merge drops them); every usable segment of the other types.
    // Sorted by start.
    private static IReadOnlyList<NormalizedSegment> Normalize(IEnumerable<(string? Type, long StartMs, long EndMs)> raw)
    {
        var seen = new HashSet<string>();
        var result = new List<NormalizedSegment>();
        foreach (var (type, startMs, endMs) in raw)
        {
            if (type is null)
            {
                continue;
            }

            if (type is "Intro" or "Outro" && !seen.Add(type))
            {
                continue;
            }

            if (endMs <= 0 || endMs <= startMs || startMs < 0)
            {
                continue;
            }

            result.Add(new NormalizedSegment(type, ClampToInt(startMs), ClampToInt(endMs)));
        }

        return result.OrderBy(s => s.StartMs).ToList();
    }

    private static long TicksToMs(long ticks) => ticks / TicksPerMs;

    private static long SecondsToMs(double seconds) =>
        double.IsFinite(seconds) ? (long)Math.Round(seconds * 1000, MidpointRounding.AwayFromZero) : -1;

    private static int ClampToInt(long value) => (int)Math.Clamp(value, 0, int.MaxValue);

    private static bool TryGetProperty(JsonElement element, string name, out JsonElement value)
    {
        foreach (var property in element.EnumerateObject())
        {
            if (string.Equals(property.Name, name, StringComparison.OrdinalIgnoreCase))
            {
                value = property.Value;
                return true;
            }
        }

        value = default;
        return false;
    }

    private static bool TryGetSeconds(JsonElement segment, string name, out double seconds)
    {
        seconds = 0;
        return TryGetProperty(segment, name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out seconds);
    }
}
