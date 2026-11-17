using Jellio.Configuration;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellio.Controllers;

[ApiController]
[Route("Jellio/config")]
[Authorize]
public class ConfigController : ControllerBase
{
    public record SeasonalRange(int StartMonth, int StartDay, int EndMonth, int EndDay);

    public record SeasonalEffectConfig(bool Enabled, SeasonalRange Range);

    public record ClientConfig(
        bool SeasonalEffectsEnabled,
        Dictionary<string, SeasonalEffectConfig> SeasonalEffects,
        bool SkipIntroCreditsAdminMenuEnabled,
        bool BookRequestsEnabled,
        bool TranslationEnabled,
        bool MangaRequestsEnabled,
        string VideoTranscodePolicy,
        bool HomeRowCache,
        bool BooksEnabled,
        bool AudiobooksEnabled,
        bool MangaEnabled,
        IReadOnlyList<string> DisabledLibraryIds);

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

        // Only whether book/manga requests are available, never the token itself.
        var bookRequestsEnabled = cfg.BooksEnabled && !string.IsNullOrWhiteSpace(cfg.ChaptarrUrl) && !string.IsNullOrWhiteSpace(cfg.ChaptarrApiKey);
        var mangaRequestsEnabled = cfg.MangaEnabled && !string.IsNullOrWhiteSpace(cfg.SuwayomiUrl);
        var policy = cfg.VideoTranscodePolicy is "Avoid" or "Block" ? cfg.VideoTranscodePolicy : "Allow";
        var disabledLibraries = (IReadOnlyList<string>)(cfg.DisabledLibraryIds ?? []);
        return Ok(new ClientConfig(
            cfg.SeasonalEffectsEnabled,
            effects,
            cfg.SkipIntroCreditsAdminMenuEnabled,
            bookRequestsEnabled,
            !string.IsNullOrWhiteSpace(cfg.DeepLApiKey),
            mangaRequestsEnabled,
            policy,
            cfg.HomeRowCache,
            cfg.BooksEnabled,
            cfg.AudiobooksEnabled,
            cfg.MangaEnabled,
            disabledLibraries));
    }
}
