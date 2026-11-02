using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;

namespace Jellio.Services;

/// <summary>
/// The embedded web app: file contents as served (CSS without comments
/// or indentation) and the modules the first page load imports.
/// </summary>
public static class FrontendAssets
{
    private const string Prefix = "Jellio.Frontend.";

    private static readonly Assembly Assembly = typeof(FrontendAssets).Assembly;

    private static readonly ConcurrentDictionary<string, byte[]?> Served = new();

    private static readonly Regex StaticImport = new(
        @"^\s*(?:import|export)\s+(?:[^'"";]*?\sfrom\s+)?['""](\.{1,2}/[^'""]+\.js)['""]",
        RegexOptions.Multiline | RegexOptions.Compiled);

    private static readonly Regex CssComment = new(@"/\*.*?\*/", RegexOptions.Singleline | RegexOptions.Compiled);

    private static readonly Lazy<IReadOnlyList<string>> Startup = new(() => ComputeStartupModules("app.js"));

    public static string ResourceName(string path) => Prefix + path.Replace('/', '.');

    public static byte[]? Read(string path) =>
        Served.GetOrAdd(path, p =>
        {
            using var stream = Assembly.GetManifestResourceStream(ResourceName(p));
            if (stream is null)
            {
                return null;
            }

            using var memory = new MemoryStream();
            stream.CopyTo(memory);
            var bytes = memory.ToArray();
            return p.EndsWith(".css", StringComparison.OrdinalIgnoreCase)
                ? Encoding.UTF8.GetBytes(MinifyCss(Encoding.UTF8.GetString(bytes)))
                : bytes;
        });

    public static string MinifyCss(string css)
    {
        var withoutComments = CssComment.Replace(css, string.Empty);
        var lines = withoutComments
            .Split('\n')
            .Select(line => line.Trim())
            .Where(line => line.Length > 0);
        return string.Join('\n', lines) + "\n";
    }

    // Every module app.js reaches through static imports, for modulepreload.
    public static IReadOnlyList<string> StartupModules() => Startup.Value;

    public static IReadOnlyList<string> ComputeStartupModules(string entry)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var queue = new Queue<string>();
        queue.Enqueue(entry);
        while (queue.Count > 0)
        {
            var path = queue.Dequeue();
            if (!seen.Add(path))
            {
                continue;
            }

            var bytes = Read(path);
            if (bytes is null)
            {
                seen.Remove(path);
                continue;
            }

            var directory = path.Contains('/', StringComparison.Ordinal) ? path[..path.LastIndexOf('/')] : string.Empty;
            foreach (Match match in StaticImport.Matches(Encoding.UTF8.GetString(bytes)))
            {
                queue.Enqueue(Resolve(directory, match.Groups[1].Value));
            }
        }

        seen.Remove(entry);
        return seen.OrderBy(p => p, StringComparer.Ordinal).ToList();
    }

    private static string Resolve(string directory, string relative)
    {
        var parts = directory.Length == 0 ? new List<string>() : directory.Split('/').ToList();
        foreach (var segment in relative.Split('/'))
        {
            if (segment == "..")
            {
                if (parts.Count > 0)
                {
                    parts.RemoveAt(parts.Count - 1);
                }
            }
            else if (segment != ".")
            {
                parts.Add(segment);
            }
        }

        return string.Join('/', parts);
    }
}
