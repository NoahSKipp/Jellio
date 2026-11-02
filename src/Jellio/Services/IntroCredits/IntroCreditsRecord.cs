using System;

namespace Jellio.Services.IntroCredits;

public class IntroCreditsRecord
{
    public long IntroStartTicks { get; set; }

    public long IntroEndTicks { get; set; }

    public long CreditsStartTicks { get; set; }

    public long CreditsEndTicks { get; set; }

    public bool Attempted { get; set; }

    public DateTimeOffset AttemptedAt { get; set; }

    public bool CommunityAttempted { get; set; }

    public DateTimeOffset CommunityAttemptedAt { get; set; }
}
