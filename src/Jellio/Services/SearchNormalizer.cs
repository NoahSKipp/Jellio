using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;

namespace Jellio.Services;

public static class SearchNormalizer
{
    private static readonly HashSet<string> LeadingArticles = new(StringComparer.Ordinal)
    {
        "the",
        "a",
        "an",
    };

    private static readonly Dictionary<string, string[]> CuratedAliases = new(StringComparer.Ordinal)
    {
        ["lotr"] = ["the lord of the rings", "lord of the rings"],
        ["tlotr"] = ["the lord of the rings", "lord of the rings"],
        ["got"] = ["game of thrones"],
        ["hotd"] = ["house of the dragon"],
        ["aot"] = ["attack on titan", "shingeki no kyojin"],
        ["snk"] = ["shingeki no kyojin", "attack on titan"],
        ["jjk"] = ["jujutsu kaisen"],
        ["mha"] = ["my hero academia", "boku no hero academia"],
        ["bnha"] = ["boku no hero academia", "my hero academia"],
        ["fmab"] = ["fullmetal alchemist brotherhood"],
        ["fma"] = ["fullmetal alchemist"],
        ["b99"] = ["brooklyn nine nine"],
        ["himym"] = ["how i met your mother"],
        ["tbbt"] = ["the big bang theory", "big bang theory"],
        ["iasip"] = ["its always sunny in philadelphia"],
        ["sw"] = ["star wars"],
        ["hp"] = ["harry potter"],
        ["mcu"] = ["marvel"],
        ["atla"] = ["avatar the last airbender"],
        ["lok"] = ["the legend of korra", "legend of korra"],
        ["sao"] = ["sword art online"],
        ["opm"] = ["one punch man"],
        ["hxh"] = ["hunter x hunter"],
        ["dbz"] = ["dragon ball z"],
        ["dbs"] = ["dragon ball super"],
        ["kny"] = ["kimetsu no yaiba", "demon slayer"],
        ["csm"] = ["chainsaw man"],
        ["bcs"] = ["better call saul"],
        ["bb"] = ["breaking bad"],
        ["twd"] = ["the walking dead"],
        ["potc"] = ["pirates of the caribbean"],
        ["rotk"] = ["the lord of the rings the return of the king", "return of the king"],
        ["fotr"] = ["the lord of the rings the fellowship of the ring", "fellowship of the ring"],
        ["ttt"] = ["the lord of the rings the two towers", "the two towers"],
        ["esb"] = ["the empire strikes back", "empire strikes back"],
        ["rotj"] = ["return of the jedi"],
        ["anh"] = ["star wars", "a new hope"],
        ["rots"] = ["revenge of the sith"],
        ["tpm"] = ["the phantom menace"],
        ["aotc"] = ["attack of the clones"],
    };

    private static readonly (string Joined, string Spaced)[] CompoundPairs =
    [
        ("spiderman", "spider man"),
        ("starwars", "star wars"),
        ("xmen", "x men"),
        ("batman", "bat man"),
        ("ironman", "iron man"),
        ("chainsawman", "chainsaw man"),
        ("onepunchman", "one punch man"),
    ];

    private static readonly (string Digit, string Word, string? Roman)[] NumberEquivalents =
    [
        ("1", "one", "i"),
        ("2", "two", "ii"),
        ("3", "three", "iii"),
        ("4", "four", "iv"),
        ("5", "five", "v"),
        ("6", "six", "vi"),
        ("7", "seven", "vii"),
        ("8", "eight", "viii"),
        ("9", "nine", "ix"),
        ("10", "ten", "x"),
        ("11", "eleven", "xi"),
        ("12", "twelve", "xii"),
        ("13", "thirteen", "xiii"),
        ("99", "nine nine", null),
        ("99", "ninety nine", null),
    ];

    public static string Normalize(string? input)
    {
        if (string.IsNullOrWhiteSpace(input))
        {
            return string.Empty;
        }

        var decomposed = input.Normalize(NormalizationForm.FormD);
        var sb = new StringBuilder(decomposed.Length + 8);
        var lastWasSpace = true;

        for (var i = 0; i < decomposed.Length; i++)
        {
            var ch = decomposed[i];
            var category = CharUnicodeInfo.GetUnicodeCategory(ch);
            if (category == UnicodeCategory.NonSpacingMark)
            {
                continue;
            }

            // Strip apostrophes and single quotes without inserting spaces
            if (ch is '\'' or '\u2018' or '\u2019' or '`' or '\u02BC')
            {
                continue;
            }

            if (ch == '&')
            {
                if (!lastWasSpace)
                {
                    sb.Append(' ');
                }

                sb.Append("and ");
                lastWasSpace = true;
                continue;
            }

            var lower = char.ToLowerInvariant(ch);
            switch (lower)
            {
                case '\u00E6': // ae
                    sb.Append("ae");
                    lastWasSpace = false;
                    continue;
                case '\u0153': // oe
                    sb.Append("oe");
                    lastWasSpace = false;
                    continue;
                case '\u00DF': // ss
                    sb.Append("ss");
                    lastWasSpace = false;
                    continue;
                case '\u00F8': // o
                    sb.Append('o');
                    lastWasSpace = false;
                    continue;
                case '\u0142': // l
                    sb.Append('l');
                    lastWasSpace = false;
                    continue;
                case '\u0111' or '\u00F0': // d
                    sb.Append('d');
                    lastWasSpace = false;
                    continue;
            }

            if (char.IsLetterOrDigit(lower))
            {
                sb.Append(lower);
                lastWasSpace = false;
            }
            else if (!lastWasSpace)
            {
                sb.Append(' ');
                lastWasSpace = true;
            }
        }

        if (sb.Length > 0 && sb[^1] == ' ')
        {
            sb.Length--;
        }

        return sb.ToString();
    }

    public static string CollapseCompound(string? normalized)
    {
        if (string.IsNullOrEmpty(normalized))
        {
            return string.Empty;
        }

        var sb = new StringBuilder(normalized.Length);
        foreach (var ch in normalized)
        {
            if (ch != ' ')
            {
                sb.Append(ch);
            }
        }

        return sb.ToString();
    }

    public static string ComputeInitialism(string? normalized, bool stripLeadingArticle = false)
    {
        if (string.IsNullOrWhiteSpace(normalized))
        {
            return string.Empty;
        }

        var tokens = normalized.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var startIndex = 0;
        if (stripLeadingArticle && tokens.Length > 1 && LeadingArticles.Contains(tokens[0]))
        {
            startIndex = 1;
        }

        if (tokens.Length - startIndex < 2)
        {
            return string.Empty;
        }

        var sb = new StringBuilder(tokens.Length - startIndex);
        for (var i = startIndex; i < tokens.Length; i++)
        {
            sb.Append(tokens[i][0]);
        }

        return sb.ToString();
    }

    public static (string Full, string Short) ComputeInitialisms(string? normalized)
    {
        var full = ComputeInitialism(normalized, stripLeadingArticle: false);
        var shortInit = ComputeInitialism(normalized, stripLeadingArticle: true);
        return (full, shortInit);
    }

    public static IReadOnlyList<string> ExpandQueryVariants(string? query)
    {
        var norm = Normalize(query);
        if (string.IsNullOrEmpty(norm))
        {
            return Array.Empty<string>();
        }

        var variants = new List<string> { norm };
        var seen = new HashSet<string>(StringComparer.Ordinal) { norm };

        void AddVariant(string candidate)
        {
            if (!string.IsNullOrWhiteSpace(candidate) && seen.Add(candidate))
            {
                variants.Add(candidate);
            }
        }

        if (CuratedAliases.TryGetValue(norm, out var aliases))
        {
            foreach (var alias in aliases)
            {
                AddVariant(alias);
            }
        }

        // Token-level alias and number expansion
        var tokens = norm.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (tokens.Length == 1 && CuratedAliases.TryGetValue(tokens[0], out var singleAliases))
        {
            foreach (var alias in singleAliases)
            {
                AddVariant(alias);
            }
        }

        // Expand compound word variants (spiderman <-> spider man)
        foreach (var (joined, spaced) in CompoundPairs)
        {
            if (ContainsWholePhrase(norm, joined))
            {
                AddVariant(ReplaceWholePhrase(norm, joined, spaced));
            }

            if (ContainsWholePhrase(norm, spaced))
            {
                AddVariant(ReplaceWholePhrase(norm, spaced, joined));
            }
        }

        // Expand inline number / word / roman numeral equivalents
        foreach (var (digit, word, roman) in NumberEquivalents)
        {
            if (ContainsWholePhrase(norm, digit))
            {
                AddVariant(ReplaceWholePhrase(norm, digit, word));
                if (roman != null && tokens.Length > 1)
                {
                    AddVariant(ReplaceWholePhrase(norm, digit, roman));
                }
            }

            if (ContainsWholePhrase(norm, word))
            {
                AddVariant(ReplaceWholePhrase(norm, word, digit));
                if (roman != null && tokens.Length > 1)
                {
                    AddVariant(ReplaceWholePhrase(norm, word, roman));
                }
            }

            if (roman != null && tokens.Length > 1 && ContainsWholePhrase(norm, roman))
            {
                AddVariant(ReplaceWholePhrase(norm, roman, digit));
                AddVariant(ReplaceWholePhrase(norm, roman, word));
            }
        }

        return variants;
    }

    private static bool ContainsWholePhrase(string text, string phrase)
    {
        var idx = text.IndexOf(phrase, StringComparison.Ordinal);
        while (idx >= 0)
        {
            var startOk = idx == 0 || text[idx - 1] == ' ';
            var endIdx = idx + phrase.Length;
            var endOk = endIdx == text.Length || text[endIdx] == ' ';
            if (startOk && endOk)
            {
                return true;
            }

            idx = text.IndexOf(phrase, idx + 1, StringComparison.Ordinal);
        }

        return false;
    }

    private static string ReplaceWholePhrase(string text, string oldPhrase, string newPhrase)
    {
        var idx = text.IndexOf(oldPhrase, StringComparison.Ordinal);
        while (idx >= 0)
        {
            var startOk = idx == 0 || text[idx - 1] == ' ';
            var endIdx = idx + oldPhrase.Length;
            var endOk = endIdx == text.Length || text[endIdx] == ' ';
            if (startOk && endOk)
            {
                return string.Concat(text.AsSpan(0, idx), newPhrase, text.AsSpan(endIdx));
            }

            idx = text.IndexOf(oldPhrase, idx + 1, StringComparison.Ordinal);
        }

        return text;
    }

    public static int RestrictedDamerauLevenshtein(ReadOnlySpan<char> a, ReadOnlySpan<char> b, int maxDistance = int.MaxValue)
    {
        if (a.Length == 0)
        {
            return b.Length <= maxDistance ? b.Length : maxDistance + 1;
        }

        if (b.Length == 0)
        {
            return a.Length <= maxDistance ? a.Length : maxDistance + 1;
        }

        if (Math.Abs(a.Length - b.Length) > maxDistance)
        {
            return maxDistance + 1;
        }

        if (a.SequenceEqual(b))
        {
            return 0;
        }

        // Ensure b is the shorter span for smaller row buffer
        if (a.Length < b.Length)
        {
            var tmp = a;
            a = b;
            b = tmp;
        }

        var n = a.Length;
        var m = b.Length;
        var rowLen = m + 1;

        Span<int> prev2 = rowLen <= 128 ? stackalloc int[rowLen] : new int[rowLen];
        Span<int> prev1 = rowLen <= 128 ? stackalloc int[rowLen] : new int[rowLen];
        Span<int> curr = rowLen <= 128 ? stackalloc int[rowLen] : new int[rowLen];

        for (var j = 0; j <= m; j++)
        {
            prev1[j] = j;
        }

        for (var i = 1; i <= n; i++)
        {
            curr[0] = i;
            var rowMin = curr[0];
            var ca = a[i - 1];

            for (var j = 1; j <= m; j++)
            {
                var cb = b[j - 1];
                var cost = ca == cb ? 0 : 1;

                var deletion = prev1[j] + 1;
                var insertion = curr[j - 1] + 1;
                var substitution = prev1[j - 1] + cost;
                var best = Math.Min(deletion, Math.Min(insertion, substitution));

                if (i > 1 && j > 1 && ca == b[j - 2] && a[i - 2] == cb)
                {
                    best = Math.Min(best, prev2[j - 2] + 1);
                }

                curr[j] = best;
                if (best < rowMin)
                {
                    rowMin = best;
                }
            }

            if (rowMin > maxDistance)
            {
                return maxDistance + 1;
            }

            var temp = prev2;
            prev2 = prev1;
            prev1 = curr;
            curr = temp;
        }

        var result = prev1[m];
        return result <= maxDistance ? result : maxDistance + 1;
    }

    public static string SimplePhoneticKey(string? token)
    {
        if (string.IsNullOrWhiteSpace(token))
        {
            return string.Empty;
        }

        var s = Normalize(token);
        if (string.IsNullOrEmpty(s))
        {
            return string.Empty;
        }

        // Multi-character phonetic normalizations
        s = s
            .Replace("ph", "f", StringComparison.Ordinal)
            .Replace("ck", "k", StringComparison.Ordinal)
            .Replace("sch", "s", StringComparison.Ordinal)
            .Replace("sh", "s", StringComparison.Ordinal)
            .Replace("gh", "g", StringComparison.Ordinal)
            .Replace("kn", "n", StringComparison.Ordinal)
            .Replace("wr", "r", StringComparison.Ordinal)
            .Replace("wh", "w", StringComparison.Ordinal)
            .Replace("dg", "j", StringComparison.Ordinal)
            .Replace("cion", "tion", StringComparison.Ordinal)
            .Replace("sion", "tion", StringComparison.Ordinal)
            .Replace("qu", "kw", StringComparison.Ordinal);

        var sb = new StringBuilder(s.Length);
        var prev = '\0';

        for (var i = 0; i < s.Length; i++)
        {
            var ch = s[i];
            if (ch == ' ')
            {
                continue;
            }

            var mapped = ch switch
            {
                'c' => (i + 1 < s.Length && s[i + 1] is 'e' or 'i' or 'y') ? 's' : 'k',
                'z' => 's',
                'v' => 'f',
                'q' => 'k',
                _ => ch,
            };

            var isVowel = mapped is 'a' or 'e' or 'i' or 'o' or 'u' or 'y';
            if (sb.Length == 0)
            {
                // Preserve first character (canonicalize initial vowel to 'a')
                var first = isVowel ? 'a' : mapped;
                sb.Append(first);
                prev = first;
                continue;
            }

            if (isVowel || mapped is 'h' or 'w')
            {
                continue;
            }

            if (mapped != prev)
            {
                sb.Append(mapped);
                prev = mapped;
            }
        }

        return sb.ToString();
    }

    public static double TrigramDiceSimilarity(string? a, string? b)
    {
        var na = Normalize(a);
        var nb = Normalize(b);
        if (na.Length == 0 || nb.Length == 0)
        {
            return 0.0;
        }

        if (string.Equals(na, nb, StringComparison.Ordinal))
        {
            return 1.0;
        }

        var trigramsA = ExtractTrigrams(na);
        var trigramsB = ExtractTrigrams(nb);
        if (trigramsA.Count == 0 || trigramsB.Count == 0)
        {
            return 0.0;
        }

        var intersection = 0;
        foreach (var (trigram, countA) in trigramsA)
        {
            if (trigramsB.TryGetValue(trigram, out var countB))
            {
                intersection += Math.Min(countA, countB);
            }
        }

        var totalA = trigramsA.Values.Sum();
        var totalB = trigramsB.Values.Sum();
        return (2.0 * intersection) / (totalA + totalB);
    }

    private static Dictionary<string, int> ExtractTrigrams(string normalized)
    {
        var padded = " " + normalized + " ";
        var dict = new Dictionary<string, int>(StringComparer.Ordinal);
        if (padded.Length < 3)
        {
            dict[padded] = 1;
            return dict;
        }

        for (var i = 0; i <= padded.Length - 3; i++)
        {
            var tri = padded.Substring(i, 3);
            dict[tri] = dict.GetValueOrDefault(tri) + 1;
        }

        return dict;
    }
}
