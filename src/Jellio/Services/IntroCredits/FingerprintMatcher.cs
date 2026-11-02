using System;
using System.Numerics;

namespace Jellio.Services.IntroCredits;

public static class FingerprintMatcher
{
    private const int MaxBitDistance = 10;

    private const double MinMatchSeconds = 10;

    public readonly record struct Match(double StartSeconds, double EndSeconds);

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
