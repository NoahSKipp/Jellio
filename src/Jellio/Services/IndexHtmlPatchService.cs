using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Text.RegularExpressions;
using MediaBrowser.Controller;
using MediaBrowser.Model.Plugins;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellio.Services;

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
        ApplyCurrentConfiguration();

        if (JellioPlugin.Instance is not null)
        {
            JellioPlugin.Instance.ConfigurationChanged += OnConfigurationChanged;
        }

        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        if (JellioPlugin.Instance is not null)
        {
            JellioPlugin.Instance.ConfigurationChanged -= OnConfigurationChanged;
        }

        return Task.CompletedTask;
    }

    private void OnConfigurationChanged(object? sender, BasePluginConfiguration configuration) =>
        ApplyCurrentConfiguration();

    private void ApplyCurrentConfiguration()
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
    }

    private void Apply()
    {
        var indexPath = Path.Combine(applicationPaths.WebPath, "index.html");
        if (!TryRead(indexPath, out var content))
        {
            return;
        }

        var version =
            JellioPlugin.Instance?.GetType().Assembly.GetName().Version?.ToString() ?? "0.0.0.0";
        var block = BuildBlock(version, FindIconFont(applicationPaths.WebPath));

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

    private static string BuildImportMap(string version)
    {
        const string prefix = "Jellio.Frontend.";
        string[] folders = ["runtime", "screens", "components"];
        var imports = new SortedDictionary<string, string>(StringComparer.Ordinal);
        foreach (var name in Assembly.GetExecutingAssembly().GetManifestResourceNames())
        {
            if (!name.StartsWith(prefix, StringComparison.Ordinal) || !name.EndsWith(".js", StringComparison.Ordinal))
            {
                continue;
            }

            var rest = name[prefix.Length..];
            foreach (var folder in folders)
            {
                if (rest.StartsWith(folder + ".", StringComparison.Ordinal))
                {
                    var url = "/Jellio/frontend/" + folder + "/" + rest[(folder.Length + 1)..];
                    imports[url] = url + "?v=" + version;
                }
            }
        }

        return JsonSerializer.Serialize(new { imports });
    }

    public static string? FindIconFont(string webPath)
    {
        try
        {
            if (!Directory.Exists(webPath))
            {
                return null;
            }

            var font = Directory.EnumerateFiles(webPath, "*.woff2", SearchOption.AllDirectories)
                .Select(path => Path.GetRelativePath(webPath, path).Replace('\\', '/'))
                .Where(rel => Path.GetFileName(rel).StartsWith("MaterialIcons-Regular", StringComparison.OrdinalIgnoreCase)
                    || Path.GetFileName(rel).StartsWith("material-icons.", StringComparison.OrdinalIgnoreCase))
                .OrderBy(rel => rel.Length)
                .FirstOrDefault();
            return font;
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static string BuildBlock(string version, string? iconFont = null)
    {
        var preloadLinks = string.Concat(
            FrontendAssets.StartupModules().Select(path =>
                $"<link rel=\"modulepreload\" href=\"/Jellio/frontend/{path}?v={version}\">\n"
            )
        );

        return $"{StartMarker} v={version} -->\n"
            + "<script>\n"
            + EarlySessionCaptureScript
            + BuildLanguagePreloadScript(version)
            + "</script>\n"
            // async: a classic script in <head> held up the whole page until
            // gstatic.com answered. cast.js waits for the SDK's own callback.
            + "<script async src=\"https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1\"></script>\n"
            + (iconFont != null ? $"<link rel=\"preload\" href=\"{iconFont}\" as=\"font\" type=\"font/woff2\" crossorigin>\n" : string.Empty)
            + "<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n"
            + "<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n"
            // Not render blocking: the page paints in the fallback font and
            // switches once Inter arrives, instead of waiting on Google.
            + "<link rel=\"stylesheet\" href=\"https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap\" media=\"print\" onload=\"this.media='all'\">\n"
            + $"<link rel=\"stylesheet\" href=\"/Jellio/frontend/css/app.css?v={version}\">\n"
            + $"<script type=\"importmap\">{BuildImportMap(version)}</script>\n"
            + preloadLinks
            + $"<script type=\"module\" src=\"/Jellio/frontend/app.js?v={version}\"></script>\n"
            + $"{EndMarker}\n";
    }

    // Non-English users need runtime/strings-xx.js before the first render;
    // fetching it now overlaps it with the startup modules.
    internal static string BuildLanguagePreloadScript(string version)
    {
        const string prefix = "Jellio.Frontend.runtime.strings-";
        var codes = Assembly.GetExecutingAssembly().GetManifestResourceNames()
            .Where(name => name.StartsWith(prefix, StringComparison.Ordinal) && name.EndsWith(".js", StringComparison.Ordinal))
            .Select(name => name[prefix.Length..^3])
            .Where(code => code.Length > 0 && code.All(char.IsAsciiLetterLower))
            .OrderBy(code => code, StringComparer.Ordinal)
            .ToList();
        if (codes.Count == 0)
        {
            return string.Empty;
        }

        return "(function () {\n"
            + "  try {\n"
            + "    var lang = localStorage.getItem('jellio_display_language');\n"
            + $"    if ({JsonSerializer.Serialize(codes)}.indexOf(lang) === -1) return;\n"
            + "    var link = document.createElement('link');\n"
            + "    link.rel = 'modulepreload';\n"
            + $"    link.href = '/Jellio/frontend/runtime/strings-' + lang + '.js?v={version}';\n"
            + "    document.head.appendChild(link);\n"
            + "  } catch (e) {}\n"
            + "})();\n";
    }

    private const string EarlySessionCaptureScript =
        @"(function () {
  try {
    var hero = JSON.parse(localStorage.getItem('jellio.heroPreload') || 'null');
    if (hero && hero.url && (hero.route || '') === (location.hash || '')) {
      var link = document.createElement('link');
      link.rel = 'preload';
      link.as = 'image';
      link.href = hero.url;
      link.setAttribute('fetchpriority', 'high');
      document.head.appendChild(link);
    }
  } catch (e) {}
  if (navigator.serviceWorker && navigator.serviceWorker.register) {
    var originalRegister = navigator.serviceWorker.register.bind(navigator.serviceWorker);
    navigator.serviceWorker.register = function (url, options) {
      if (String(url).indexOf('serviceworker.js') !== -1) {
        var scope = (options && options.scope) || new URL('./', window.location.href).pathname;
        return originalRegister('/Jellio/frontend/sw.js', { scope: scope });
      }
      return originalRegister(url, options);
    };
  }
})();
(function () {
  var STORAGE_PREFIX = 'jellio_auth::';
  var SESSION_KEY = STORAGE_PREFIX + 'session';
  var SERVER_ADDRESS_KEY = STORAGE_PREFIX + 'serverAddress';
  function captureServer(server) {
    if (!server || !server.AccessToken || !server.UserId) return;
    fetch(window.location.origin + '/Users/' + server.UserId, {
      headers: { 'X-Emby-Token': server.AccessToken }
    }).then(function (res) {
      return res.ok ? res.json() : null;
    }).then(function (user) {
      if (!user) return;
      try {
        window.localStorage.setItem(SESSION_KEY, JSON.stringify({
          accessToken: server.AccessToken,
          userId: user.Id,
          user: user,
          ts: Date.now()
        }));
        window.localStorage.setItem(SERVER_ADDRESS_KEY, window.location.origin);
      } catch (e) {}
      document.dispatchEvent(new CustomEvent('jellio:session-captured'));
    }).catch(function () {});
  }
  try {
    var rawCreds = window.localStorage.getItem('jellyfin_credentials');
    if (rawCreds) {
      var parsedCreds = JSON.parse(rawCreds);
      var initialServer = parsedCreds && parsedCreds.Servers && parsedCreds.Servers[0];
      if (initialServer) captureServer(initialServer);
    }
  } catch (e) {}
  var marker = 'Stored JSON credentials:';
  var originalLog = console.log;
  console.log = function () {
    try {
      for (var i = 0; i < arguments.length; i++) {
        var arg = arguments[i];
        if (typeof arg === 'string' && arg.indexOf(marker) === 0) {
          var parsed = JSON.parse(arg.slice(marker.length).trim());
          var server = parsed && parsed.Servers && parsed.Servers[0];
          if (server) captureServer(server);
        }
      }
    } catch (err) {}
    return originalLog.apply(console, arguments);
  };
})();
(function () {
  window['__onGCastApiAvailable'] = function (isAvailable) {
    window.__jellioGCastAvailable = Boolean(isAvailable);
    if (typeof window.__jellioOnGCastApiAvailable === 'function') {
      try {
        window.__jellioOnGCastApiAvailable(isAvailable);
      } catch (e) {}
    }
  };
})();
";

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
