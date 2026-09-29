using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellio.Services.Reading;
using Jellyfin.Data.Enums;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellio.Services.Manga;

public class PendingChapterProgress
{
    public string Series { get; set; } = string.Empty;

    public string Chapter { get; set; } = string.Empty;

    public bool Read { get; set; }

    // Mihon's own 0-based page index.
    public long LastPageRead { get; set; }

    public bool Bookmark { get; set; }

    // Unix milliseconds, 0 when Mihon had no history for it.
    public long LastReadAt { get; set; }
}

public record MangaImportSeriesResult(string Title, string Outcome, int QueuedChapters, string? Message);

public class MangaImportJob
{
    public string Status { get; set; } = "running";

    public int Total { get; set; }

    public int Processed { get; set; }

    public List<MangaImportSeriesResult> Series { get; } = [];

    public DateTimeOffset StartedAt { get; set; } = DateTimeOffset.UtcNow;

    public DateTimeOffset? FinishedAt { get; set; }
}

/// <summary>
/// Imports a reader's Mihon library (MihonBackupReader): each series is
/// found on the same source in Suwayomi, added to its library, and
/// downloaded from the chapter the reader left off at onwards. What they
/// had read is kept per reader and applied to Jellio's own reading
/// progress once Jellyfin has the chapter (now, or when a later library
/// scan adds it), matched by series folder and chapter file name - the
/// way Suwayomi names its downloads. Categories, per-series settings and
/// bookmarks go to the reader's shelf (ShelfStore).
/// </summary>
public class MangaImportService(
    SuwayomiClient suwayomi,
    ReadingProgressStore progressStore,
    ShelfStore shelfStore,
    MangaStreamService streamService,
    ILibraryManager libraryManager,
    IApplicationPaths applicationPaths,
    ILogger<MangaImportService> logger) : IHostedService
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = false };
    private static readonly string[] ComicExtensions = [".cbz", ".cbr", ".cb7", ".cbt", ".zip"];
    private static readonly string[] ImageExtensions = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp"];

    private const int MaxSourceFailures = 2;
    private const int FallbackSearches = 4;
    private static readonly TimeSpan SeriesTimeout = TimeSpan.FromSeconds(150);
    private static readonly TimeSpan OriginalSourceTimeout = TimeSpan.FromSeconds(45);
    private static readonly TimeSpan FallbackSearchTimeout = TimeSpan.FromSeconds(20);

    private readonly ConcurrentDictionary<Guid, MangaImportJob> _jobs = new();
    private readonly object _storeLock = new();

    private string StorePath =>
        Path.Combine(applicationPaths.PluginConfigurationsPath, "Jellio", "manga-import-progress.json");

    public Task StartAsync(CancellationToken cancellationToken)
    {
        try
        {
            Subscribe();
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: could not subscribe to library changes for Mihon imports.");
        }

        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        try
        {
            libraryManager.ItemAdded -= OnItemAdded;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: could not unsubscribe from library changes for Mihon imports.");
        }

        return Task.CompletedTask;
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private void Subscribe() => libraryManager.ItemAdded += OnItemAdded;

    public MangaImportJob? GetJob(Guid userId) => _jobs.GetValueOrDefault(userId);

    public int PendingCount(Guid userId)
    {
        lock (_storeLock)
        {
            return LoadLocked().GetValueOrDefault(userId.ToString("N"))?.Count ?? 0;
        }
    }

    // Returns null when this reader already has an import running.
    public MangaImportJob? Start(Guid userId, IReadOnlyList<MihonManga> library, IReadOnlyList<MihonCategory> categories)
    {
        var job = new MangaImportJob { Total = library.Count };
        if (_jobs.TryGetValue(userId, out var existing) && existing.Status == "running")
        {
            return null;
        }

        _jobs[userId] = job;
        _ = Task.Run(() => RunAsync(userId, library, categories, job));
        return job;
    }

    private async Task RunAsync(Guid userId, IReadOnlyList<MihonManga> library, IReadOnlyList<MihonCategory> categories, MangaImportJob job)
    {
        try
        {
            var categoryIds = ImportCategories(userId, categories);

            // A source that keeps timing out (one needing a WebView Suwayomi
            // can't start, or a site that's down) would hold every series
            // on it: after two in a row it isn't asked again, and its series
            // go straight to the other installed sources.
            var failures = new Dictionary<long, int>();
            foreach (var manga in library)
            {
                MangaImportSeriesResult result;
                var down = failures.Where(pair => pair.Value >= MaxSourceFailures).Select(pair => pair.Key).ToHashSet();
                try
                {
                    using var timeout = new CancellationTokenSource(SeriesTimeout);
                    var (imported, originalFailed) = await ImportSeriesAsync(userId, manga, categoryIds, down, timeout.Token).ConfigureAwait(false);
                    result = imported;
                    if (!down.Contains(manga.SourceId))
                    {
                        failures[manga.SourceId] = originalFailed ? failures.GetValueOrDefault(manga.SourceId) + 1 : 0;
                    }
                }
                catch (Exception ex)
                {
                    logger.LogWarning(ex, "Jellio: Mihon import of {Title} from {Source} failed", manga.Title, manga.SourceName);
                    ImportShelf(userId, manga, manga.Title, categoryIds);
                    result = new MangaImportSeriesResult(
                        manga.Title,
                        "error",
                        0,
                        manga.SourceName + " didn't answer in time and no other source had it. If Suwayomi's log shows WebView timeouts, that source needs a WebView Suwayomi can't start.");
                    if (!down.Contains(manga.SourceId))
                    {
                        failures[manga.SourceId] = failures.GetValueOrDefault(manga.SourceId) + 1;
                    }
                }

                lock (job)
                {
                    job.Series.Add(result);
                    job.Processed++;
                }
            }

            ApplyToLibrary(userId);
            job.Status = "done";
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: Mihon import failed");
            job.Status = "failed";
        }
        finally
        {
            job.FinishedAt = DateTimeOffset.UtcNow;
        }
    }

    // The series on the source Mihon read it from; when that source doesn't
    // answer or doesn't have it, the same title on another installed
    // source. originalFailed: Mihon's source timed out or errored.
    private async Task<(MangaImportSeriesResult Result, bool OriginalFailed)> ImportSeriesAsync(
        Guid userId,
        MihonManga manga,
        Dictionary<long, string> categoryIds,
        HashSet<long> downSources,
        CancellationToken cancellationToken)
    {
        SuwayomiManga? found = null;
        IReadOnlyList<SuwayomiChapter>? chapters = null;
        var originalFailed = false;
        string? otherSource = null;
        if (!downSources.Contains(manga.SourceId))
        {
            using var first = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            first.CancelAfter(OriginalSourceTimeout);
            try
            {
                found = await suwayomi.FindMangaAsync(manga.SourceId, manga.Url, manga.Title, first.Token).ConfigureAwait(false);
                chapters = found is null ? null : await LoadChaptersAsync(found, first.Token).ConfigureAwait(false);
                originalFailed = found is not null && chapters is null;
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                originalFailed = true;
            }
        }

        if (chapters is null)
        {
            var elsewhere = await FindElsewhereAsync(manga, downSources, cancellationToken).ConfigureAwait(false);
            if (elsewhere is { } other)
            {
                found = other.Manga;
                otherSource = other.SourceName;
                chapters = await LoadChaptersAsync(found, cancellationToken).ConfigureAwait(false);
            }
        }

        ImportShelf(userId, manga, found?.Title ?? manga.Title, categoryIds);
        if (found is null || chapters is null)
        {
            var why = originalFailed || downSources.Contains(manga.SourceId)
                ? manga.SourceName + " isn't responding in Suwayomi and no other installed source has this title."
                : "Not found on " + manga.SourceName + " or any other installed source. Is that extension installed in Suwayomi?";
            return (new MangaImportSeriesResult(manga.Title, originalFailed ? "error" : "not-found", 0, why), originalFailed);
        }

        // Where they left off: the furthest chapter they finished or
        // opened. Nothing read yet means the whole series.
        var started = manga.Chapters.Where(chapter => chapter.Read || chapter.LastPageRead > 0).ToList();
        var numbered = started.Where(chapter => chapter.ChapterNumber >= 0).ToList();
        float? resumeAt = numbered.Count > 0 ? numbered.Max(chapter => chapter.ChapterNumber) : null;
        var excluded = new HashSet<string>(manga.ExcludedScanlators, StringComparer.OrdinalIgnoreCase);
        // Streamed from the source unless the admin keeps manga on the
        // server, in which case it downloads from where they left off.
        var download = JellioPlugin.Instance?.Configuration.SuwayomiDownloadRequests == true;
        List<int> toDownload = download
            ? chapters
                .Where(chapter => !chapter.IsDownloaded && (resumeAt is null || chapter.ChapterNumber >= resumeAt.Value))
                .Where(chapter => excluded.Count == 0 || !excluded.Contains(chapter.Scanlator ?? string.Empty))
                .Select(chapter => chapter.Id)
                .ToList()
            : [];
        if (!await suwayomi.EnqueueDownloadsAsync(toDownload, cancellationToken).ConfigureAwait(false))
        {
            return (new MangaImportSeriesResult(manga.Title, "error", 0, "Suwayomi couldn't queue the downloads"), originalFailed);
        }

        streamService.Invalidate();

        // Named the way Suwayomi names the files: its own chapter record
        // for the same URL when it has one.
        var byUrl = chapters.GroupBy(chapter => chapter.Url, StringComparer.Ordinal).ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);

        // Another source has its own chapter URLs: those match by number.
        var byNumber = chapters
            .Where(chapter => chapter.ChapterNumber >= 0)
            .GroupBy(chapter => chapter.ChapterNumber)
            .ToDictionary(group => group.Key, group => group.First());
        SuwayomiChapter? Match(MihonChapter chapter) =>
            byUrl.TryGetValue(chapter.Url, out var own) ? own
            : chapter.ChapterNumber >= 0 && byNumber.TryGetValue(chapter.ChapterNumber, out var numbered) ? numbered
            : null;
        ApplyToStream(userId, manga, Match);
        var progress = manga.Chapters
            .Where(chapter => chapter.Read || chapter.LastPageRead > 0 || chapter.Bookmark)
            .Select(chapter => new PendingChapterProgress
            {
                Series = Normalize(found.Title),
                Chapter = Normalize(Match(chapter)?.Name ?? chapter.Name),
                Read = chapter.Read,
                LastPageRead = chapter.LastPageRead,
                Bookmark = chapter.Bookmark,
                LastReadAt = chapter.LastReadAt,
            })
            .Where(entry => entry.Series.Length > 0 && entry.Chapter.Length > 0)
            .ToList();
        AddPending(userId, progress);

        var notes = new List<string>();
        if (otherSource is not null)
        {
            notes.Add("From " + otherSource + (originalFailed || downSources.Contains(manga.SourceId) ? " (" + manga.SourceName + " didn't answer)" : " (not on " + manga.SourceName + ")"));
        }

        if (started.Count > 0)
        {
            notes.Add(started.Count + " chapters of progress");
        }

        return (new MangaImportSeriesResult(manga.Title, "imported", toDownload.Count, notes.Count > 0 ? string.Join(" · ", notes) : null), originalFailed);
    }

    // Added to Suwayomi's library with its chapter list: the stored one
    // when it has it (an earlier import or request), else from the source.
    private async Task<IReadOnlyList<SuwayomiChapter>?> LoadChaptersAsync(SuwayomiManga manga, CancellationToken cancellationToken)
    {
        if (!await suwayomi.AddToLibraryAsync(manga.Id, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        var stored = manga.InLibrary ? await suwayomi.GetStoredChaptersAsync(manga.Id, cancellationToken).ConfigureAwait(false) : null;
        return stored is { Count: > 0 } ? stored : await suwayomi.FetchChaptersAsync(manga.Id, cancellationToken).ConfigureAwait(false);
    }

    // The same title on the reader's other installed sources, searched a
    // few at a time; only an exact title match counts, so a different
    // series with a similar name is never picked.
    private async Task<(SuwayomiManga Manga, string SourceName)?> FindElsewhereAsync(MihonManga manga, HashSet<long> downSources, CancellationToken cancellationToken)
    {
        var sources = await suwayomi.GetSourcesAsync(cancellationToken).ConfigureAwait(false);
        var candidates = sources?.Matching.Where(source => source.Id != manga.SourceId && !downSources.Contains(source.Id)).ToList();
        if (candidates is null || candidates.Count == 0)
        {
            return null;
        }

        var wanted = ShelfStore.SeriesKey(manga.Title);
        using var throttle = new SemaphoreSlim(FallbackSearches);
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var searches = candidates.Select(async source =>
        {
            await throttle.WaitAsync(stop.Token).ConfigureAwait(false);
            try
            {
                using var budget = CancellationTokenSource.CreateLinkedTokenSource(stop.Token);
                budget.CancelAfter(FallbackSearchTimeout);
                var results = await suwayomi.SearchAsync(source.Id, manga.Title, budget.Token).ConfigureAwait(false);
                var match = results?.FirstOrDefault(result => ShelfStore.SeriesKey(result.Title) == wanted);
                if (match is not null)
                {
                    await stop.CancelAsync().ConfigureAwait(false);
                }

                return match is null ? ((SuwayomiManga, string)?)null : (match, source.Name);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                return null;
            }
            finally
            {
                throttle.Release();
            }
        }).ToList();

        try
        {
            await Task.WhenAll(searches).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            // Stopped early: one matched.
        }

        return searches
            .Where(search => search.IsCompletedSuccessfully && search.Result is not null)
            .Select(search => search.Result)
            .FirstOrDefault();
    }

    private void OnItemAdded(object? sender, ItemChangeEventArgs e)
    {
        try
        {
            if (e.Item is Book book)
            {
                Apply([book]);
            }
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Jellio: applying Mihon progress to {Item} failed", e.Item?.Name);
        }
    }

    // The chapters Jellyfin already has, e.g. from an earlier download.
    private void ApplyToLibrary(Guid userId)
    {
        if (PendingCount(userId) == 0)
        {
            return;
        }

        var books = libraryManager.GetItemList(new InternalItemsQuery
        {
            IncludeItemTypes = [BaseItemKind.Book],
            Recursive = true,
        }).OfType<Book>().ToList();
        Apply(books);
    }

    private void Apply(IReadOnlyList<Book> books)
    {
        var candidates = books
            .Where(book => !string.IsNullOrEmpty(book.Path) && ComicExtensions.Contains(Path.GetExtension(book.Path), StringComparer.OrdinalIgnoreCase))
            .Select(book => (
                Book: book,
                Series: Normalize(Path.GetFileName(Path.GetDirectoryName(book.Path)) ?? string.Empty),
                File: Normalize(Path.GetFileNameWithoutExtension(book.Path))))
            .ToList();
        if (candidates.Count == 0)
        {
            return;
        }

        var applied = new List<(Guid UserId, Book Book, PendingChapterProgress Entry)>();
        lock (_storeLock)
        {
            var all = LoadLocked();
            var changed = false;
            foreach (var (userKey, entries) in all)
            {
                if (!Guid.TryParseExact(userKey, "N", out var userId))
                {
                    continue;
                }

                foreach (var candidate in candidates)
                {
                    var match = entries
                        .Where(entry => entry.Series == candidate.Series
                            && (candidate.File == entry.Chapter || candidate.File.EndsWith(" " + entry.Chapter, StringComparison.Ordinal)))
                        .OrderByDescending(entry => entry.Chapter.Length)
                        .FirstOrDefault();
                    if (match is not null)
                    {
                        entries.Remove(match);
                        applied.Add((userId, candidate.Book, match));
                        changed = true;
                    }
                }
            }

            if (changed)
            {
                foreach (var key in all.Where(pair => pair.Value.Count == 0).Select(pair => pair.Key).ToList())
                {
                    all.Remove(key);
                }

                SaveLocked(all);
            }
        }

        foreach (var perUser in applied.GroupBy(entry => entry.UserId))
        {
            var bookmarks = perUser.Where(entry => entry.Entry.Bookmark).Select(entry => entry.Book.Id.ToString("N")).ToList();
            if (bookmarks.Count > 0)
            {
                shelfStore.Update(perUser.Key, data => data.Bookmarks.AddRange(bookmarks.Where(id => !data.Bookmarks.Contains(id)).Distinct()));
            }

            // Never over progress made in Jellio itself (keepExisting).
            var progress = perUser
                .Where(entry => entry.Entry.Read || entry.Entry.LastPageRead > 0)
                .Select(entry =>
                {
                    var pages = CountPages(entry.Book.Path);
                    DateTimeOffset? readAt = entry.Entry.LastReadAt > 0 ? DateTimeOffset.FromUnixTimeMilliseconds(entry.Entry.LastReadAt) : null;
                    if (entry.Entry.Read)
                    {
                        return (entry.Book.Id, "page:" + (pages ?? 1), 1d, pages, readAt);
                    }

                    var page = (int)Math.Min(entry.Entry.LastPageRead + 1, pages ?? int.MaxValue);
                    var fraction = pages is > 1 ? (page - 1) / (double)(pages.Value - 1) : 0;
                    return (entry.Book.Id, "page:" + page, Math.Max(fraction, 0.01), pages, readAt);
                })
                .ToList();
            progressStore.SetMany(perUser.Key, progress, keepExisting: true);
        }
    }

    // Progress and bookmarks on the streamed chapters (MangaStreamService
    // ids), straight away. Never over progress made in Jellio itself.
    private void ApplyToStream(Guid userId, MihonManga manga, Func<MihonChapter, SuwayomiChapter?> match)
    {
        var bookmarks = new List<string>();
        var progress = new List<(Guid, string, double, int?, DateTimeOffset?)>();
        foreach (var chapter in manga.Chapters)
        {
            if (match(chapter) is not { } own)
            {
                continue;
            }

            var id = MangaStreamService.ChapterId(own.Id);
            if (chapter.Bookmark)
            {
                bookmarks.Add(id);
            }

            if (!chapter.Read && chapter.LastPageRead <= 0)
            {
                continue;
            }

            DateTimeOffset? readAt = chapter.LastReadAt > 0 ? DateTimeOffset.FromUnixTimeMilliseconds(chapter.LastReadAt) : null;
            var locator = chapter.Read ? "page:1" : "page:" + (chapter.LastPageRead + 1);
            progress.Add((Guid.Parse(id), locator, chapter.Read ? 1 : 0.05, (int?)null, readAt));
        }

        // One save for the whole series; never over progress made in Jellio.
        progressStore.SetMany(userId, progress, keepExisting: true);

        if (bookmarks.Count > 0)
        {
            shelfStore.Update(userId, data => data.Bookmarks.AddRange(bookmarks.Where(id => !data.Bookmarks.Contains(id))));
        }
    }

    // Mihon's categories on the Manga shelf, matched by name so a second
    // import doesn't duplicate them. Returns Mihon order -> category id.
    private Dictionary<long, string> ImportCategories(Guid userId, IReadOnlyList<MihonCategory> categories)
    {
        var ids = new Dictionary<long, string>();
        if (categories.Count == 0)
        {
            return ids;
        }

        shelfStore.Update(userId, data =>
        {
            foreach (var mihon in categories)
            {
                var name = ShelfStore.CleanName(mihon.Name);
                if (name.Length == 0)
                {
                    continue;
                }

                var category = data.Categories.FirstOrDefault(entry => entry.Kind == "manga" && string.Equals(entry.Name, name, StringComparison.OrdinalIgnoreCase));
                if (category is null)
                {
                    if (data.Categories.Count(entry => entry.Kind == "manga") >= ShelfStore.MaxCategories)
                    {
                        continue;
                    }

                    category = new ShelfCategory { Id = ShelfStore.NewId(), Kind = "manga", Name = name };
                    data.Categories.Add(category);
                }

                (category.Sort, category.Descending) = MihonSort(mihon.Flags);
                ids[mihon.Order] = category.Id;
            }
        });
        return ids;
    }

    // Mihon's LibrarySort: type in bits 2 to 5, ascending in bit 6.
    private static (string Sort, bool Descending) MihonSort(long flags)
    {
        var sort = (flags & 0b111100) switch
        {
            0b000100 => "last-read",
            0b001000 or 0b010100 or 0b011000 => "latest",
            0b001100 => "unread",
            0b010000 => "chapters",
            0b011100 => "added",
            _ => "title",
        };
        return (sort, (flags & 0b1000000) == 0);
    }

    // Category membership and the series' own settings, under the key the
    // Manga shelf groups the downloaded chapters by.
    private void ImportShelf(Guid userId, MihonManga manga, string title, Dictionary<long, string> categoryIds)
    {
        var key = ShelfStore.SeriesShelfKey(title);
        if (key.Length <= 2)
        {
            return;
        }

        var inCategories = manga.Categories.Select(order => categoryIds.GetValueOrDefault(order)).OfType<string>().ToHashSet();
        shelfStore.SetInLibrary(userId, key, true);
        shelfStore.Update(userId, data =>
        {
            foreach (var category in data.Categories.Where(entry => entry.Kind == "manga"))
            {
                if (inCategories.Contains(category.Id))
                {
                    if (!category.Items.Contains(key))
                    {
                        category.Items.Add(key);
                    }
                }
                else if (categoryIds.ContainsValue(category.Id))
                {
                    category.Items.Remove(key);
                }
            }

            var prefs = data.Series.GetValueOrDefault(key) ?? new SeriesPrefs();
            prefs.AddedAt = manga.DateAdded > 0 ? manga.DateAdded : prefs.AddedAt;
            prefs.Note = manga.Notes ?? prefs.Note;

            // Mihon's chapter flags: bit 0 ascending, 0x2 unread only,
            // 0x20 bookmarked only.
            prefs.ChapterDescending = (manga.ChapterFlags & 0x1) == 0;
            prefs.ChapterFilter = (manga.ChapterFlags & 0x20) != 0 ? "bookmarked" : (manga.ChapterFlags & 0x2) != 0 ? "unread" : "all";

            // Mihon's reading mode (viewer flags, low 3 bits).
            (prefs.ComicLayout, prefs.ComicDirection) = (manga.ViewerFlags & 0x7) switch
            {
                1 => ("single", "ltr"),
                2 => ("single", "rtl"),
                3 => ("paged-vertical", prefs.ComicDirection),
                4 => ("vertical", prefs.ComicDirection),
                5 => ("vertical-gaps", prefs.ComicDirection),
                _ => (prefs.ComicLayout, prefs.ComicDirection),
            };
            data.Series[key] = prefs;
        });
    }

    private static int? CountPages(string path)
    {
        if (!string.Equals(Path.GetExtension(path), ".cbz", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(Path.GetExtension(path), ".zip", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        try
        {
            using var archive = ZipFile.OpenRead(path);
            var count = archive.Entries.Count(entry => ImageExtensions.Contains(Path.GetExtension(entry.FullName), StringComparer.OrdinalIgnoreCase));
            return count > 0 ? count : null;
        }
        catch (Exception)
        {
            return null;
        }
    }

    private void AddPending(Guid userId, List<PendingChapterProgress> entries)
    {
        if (entries.Count == 0)
        {
            return;
        }

        lock (_storeLock)
        {
            var all = LoadLocked();
            var key = userId.ToString("N");
            var existing = all.GetValueOrDefault(key) ?? [];

            // A re-import replaces what an earlier one recorded.
            existing.RemoveAll(old => entries.Any(entry => entry.Series == old.Series && entry.Chapter == old.Chapter));
            existing.AddRange(entries);
            all[key] = existing;
            SaveLocked(all);
        }
    }

    // Lower case, letters and digits, single spaces: Suwayomi strips
    // characters a file system won't take from its folder and file names.
    private static string Normalize(string text)
    {
        var builder = new StringBuilder(text.Length);
        var space = false;
        foreach (var c in text.ToLowerInvariant())
        {
            if (char.IsLetterOrDigit(c))
            {
                if (space && builder.Length > 0)
                {
                    builder.Append(' ');
                }

                builder.Append(c);
                space = false;
            }
            else
            {
                space = true;
            }
        }

        return builder.ToString();
    }

    private Dictionary<string, List<PendingChapterProgress>> LoadLocked()
    {
        try
        {
            return File.Exists(StorePath)
                ? JsonSerializer.Deserialize<Dictionary<string, List<PendingChapterProgress>>>(File.ReadAllText(StorePath), JsonOptions) ?? new()
                : new();
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: could not read the Mihon import progress store");
            return new();
        }
    }

    private void SaveLocked(Dictionary<string, List<PendingChapterProgress>> all)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(StorePath)!);
        var temp = StorePath + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(all, JsonOptions));
        File.Move(temp, StorePath, true);
    }
}
