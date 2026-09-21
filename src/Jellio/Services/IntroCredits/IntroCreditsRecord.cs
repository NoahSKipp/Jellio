using System;

namespace Jellio.Services.IntroCredits;

// Ticks, the same real unit RealDurationStore already persists in and
// runtime/api.js's own TICKS_PER_SECOND already converts everywhere
// else: EndTicks <= 0 is "no real segment found", the same Segment.Valid
// convention getNativeMediaSegments already treats native Media Segments
// data as using, not something this file invents.
public class IntroCreditsRecord
{
    public long IntroStartTicks { get; set; }

    public long IntroEndTicks { get; set; }

    public long CreditsStartTicks { get; set; }

    public long CreditsEndTicks { get; set; }

    public bool Attempted { get; set; }

    public DateTimeOffset AttemptedAt { get; set; }
}
