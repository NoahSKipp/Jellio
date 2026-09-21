using System;
using System.Numerics;

namespace Jellio.Services.IntroCredits;

// Same real technique Intro Skipper's own cross-episode comparison
// already uses on a local file (real chromaprint subfingerprints,
// Hamming distance between them, a real repeated sequence reading as a
// long run of near-identical ones at a fixed real relative offset
// between two episodes), not re-derived from anywhere else: this file
// only supplies the real matching once ChromaprintExtractor has already
// produced two real fingerprint arrays to compare, no ffmpeg/IO of its
// own.
public static class FingerprintMatcher
{
    // Out of 32 real bits per subfingerprint: two real chromaprint items
    // describing the exact same real few hundred ms of audio rarely
    // come back bit-identical even when they genuinely are the same
    // real source audio (real quantization noise in the algorithm
    // itself), a small real tolerance is what makes a real match
    // readable as one run rather than a real match broken into many
    // one-item-long fragments by a stray single-bit real flip.
    private const int MaxBitDistance = 10;

    // Real feedback informed this: a 10-12 real second floor is short
    // enough to still catch a real cold-open-free sitcom intro, long
    // enough that a real few seconds of coincidental silence/ambient
    // noise matching by chance never reads as a real detected segment
    // on its own.
    private const double MinMatchSeconds = 10;

    public readonly record struct Match(double StartSeconds, double EndSeconds);

    // windowSecondsA is the real wall clock span fingerprint a itself
    // represents (whatever ChromaprintExtractor was actually asked to
    // read for it), used only to convert a's own real item indices back
    // into real seconds for the returned Match - b's own real window
    // never needs converting, only bounding the real comparison.
    public static Match? FindMatch(int[] a, int[] b, double windowSecondsA)
    {
        if (a.Length < 4 || b.Length < 4 || windowSecondsA <= 0)
        {
            return null;
        }

        var secondsPerItem = windowSecondsA / a.Length;
        var maxShift = a.Length + b.Length;
        Match? best = null;
        var bestLength = 0;

        for (var shift = -maxShift; shift <= maxShift; shift++)
        {
            var runStart = -1;
            for (var i = 0; i <= a.Length; i++)
            {
                var j = i + shift;
                var isMatch = i < a.Length && j >= 0 && j < b.Length && Distance(a[i], b[j]) <= MaxBitDistance;
                if (isMatch)
                {
                    if (runStart == -1)
                    {
                        runStart = i;
                    }

                    continue;
                }

                if (runStart != -1)
                {
                    var length = i - runStart;
                    if (length > bestLength)
                    {
                        bestLength = length;
                        best = new Match(runStart * secondsPerItem, i * secondsPerItem);
                    }

                    runStart = -1;
                }
            }
        }

        if (best is not { } match || (match.EndSeconds - match.StartSeconds) < MinMatchSeconds)
        {
            return null;
        }

        return match;
    }

    private static int Distance(int x, int y) => BitOperations.PopCount((uint)(x ^ y));
}
