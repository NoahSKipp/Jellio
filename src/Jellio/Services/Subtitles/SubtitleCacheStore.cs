using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using MediaBrowser.Common.Configuration;

namespace Jellio.Services.Subtitles;

public enum SubtitleCacheStatus
{
    Found,
    NotFound,
}

public record SubtitleCacheEntry(SubtitleCacheStatus Status, DateTime CheckedUtc);

public record SubtitleQuotaState(DateTime? ThrottledUntilUtc);

/// <summary>
/// Persists fetched subtitles to disk, one file per item per language
/// plus a small per item manifest, same one-file-per-key JSON shape
/// Services/Achievements/AchievementStore.cs already uses under
/// PluginConfigurationsPath. Real reason this has to be disk backed
/// rather than the in memory, restart clears it tradeoff every other
/// Jellio owned store in this feature area (GroupWatchChatService,
/// GrouplistStore) already makes: SubDL's own real free tier caps at 50
/// downloads a day (confirmed against subdl.com's own developer page
/// before writing this), a plugin restart silently re-spending that
/// same real daily budget re-fetching everything already sitting here
/// once would be a real regression, not a real cost worth accepting
/// the way an ephemeral chat room is.
///
/// A NotFound result is cached too, not just a real Found one: a title
/// with genuinely no subtitle in some language should not draw a fresh
/// real search every single time it is opened again. NotFoundCooldown
/// below still lets a real later upload on SubDL's own side eventually
/// be found, same real "search again after some weeks" convention
/// Bazarr's own real settings already document for this exact same
/// real gap, just not re-checked on every single real open in between.
/// </summary>
public class SubtitleCacheStore(IApplicationPaths applicationPaths)
{
    private static readonly TimeSpan NotFoundCooldown = TimeSpan.FromDays(28);
    // SubDlClient's own real 429 carries nothing this confirmed a real
    // reset time in (SubDlQuotaExceededException's own header explains
    // why), so every real quota hit falls back to this same flat
    // cushion rather than a provider supplied one.
    private static readonly TimeSpan DefaultQuotaCooldown = TimeSpan.FromHours(24);

    private readonly object _quotaLock = new();

    private string StoreDirectory =>
        Path.Combine(applicationPaths.PluginConfigurationsPath, "Jellio", "subtitles");

    private string ManifestPath(Guid itemId) => Path.Combine(StoreDirectory, itemId + ".json");

    private string VttPath(Guid itemId, string language) => Path.Combine(StoreDirectory, itemId + "." + language + ".vtt");

    private string QuotaPath => Path.Combine(StoreDirectory, "_quota.json");

    private Dictionary<string, SubtitleCacheEntry> LoadManifest(Guid itemId)
    {
        var path = ManifestPath(itemId);
        if (!File.Exists(path))
        {
            return new Dictionary<string, SubtitleCacheEntry>();
        }

        try
        {
            return JsonSerializer.Deserialize<Dictionary<string, SubtitleCacheEntry>>(File.ReadAllText(path))
                ?? new Dictionary<string, SubtitleCacheEntry>();
        }
        catch (JsonException)
        {
            return new Dictionary<string, SubtitleCacheEntry>();
        }
    }

    private void SaveManifest(Guid itemId, Dictionary<string, SubtitleCacheEntry> manifest)
    {
        Directory.CreateDirectory(StoreDirectory);
        File.WriteAllText(ManifestPath(itemId), JsonSerializer.Serialize(manifest));
    }

    // False means SubtitleFetchService should actually try SubDL for
    // this item/language; true covers both a real Found already on
    // disk and a real NotFound still inside its own cooldown.
    public bool ShouldSkip(Guid itemId, string language)
    {
        var manifest = LoadManifest(itemId);
        if (!manifest.TryGetValue(language, out var entry))
        {
            return false;
        }

        if (entry.Status == SubtitleCacheStatus.Found)
        {
            return File.Exists(VttPath(itemId, language));
        }

        return DateTime.UtcNow - entry.CheckedUtc < NotFoundCooldown;
    }

    public void SaveFound(Guid itemId, string language, string vttContent)
    {
        Directory.CreateDirectory(StoreDirectory);
        File.WriteAllText(VttPath(itemId, language), vttContent);
        var manifest = LoadManifest(itemId);
        manifest[language] = new SubtitleCacheEntry(SubtitleCacheStatus.Found, DateTime.UtcNow);
        SaveManifest(itemId, manifest);
    }

    public void SaveNotFound(Guid itemId, string language)
    {
        var manifest = LoadManifest(itemId);
        manifest[language] = new SubtitleCacheEntry(SubtitleCacheStatus.NotFound, DateTime.UtcNow);
        SaveManifest(itemId, manifest);
    }

    // {Language, Path} for whichever languages this item already has a
    // real Found entry for and the file itself still actually exists
    // (an admin who wiped PluginConfigurationsPath by hand should not
    // leave a manifest claiming files that are no longer really there).
    public IReadOnlyList<string> GetAvailableLanguages(Guid itemId)
    {
        var manifest = LoadManifest(itemId);
        var available = new List<string>();
        foreach (var (language, entry) in manifest)
        {
            if (entry.Status == SubtitleCacheStatus.Found && File.Exists(VttPath(itemId, language)))
            {
                available.Add(language);
            }
        }

        return available;
    }

    public string? GetVttFilePath(Guid itemId, string language)
    {
        var path = VttPath(itemId, language);
        return File.Exists(path) ? path : null;
    }

    // Global, not per item: real SubDL quota is per API key, so one 429
    // anywhere means every other real item this service is asked about
    // should skip straight past a real network call it already knows
    // would fail, not just the one that drew it.
    public bool IsThrottled()
    {
        lock (_quotaLock)
        {
            var state = LoadQuotaState();
            return state.ThrottledUntilUtc.HasValue && DateTime.UtcNow < state.ThrottledUntilUtc.Value;
        }
    }

    public void SetThrottled(DateTime? resetUtc)
    {
        lock (_quotaLock)
        {
            Directory.CreateDirectory(StoreDirectory);
            var until = resetUtc ?? DateTime.UtcNow.Add(DefaultQuotaCooldown);
            File.WriteAllText(QuotaPath, JsonSerializer.Serialize(new SubtitleQuotaState(until)));
        }
    }

    private SubtitleQuotaState LoadQuotaState()
    {
        if (!File.Exists(QuotaPath))
        {
            return new SubtitleQuotaState(null);
        }

        try
        {
            return JsonSerializer.Deserialize<SubtitleQuotaState>(File.ReadAllText(QuotaPath)) ?? new SubtitleQuotaState(null);
        }
        catch (JsonException)
        {
            return new SubtitleQuotaState(null);
        }
    }
}
