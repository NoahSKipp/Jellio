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
    ILibraryManager libraryManager,
    IApplicationPaths applicationPaths,
    ILogger<MangaImportService> logger) : IHostedService
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = false };
    private static readonly string[] ComicExtensions = [".cbz", ".cbr", ".cb7", ".cbt", ".zip"];
    private static readonly string[] ImageExtensions = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp"];

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
            foreach (var manga in library)
            {
                MangaImportSeriesResult result;
                try
                {
                    using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(2));
                    result = await ImportSeriesAsync(userId, manga, categoryIds, timeout.Token).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    logger.LogWarning(ex, "Jellio: Mihon import of {Title} failed", manga.Title);
                    result = new MangaImportSeriesResult(manga.Title, "error", 0, "Suwayomi didn't answer in time");
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

    private async Task<MangaImportSeriesResult> ImportSeriesAsync(Guid userId, MihonManga manga, Dictionary<long, string> categoryIds, CancellationToken cancellationToken)
    {
        var found = await suwayomi.FindMangaAsync(manga.SourceId, manga.Url, manga.Title, cancellationToken).ConfigureAwait(false);
        ImportShelf(userId, manga, found?.Title ?? manga.Title, categoryIds);
        if (found is null)
        {
            return new MangaImportSeriesResult(manga.Title, "not-found", 0, "Not found on " + manga.SourceName + ". Is that extension installed in Suwayomi?");
        }

        if (!await suwayomi.AddToLibraryAsync(found.Id, cancellationToken).ConfigureAwait(false))
        {
            return new MangaImportSeriesResult(manga.Title, "error", 0, "Suwayomi couldn't add it to its library");
        }

        var chapters = await suwayomi.FetchChaptersAsync(found.Id, cancellationToken).ConfigureAwait(false);
        if (chapters is null)
        {
            return new MangaImportSeriesResult(manga.Title, "error", 0, "Suwayomi couldn't load its chapters");
        }

        // Where they left off: the furthest chapter they finished or
        // opened. Nothing read yet means the whole series.
        var started = manga.Chapters.Where(chapter => chapter.Read || chapter.LastPageRead > 0).ToList();
        var numbered = started.Where(chapter => chapter.ChapterNumber >= 0).ToList();
        float? resumeAt = numbered.Count > 0 ? numbered.Max(chapter => chapter.ChapterNumber) : null;
        var excluded = new HashSet<string>(manga.ExcludedScanlators, StringComparer.OrdinalIgnoreCase);
        var toDownload = chapters
            .Where(chapter => !chapter.IsDownloaded && (resumeAt is null || chapter.ChapterNumber >= resumeAt.Value))
            .Where(chapter => excluded.Count == 0 || !excluded.Contains(chapter.Scanlator ?? string.Empty))
            .Select(chapter => chapter.Id)
            .ToList();
        if (!await suwayomi.EnqueueDownloadsAsync(toDownload, cancellationToken).ConfigureAwait(false))
        {
            return new MangaImportSeriesResult(manga.Title, "error", 0, "Suwayomi couldn't queue the downloads");
        }

        // Named the way Suwayomi names the files: its own chapter record
        // for the same URL when it has one.
        var byUrl = chapters.GroupBy(chapter => chapter.Url, StringComparer.Ordinal).ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);
        var progress = manga.Chapters
            .Where(chapter => chapter.Read || chapter.LastPageRead > 0 || chapter.Bookmark)
            .Select(chapter => new PendingChapterProgress
            {
                Series = Normalize(found.Title),
                Chapter = Normalize(byUrl.TryGetValue(chapter.Url, out var own) ? own.Name : chapter.Name),
                Read = chapter.Read,
                LastPageRead = chapter.LastPageRead,
                Bookmark = chapter.Bookmark,
                LastReadAt = chapter.LastReadAt,
            })
            .Where(entry => entry.Series.Length > 0 && entry.Chapter.Length > 0)
            .ToList();
        AddPending(userId, progress);

        return new MangaImportSeriesResult(
            manga.Title,
            "imported",
            toDownload.Count,
            started.Count > 0 ? started.Count + " chapters of progress" : null);
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

        foreach (var (userId, book, entry) in applied)
        {
            if (entry.Bookmark)
            {
                var key = book.Id.ToString("N");
                shelfStore.Update(userId, data =>
                {
                    if (!data.Bookmarks.Contains(key))
                    {
                        data.Bookmarks.Add(key);
                    }
                });
            }

            // Never overwrite progress made in Jellio itself.
            if ((!entry.Read && entry.LastPageRead <= 0) || progressStore.Get(userId, book.Id) is not null)
            {
                continue;
            }

            var pages = CountPages(book.Path);
            DateTimeOffset? readAt = entry.LastReadAt > 0 ? DateTimeOffset.FromUnixTimeMilliseconds(entry.LastReadAt) : null;
            if (entry.Read)
            {
                progressStore.Set(userId, book.Id, "page:" + (pages ?? 1), 1, pages, readAt);
            }
            else
            {
                var page = (int)Math.Min(entry.LastPageRead + 1, pages ?? int.MaxValue);
                var fraction = pages is > 1 ? (page - 1) / (double)(pages.Value - 1) : 0;
                progressStore.Set(userId, book.Id, "page:" + page, Math.Max(fraction, 0.01), pages, readAt);
            }
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
                3 or 4 or 5 => ("vertical", prefs.ComicDirection),
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
