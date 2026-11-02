using System;
using System.Globalization;
using System.Text.RegularExpressions;

namespace Jellio.Services.Manga;

public static partial class ChapterNumbers
{
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
