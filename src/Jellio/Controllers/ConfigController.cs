using Jellio.Configuration;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

/// <summary>
/// Server side, admin controlled config every Jellio client reads,
/// starting with Frontend/components/seasons.js's own reskin: one real
/// shared source instead of a client only localStorage toggle, so a
/// setting here already applies to every user and, down the line, to
/// any other real client of this same server (an Android TV client
/// included) the same way Moonfin's own server plugin already serves
/// one shared settings surface to every one of its own real clients,
/// confirmed against that project's own source before writing this
/// rather than guessed. Authenticated like every other controller in
/// this codebase; nothing here is secret, but there is no real reason
/// for an unauthenticated request to reach it either.
/// </summary>
[ApiController]
[Route("Jellio/config")]
[Authorize]
public class ConfigController : ControllerBase
{
    public record SeasonalRange(int StartMonth, int StartDay, int EndMonth, int EndDay);

    public record SeasonalEffectConfig(bool Enabled, SeasonalRange Range);

    public record ClientConfig(bool SeasonalEffectsEnabled, Dictionary<string, SeasonalEffectConfig> SeasonalEffects);

    [HttpGet]
    public ActionResult<ClientConfig> Get()
    {
        var cfg = JellioPlugin.Instance!.Configuration;

        var effects = new Dictionary<string, SeasonalEffectConfig>
        {
            ["halloween"] = new(
                cfg.SeasonalHalloweenEnabled,
                new SeasonalRange(cfg.SeasonalHalloweenStartMonth, cfg.SeasonalHalloweenStartDay, cfg.SeasonalHalloweenEndMonth, cfg.SeasonalHalloweenEndDay)
            ),
            ["newyear"] = new(
                cfg.SeasonalNewYearEnabled,
                new SeasonalRange(cfg.SeasonalNewYearStartMonth, cfg.SeasonalNewYearStartDay, cfg.SeasonalNewYearEndMonth, cfg.SeasonalNewYearEndDay)
            ),
            ["valentine"] = new(
                cfg.SeasonalValentineEnabled,
                new SeasonalRange(cfg.SeasonalValentineStartMonth, cfg.SeasonalValentineStartDay, cfg.SeasonalValentineEndMonth, cfg.SeasonalValentineEndDay)
            ),
            ["christmas"] = new(
                cfg.SeasonalChristmasEnabled,
                new SeasonalRange(cfg.SeasonalChristmasStartMonth, cfg.SeasonalChristmasStartDay, cfg.SeasonalChristmasEndMonth, cfg.SeasonalChristmasEndDay)
            ),
        };

        return Ok(new ClientConfig(cfg.SeasonalEffectsEnabled, effects));
    }
}
