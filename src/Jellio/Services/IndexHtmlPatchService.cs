using System.Text.RegularExpressions;
using MediaBrowser.Controller;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellio.Services;

/// <summary>
/// Writes the frontend bootstrap script tag into the web client's index.html so
/// Jellio's own runtime loads without a separate injector plugin. Everything this
/// service touches lives inside a marker comment block, so it never has to own
/// the rest of the file. Same mechanism the original Jellio codebase uses; only
/// what gets loaded (a bootstrap that takes over rendering, not a reskin) differs.
/// </summary>
public class IndexHtmlPatchService(
    IServerApplicationPaths applicationPaths,
    ILogger<IndexHtmlPatchService> logger
) : IHostedService
{
    private const string StartMarker = "<!-- jellio:start";
    private const string EndMarker = "<!-- jellio:end -->";

    private static readonly Regex BlockPattern = new(
        "<!-- jellio:start.*?<!-- jellio:end -->\\s*",
        RegexOptions.Singleline
    );

    public Task StartAsync(CancellationToken cancellationToken)
    {
        var enabled = JellioPlugin.Instance?.Configuration.EnableReskin ?? true;
        if (enabled)
        {
            Apply();
        }
        else
        {
            Remove();
        }

        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    private void Apply()
    {
        var indexPath = Path.Combine(applicationPaths.WebPath, "index.html");
        if (!TryRead(indexPath, out var content))
        {
            return;
        }

        var version =
            JellioPlugin.Instance?.GetType().Assembly.GetName().Version?.ToString() ?? "0.0.0.0";
        var block = BuildBlock(version);

        string updated;
        if (content!.Contains(StartMarker, StringComparison.Ordinal))
        {
            updated = BlockPattern.Replace(content, block, 1);
        }
        else
        {
            var backupPath = indexPath + ".jellio-backup";
            if (!File.Exists(backupPath))
            {
                TryWrite(backupPath, content);
            }

            var bodyClose = content.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
            if (bodyClose < 0)
            {
                logger.LogWarning("Jellio: index.html has no </body>, skipping patch.");
                return;
            }

            updated = content.Insert(bodyClose, block);
        }

        if (updated == content)
        {
            logger.LogInformation(
                "Jellio: index.html already carries the v={Version} script tag at {Path}.",
                version,
                indexPath
            );
            return;
        }

        if (TryWrite(indexPath, updated))
        {
            logger.LogInformation(
                "Jellio: patched index.html at {Path} with the v={Version} script tag.",
                indexPath,
                version
            );
        }
    }

    private void Remove()
    {
        var indexPath = Path.Combine(applicationPaths.WebPath, "index.html");
        if (!TryRead(indexPath, out var content) || !content!.Contains(StartMarker, StringComparison.Ordinal))
        {
            return;
        }

        var updated = BlockPattern.Replace(content, string.Empty);
        TryWrite(indexPath, updated);
    }

    private static string BuildBlock(string version)
    {
        return $"{StartMarker} v={version} -->\n"
            + $"<link rel=\"stylesheet\" href=\"/Jellio/frontend/css/app.css?v={version}\">\n"
            + $"<script type=\"module\" src=\"/Jellio/frontend/app.js?v={version}\"></script>\n"
            + $"{EndMarker}\n";
    }

    private bool TryRead(string path, out string? content)
    {
        try
        {
            if (!File.Exists(path))
            {
                logger.LogWarning("Jellio: index.html not found at {Path}, skipping patch.", path);
                content = null;
                return false;
            }

            content = File.ReadAllText(path);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.LogWarning(
                ex,
                "Jellio: could not read index.html at {Path}, web client will stay unmodified.",
                path
            );
            content = null;
            return false;
        }
    }

    private bool TryWrite(string path, string content)
    {
        try
        {
            File.WriteAllText(path, content);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.LogError(
                ex,
                "Jellio: could not write {Path}. Any jellio script tag already in that file stays as it is, including its version, so the page may report an older release than the one running.",
                path
            );
            return false;
        }
    }
}
