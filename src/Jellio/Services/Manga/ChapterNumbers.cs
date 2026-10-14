using System;
using System.Globalization;
using System.Text.RegularExpressions;

namespace Jellio.Services.Manga;

/// <summary>
/// Suwayomi reports -1 when it can't recognise a chapter's number, which
/// sorted those chapters (Berserk's prologue "Chapter 0.01" and the like
/// on some sources) after the last one. The number is then read from the
/// chapter's name: "Chapter 0.01", "Ch.000", "Vol.1 Ch.5", or a name that
/// starts with the number. A name with none ("Prologue") stays unknown.
/// </summary>
public static partial class ChapterNumbers
{
    // "Prologue N" gets a range of its own, 0.0001 per prologue below 0.01,
    // so it never takes the number of "Chapter N" (and isn't merged with it
    // as a duplicate). Up to 99 prologues; a bare "Prologue" is the first.
    public const float PrologueStep = 0.0001f;

    public static float Resolve(float reported, string? name)
    {
        if (name is not null)
        {
            var prologue = Prologue().Match(name);
            if (prologue.Success)
            {
                var n = prologue.Groups["n"].Success && int.TryParse(prologue.Groups["n"].Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed) ? parsed : 1;
                return Math.Clamp(n, 1, 99) * PrologueStep;
            }
        }

        if (reported >= 0)
        {
            return reported;
        }

        if (string.IsNullOrWhiteSpace(name))
        {
            return -1f;
        }

        var match = Labelled().Match(name);
        if (!match.Success)
        {
            match = Leading().Match(name);
        }

        if (!match.Success)
        {
            return -1f;
        }

        var text = match.Groups["n"].Value.Replace(',', '.');
        return float.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var value) && value >= 0 ? value : -1f;
    }

    [GeneratedRegex(@"^\s*(?:(?:vol(?:ume)?\.?\s*\d+\s*[-:]?\s*)?)prologue\b\s*(?:#?(?<n>\d+))?", RegexOptions.IgnoreCase)]
    private static partial Regex Prologue();

    [GeneratedRegex(@"\b(?:ch(?:apter)?|chap|episode|ep)\.?\s*#?\s*(?<n>\d+(?:[.,]\d+)?)", RegexOptions.IgnoreCase)]
    private static partial Regex Labelled();

    [GeneratedRegex(@"^\s*#?(?<n>\d+(?:[.,]\d+)?)(?![\d])")]
    private static partial Regex Leading();
}
