using Jellio.Configuration;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

/// <summary>
/// Server side, admin controlled config every Jellio client reads,
/// starting with Frontend/components/seasonalEffects.js's own overlay:
/// one real shared source instead of the client only localStorage
/// toggles this used to carry, so a setting here already applies to
/// every user and, down the line, to any other real client of this
/// same server (an Android TV client included) the same way Moonfin's
/// own server plugin already serves one shared settings surface to
/// every one of its own real clients, confirmed against that project's
/// own source before writing this rather than guessed. Authenticated
/// like every other controller in this codebase; nothing here is
/// secret, but there is no real reason for an unauthenticated request
/// to reach it either.
/// </summary>
[ApiController]
[Route("Jellio/config")]
[Authorize]
public class ConfigController : ControllerBase
{
    public record SeasonalRange(int StartMonth, int StartDay, int EndMonth, int EndDay);

    public record SeasonalEffectConfig(bool Enabled, SeasonalRange? Range);

    public record ClientConfig(bool SeasonalEffectsEnabled, Dictionary<string, SeasonalEffectConfig> SeasonalEffects);

    [HttpGet]
    public ActionResult<ClientConfig> Get()
    {
        var cfg = JellioPlugin.Instance!.Configuration;

        var effects = new Dictionary<string, SeasonalEffectConfig>
        {
            ["winter"] = new(
                cfg.SeasonalWinterEnabled,
                new SeasonalRange(cfg.SeasonalWinterStartMonth, cfg.SeasonalWinterStartDay, cfg.SeasonalWinterEndMonth, cfg.SeasonalWinterEndDay)
            ),
            ["spring"] = new(
                cfg.SeasonalSpringEnabled,
                new SeasonalRange(cfg.SeasonalSpringStartMonth, cfg.SeasonalSpringStartDay, cfg.SeasonalSpringEndMonth, cfg.SeasonalSpringEndDay)
            ),
            ["summer"] = new(
                cfg.SeasonalSummerEnabled,
                new SeasonalRange(cfg.SeasonalSummerStartMonth, cfg.SeasonalSummerStartDay, cfg.SeasonalSummerEndMonth, cfg.SeasonalSummerEndDay)
            ),
            ["autumn"] = new(
                cfg.SeasonalAutumnEnabled,
                new SeasonalRange(cfg.SeasonalAutumnStartMonth, cfg.SeasonalAutumnStartDay, cfg.SeasonalAutumnEndMonth, cfg.SeasonalAutumnEndDay)
            ),
            ["halloween"] = new(
                cfg.SeasonalHalloweenEnabled,
                new SeasonalRange(cfg.SeasonalHalloweenStartMonth, cfg.SeasonalHalloweenStartDay, cfg.SeasonalHalloweenEndMonth, cfg.SeasonalHalloweenEndDay)
            ),
            ["newyear"] = new(
                cfg.SeasonalNewYearEnabled,
                new SeasonalRange(cfg.SeasonalNewYearStartMonth, cfg.SeasonalNewYearStartDay, cfg.SeasonalNewYearEndMonth, cfg.SeasonalNewYearEndDay)
            ),
            ["friday13"] = new(cfg.SeasonalFriday13Enabled, null),
            ["hearts"] = new(
                cfg.SeasonalHeartsEnabled,
                new SeasonalRange(cfg.SeasonalHeartsStartMonth, cfg.SeasonalHeartsStartDay, cfg.SeasonalHeartsEndMonth, cfg.SeasonalHeartsEndDay)
            ),
            ["carnival"] = new(
                cfg.SeasonalCarnivalEnabled,
                new SeasonalRange(cfg.SeasonalCarnivalStartMonth, cfg.SeasonalCarnivalStartDay, cfg.SeasonalCarnivalEndMonth, cfg.SeasonalCarnivalEndDay)
            ),
            ["oscar"] = new(
                cfg.SeasonalOscarEnabled,
                new SeasonalRange(cfg.SeasonalOscarStartMonth, cfg.SeasonalOscarStartDay, cfg.SeasonalOscarEndMonth, cfg.SeasonalOscarEndDay)
            ),
            ["filmnoir"] = new(
                cfg.SeasonalFilmNoirEnabled,
                new SeasonalRange(cfg.SeasonalFilmNoirStartMonth, cfg.SeasonalFilmNoirStartDay, cfg.SeasonalFilmNoirEndMonth, cfg.SeasonalFilmNoirEndDay)
            ),
            ["earthday"] = new(
                cfg.SeasonalEarthDayEnabled,
                new SeasonalRange(cfg.SeasonalEarthDayStartMonth, cfg.SeasonalEarthDayStartDay, cfg.SeasonalEarthDayEndMonth, cfg.SeasonalEarthDayEndDay)
            ),
            ["cherryblossom"] = new(
                cfg.SeasonalCherryBlossomEnabled,
                new SeasonalRange(cfg.SeasonalCherryBlossomStartMonth, cfg.SeasonalCherryBlossomStartDay, cfg.SeasonalCherryBlossomEndMonth, cfg.SeasonalCherryBlossomEndDay)
            ),
            ["starwars"] = new(
                cfg.SeasonalStarWarsEnabled,
                new SeasonalRange(cfg.SeasonalStarWarsStartMonth, cfg.SeasonalStarWarsStartDay, cfg.SeasonalStarWarsEndMonth, cfg.SeasonalStarWarsEndDay)
            ),
            ["eurovision"] = new(
                cfg.SeasonalEurovisionEnabled,
                new SeasonalRange(cfg.SeasonalEurovisionStartMonth, cfg.SeasonalEurovisionStartDay, cfg.SeasonalEurovisionEndMonth, cfg.SeasonalEurovisionEndDay)
            ),
            ["pride"] = new(
                cfg.SeasonalPrideEnabled,
                new SeasonalRange(cfg.SeasonalPrideStartMonth, cfg.SeasonalPrideStartDay, cfg.SeasonalPrideEndMonth, cfg.SeasonalPrideEndDay)
            ),
            ["oktoberfest"] = new(
                cfg.SeasonalOktoberfestEnabled,
                new SeasonalRange(cfg.SeasonalOktoberfestStartMonth, cfg.SeasonalOktoberfestStartDay, cfg.SeasonalOktoberfestEndMonth, cfg.SeasonalOktoberfestEndDay)
            ),
            ["spooky"] = new(
                cfg.SeasonalSpookyEnabled,
                new SeasonalRange(cfg.SeasonalSpookyStartMonth, cfg.SeasonalSpookyStartDay, cfg.SeasonalSpookyEndMonth, cfg.SeasonalSpookyEndDay)
            ),
            ["christmas"] = new(
                cfg.SeasonalChristmasEnabled,
                new SeasonalRange(cfg.SeasonalChristmasStartMonth, cfg.SeasonalChristmasStartDay, cfg.SeasonalChristmasEndMonth, cfg.SeasonalChristmasEndDay)
            ),
            ["snowflakes"] = new(
                cfg.SeasonalSnowflakesEnabled,
                new SeasonalRange(cfg.SeasonalSnowflakesStartMonth, cfg.SeasonalSnowflakesStartDay, cfg.SeasonalSnowflakesEndMonth, cfg.SeasonalSnowflakesEndDay)
            ),
            ["birthday"] = new(
                cfg.SeasonalBirthdayEnabled,
                new SeasonalRange(cfg.SeasonalBirthdayStartMonth, cfg.SeasonalBirthdayStartDay, cfg.SeasonalBirthdayEndMonth, cfg.SeasonalBirthdayEndDay)
            ),
            ["eid"] = new(
                cfg.SeasonalEidEnabled,
                new SeasonalRange(cfg.SeasonalEidStartMonth, cfg.SeasonalEidStartDay, cfg.SeasonalEidEndMonth, cfg.SeasonalEidEndDay)
            ),
            ["resurrection"] = new(
                cfg.SeasonalResurrectionEnabled,
                new SeasonalRange(cfg.SeasonalResurrectionStartMonth, cfg.SeasonalResurrectionStartDay, cfg.SeasonalResurrectionEndMonth, cfg.SeasonalResurrectionEndDay)
            ),
            ["nightsky"] = new(
                cfg.SeasonalNightSkyEnabled,
                new SeasonalRange(cfg.SeasonalNightSkyStartMonth, cfg.SeasonalNightSkyStartDay, cfg.SeasonalNightSkyEndMonth, cfg.SeasonalNightSkyEndDay)
            ),
            ["matrix"] = new(
                cfg.SeasonalMatrixEnabled,
                new SeasonalRange(cfg.SeasonalMatrixStartMonth, cfg.SeasonalMatrixStartDay, cfg.SeasonalMatrixEndMonth, cfg.SeasonalMatrixEndDay)
            ),
            ["frost"] = new(
                cfg.SeasonalFrostEnabled,
                new SeasonalRange(cfg.SeasonalFrostStartMonth, cfg.SeasonalFrostStartDay, cfg.SeasonalFrostEndMonth, cfg.SeasonalFrostEndDay)
            ),
            ["space"] = new(
                cfg.SeasonalSpaceEnabled,
                new SeasonalRange(cfg.SeasonalSpaceStartMonth, cfg.SeasonalSpaceStartDay, cfg.SeasonalSpaceEndMonth, cfg.SeasonalSpaceEndDay)
            ),
            ["underwater"] = new(
                cfg.SeasonalUnderwaterEnabled,
                new SeasonalRange(cfg.SeasonalUnderwaterStartMonth, cfg.SeasonalUnderwaterStartDay, cfg.SeasonalUnderwaterEndMonth, cfg.SeasonalUnderwaterEndDay)
            ),
            ["santa"] = new(
                cfg.SeasonalSantaEnabled,
                new SeasonalRange(cfg.SeasonalSantaStartMonth, cfg.SeasonalSantaStartDay, cfg.SeasonalSantaEndMonth, cfg.SeasonalSantaEndDay)
            ),
            ["marioday"] = new(
                cfg.SeasonalMarioDayEnabled,
                new SeasonalRange(cfg.SeasonalMarioDayStartMonth, cfg.SeasonalMarioDayStartDay, cfg.SeasonalMarioDayEndMonth, cfg.SeasonalMarioDayEndDay)
            ),
            ["snowfall"] = new(
                cfg.SeasonalSnowfallEnabled,
                new SeasonalRange(cfg.SeasonalSnowfallStartMonth, cfg.SeasonalSnowfallStartDay, cfg.SeasonalSnowfallEndMonth, cfg.SeasonalSnowfallEndDay)
            ),
            ["storm"] = new(
                cfg.SeasonalStormEnabled,
                new SeasonalRange(cfg.SeasonalStormStartMonth, cfg.SeasonalStormStartDay, cfg.SeasonalStormEndMonth, cfg.SeasonalStormEndDay)
            ),
            ["rain"] = new(
                cfg.SeasonalRainEnabled,
                new SeasonalRange(cfg.SeasonalRainStartMonth, cfg.SeasonalRainStartDay, cfg.SeasonalRainEndMonth, cfg.SeasonalRainEndDay)
            ),
            ["sports"] = new(
                cfg.SeasonalSportsEnabled,
                new SeasonalRange(cfg.SeasonalSportsStartMonth, cfg.SeasonalSportsStartDay, cfg.SeasonalSportsEndMonth, cfg.SeasonalSportsEndDay)
            ),
            ["snowstorm"] = new(
                cfg.SeasonalSnowstormEnabled,
                new SeasonalRange(cfg.SeasonalSnowstormStartMonth, cfg.SeasonalSnowstormStartDay, cfg.SeasonalSnowstormEndMonth, cfg.SeasonalSnowstormEndDay)
            ),
        };

        return Ok(new ClientConfig(cfg.SeasonalEffectsEnabled, effects));
    }
}
