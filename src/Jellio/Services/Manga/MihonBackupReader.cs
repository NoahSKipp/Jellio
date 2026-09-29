using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;

namespace Jellio.Services.Manga;

public record MihonChapter(string Url, string Name, string? Scanlator, bool Read, bool Bookmark, long LastPageRead, float ChapterNumber)
{
    // Unix milliseconds of the last time the chapter was opened (from
    // the backup's history), 0 when never.
    public long LastReadAt { get; init; }
}

public record MihonManga(long SourceId, string SourceName, string Url, string Title, bool Favorite, IReadOnlyList<MihonChapter> Chapters)
{
    // Category orders (BackupCategory.order), how Mihon links the two.
    public IReadOnlyList<long> Categories { get; init; } = [];

    public long DateAdded { get; init; }

    public int ChapterFlags { get; init; }

    public int ViewerFlags { get; init; }

    public IReadOnlyList<string> ExcludedScanlators { get; init; } = [];

    public string? Notes { get; init; }
}

// Flags: Mihon's library sort for the category (type bits 2 to 5,
// ascending bit 6).
public record MihonCategory(string Name, long Order, long Flags);

public record MihonBackup(IReadOnlyList<MihonManga> Manga, IReadOnlyList<MihonCategory> Categories);

/// <summary>
/// Reads a Mihon/Tachiyomi backup (.tachibk: gzip-compressed protobuf).
/// Only the fields an import needs are decoded; everything else is
/// skipped by wire type. Field numbers are Mihon's own @ProtoNumber
/// values (data/backup/models: Backup, BackupManga, BackupChapter,
/// BackupSource). Mihon leaves out fields that hold their default, so
/// missing fields take Mihon's defaults (favorite is true).
/// </summary>
public static class MihonBackupReader
{
    public static MihonBackup Read(byte[] data)
    {
        var bytes = IsGzip(data) ? Gunzip(data) : data;
        var mangaMessages = new List<byte[]>();
        var sourceNames = new Dictionary<long, string>();
        var categories = new List<MihonCategory>();

        foreach (var (field, value) in Fields(bytes))
        {
            if (field == 1 && value is byte[] manga)
            {
                mangaMessages.Add(manga);
            }
            else if (field == 2 && value is byte[] category && ReadCategory(category) is { } parsed)
            {
                categories.Add(parsed);
            }
            else if (field == 101 && value is byte[] source)
            {
                string? name = null;
                long id = 0;
                foreach (var (sourceField, sourceValue) in Fields(source))
                {
                    if (sourceField == 1 && sourceValue is byte[] nameBytes)
                    {
                        name = Encoding.UTF8.GetString(nameBytes);
                    }
                    else if (sourceField == 2 && sourceValue is ulong sourceId)
                    {
                        id = (long)sourceId;
                    }
                }

                if (name is not null)
                {
                    sourceNames[id] = name;
                }
            }
        }

        var manga = mangaMessages.Select(message => ReadManga(message, sourceNames)).OfType<MihonManga>().ToList();
        return new MihonBackup(manga, categories.OrderBy(category => category.Order).ToList());
    }

    private static MihonCategory? ReadCategory(byte[] message)
    {
        string? name = null;
        long order = 0, flags = 0;
        foreach (var (field, value) in Fields(message))
        {
            switch (field)
            {
                case 1 when value is byte[] text:
                    name = Encoding.UTF8.GetString(text);
                    break;
                case 2 when value is ulong number:
                    order = (long)number;
                    break;
                case 100 when value is ulong number:
                    flags = (long)number;
                    break;
            }
        }

        return string.IsNullOrWhiteSpace(name) ? null : new MihonCategory(name.Trim(), order, flags);
    }

    // BackupHistory: chapter url -> last read.
    private static void ReadHistory(byte[] message, Dictionary<string, long> history)
    {
        string? url = null;
        long lastRead = 0;
        foreach (var (field, value) in Fields(message))
        {
            if (field == 1 && value is byte[] text)
            {
                url = Encoding.UTF8.GetString(text);
            }
            else if (field == 2 && value is ulong time)
            {
                lastRead = (long)time;
            }
        }

        if (url is not null && lastRead > 0)
        {
            history[url] = Math.Max(lastRead, history.GetValueOrDefault(url));
        }
    }

    private static MihonManga? ReadManga(byte[] message, Dictionary<long, string> sourceNames)
    {
        long source = 0;
        string? url = null, title = null;
        var favorite = true;
        var chapters = new List<MihonChapter>();
        var categories = new List<long>();
        var history = new Dictionary<string, long>(StringComparer.Ordinal);
        var excluded = new List<string>();
        long dateAdded = 0;
        int chapterFlags = 0, viewerFlags = 0;
        string? notes = null;
        foreach (var (field, value) in Fields(message))
        {
            switch (field)
            {
                case 1 when value is ulong number:
                    source = (long)number;
                    break;
                case 2 when value is byte[] text:
                    url = Encoding.UTF8.GetString(text);
                    break;
                case 3 when value is byte[] text:
                    title = Encoding.UTF8.GetString(text);
                    break;
                case 16 when value is byte[] chapter:
                    if (ReadChapter(chapter) is { } parsed)
                    {
                        chapters.Add(parsed);
                    }

                    break;
                case 13 when value is ulong time:
                    dateAdded = (long)time;
                    break;
                case 17 when value is ulong order:
                    categories.Add((long)order);
                    break;
                case 17 when value is byte[] packed:
                    categories.AddRange(PackedVarints(packed));
                    break;
                case 100 when value is ulong flag:
                    favorite = flag != 0;
                    break;
                case 101 when value is ulong flags:
                    chapterFlags = (int)flags;
                    break;
                case 103 when value is ulong flags:
                    viewerFlags = (int)flags;
                    break;
                case 104 when value is byte[] entry:
                    ReadHistory(entry, history);
                    break;
                case 108 when value is byte[] text:
                    excluded.Add(Encoding.UTF8.GetString(text));
                    break;
                case 110 when value is byte[] text:
                    notes = Encoding.UTF8.GetString(text);
                    break;
            }
        }

        if (url is null || title is null)
        {
            return null;
        }

        var withHistory = chapters
            .Select(chapter => history.TryGetValue(chapter.Url, out var lastRead) ? chapter with { LastReadAt = lastRead } : chapter)
            .ToList();
        return new MihonManga(source, sourceNames.GetValueOrDefault(source) ?? source.ToString(System.Globalization.CultureInfo.InvariantCulture), url, title, favorite, withHistory)
        {
            Categories = categories,
            DateAdded = dateAdded,
            ChapterFlags = chapterFlags,
            ViewerFlags = viewerFlags,
            ExcludedScanlators = excluded,
            Notes = string.IsNullOrWhiteSpace(notes) ? null : notes.Trim(),
        };
    }

    private static MihonChapter? ReadChapter(byte[] message)
    {
        string? url = null, name = null, scanlator = null;
        bool read = false, bookmark = false;
        long lastPageRead = 0;
        var chapterNumber = 0f;
        foreach (var (field, value) in Fields(message))
        {
            switch (field)
            {
                case 1 when value is byte[] text:
                    url = Encoding.UTF8.GetString(text);
                    break;
                case 2 when value is byte[] text:
                    name = Encoding.UTF8.GetString(text);
                    break;
                case 3 when value is byte[] text:
                    scanlator = Encoding.UTF8.GetString(text);
                    break;
                case 4 when value is ulong flag:
                    read = flag != 0;
                    break;
                case 5 when value is ulong flag:
                    bookmark = flag != 0;
                    break;
                case 6 when value is ulong page:
                    lastPageRead = (long)page;
                    break;
                case 9 when value is uint bits:
                    chapterNumber = BitConverter.Int32BitsToSingle((int)bits);
                    break;
            }
        }

        return url is null || name is null ? null : new MihonChapter(url, name, scanlator, read, bookmark, lastPageRead, chapterNumber);
    }

    // Protobuf wire format: varints come back as ulong, 32-bit fixed as
    // uint, 64-bit fixed as ulong, length-delimited as byte[].
    private static IEnumerable<(int Field, object Value)> Fields(byte[] buffer)
    {
        var position = 0;
        while (position < buffer.Length)
        {
            var key = ReadVarint(buffer, ref position);
            var field = (int)(key >> 3);
            switch ((int)(key & 7))
            {
                case 0:
                    yield return (field, ReadVarint(buffer, ref position));
                    break;
                case 1:
                    Require(buffer, position, 8);
                    yield return (field, BitConverter.ToUInt64(buffer, position));
                    position += 8;
                    break;
                case 2:
                    var length = checked((int)ReadVarint(buffer, ref position));
                    Require(buffer, position, length);
                    yield return (field, buffer[position..(position + length)]);
                    position += length;
                    break;
                case 5:
                    Require(buffer, position, 4);
                    yield return (field, BitConverter.ToUInt32(buffer, position));
                    position += 4;
                    break;
                default:
                    throw new InvalidDataException("Not a Mihon backup (unsupported protobuf wire type)");
            }
        }
    }

    private static IEnumerable<long> PackedVarints(byte[] buffer)
    {
        var position = 0;
        var values = new List<long>();
        while (position < buffer.Length)
        {
            values.Add((long)ReadVarint(buffer, ref position));
        }

        return values;
    }

    private static ulong ReadVarint(byte[] buffer, ref int position)
    {
        ulong result = 0;
        for (var shift = 0; shift < 64; shift += 7)
        {
            Require(buffer, position, 1);
            var b = buffer[position++];
            result |= (ulong)(b & 0x7F) << shift;
            if ((b & 0x80) == 0)
            {
                return result;
            }
        }

        throw new InvalidDataException("Not a Mihon backup (malformed varint)");
    }

    private static void Require(byte[] buffer, int position, int length)
    {
        if (length < 0 || position + length > buffer.Length)
        {
            throw new InvalidDataException("Not a Mihon backup (truncated)");
        }
    }

    private static bool IsGzip(byte[] data) => data.Length > 2 && data[0] == 0x1F && data[1] == 0x8B;

    private static byte[] Gunzip(byte[] data)
    {
        using var input = new GZipStream(new MemoryStream(data), CompressionMode.Decompress);
        using var output = new MemoryStream();

        // Backups are small; cap the expansion so a hostile upload can't
        // exhaust memory.
        var buffer = new byte[81920];
        int read;
        while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
        {
            output.Write(buffer, 0, read);
            if (output.Length > 256L * 1024 * 1024)
            {
                throw new InvalidDataException("Backup is too large");
            }
        }

        return output.ToArray();
    }
}
