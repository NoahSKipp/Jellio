using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Text.RegularExpressions;
using MediaBrowser.Controller;
using MediaBrowser.Model.Plugins;
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
        ApplyCurrentConfiguration();

        // The config page's own "Enable reskin" checkbox used to have no
        // effect until the next full server restart: this only ran once,
        // here, at startup. Real event, confirmed against
        // BasePlugin<T>.UpdateConfiguration before writing this, fired the
        // moment the config page's own save call lands server side, not
        // guessed at.
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

    // Every module under runtime/, screens/ and components/, requested
    // as <file>?v=<version> through an import map. Only app.js and
    // app.css carried a version, so after an update a browser, a service
    // worker or a CDN could keep serving the previous release's copy of
    // any module app.js imports (a Settings page without the new card),
    // mixing old code into new. The map is keyed by the plain URL every
    // import resolves to, so modules keep a single identity.
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

    // jellyfin-web's Material Icons font, which every Jellio icon outside
    // the inline SVGs draws with. The browser only asks for it once the
    // page is drawing, so those icons stayed blank for a moment on every
    // load; a preload starts it with the page instead. Relative to
    // index.html, so a base URL prefix still resolves.
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
            + "</script>\n"
            // async: a classic script in <head> held up the whole page until
            // gstatic.com answered. cast.js waits for the SDK's own callback.
            + "<script async src=\"https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1\"></script>\n"
            // css/app.css's own --jellio-font-family names Inter first,
            // real feedback was that the sidebar (and everything else)
            // never actually looked like it, every device this renders on
            // falling straight through to its own fallback stack instead:
            // nothing ever linked the real webfont itself. A client with
            // no real path to fonts.googleapis.com still gets that same
            // fallback stack it always has, no worse off than before.
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

    // Captures a native login's own token the moment jellyfin-apiclient-javascript's
    // own Credentials constructor logs it ("Stored JSON credentials: {...}",
    // real source: credentials.js's own initialize(), called once per real
    // ConnectionManager construction, confirmed real before writing this),
    // so runtime/auth.js finds a session already sitting in localStorage by
    // the time it runs. Has to be a plain, non-deferred, non-module script:
    // main.jellyfin.bundle.js (and the one-time log this depends on) is
    // itself a deferred script, and every deferred/module script on the
    // page executes strictly in document order only after parsing
    // finishes. The bootstrap script this same block also injects is a
    // module and sits last in the document, so by the time it would run,
    // that log line has already fired and is gone forever, real bug found
    // on a live install: app.js loaded and ran with no errors, this
    // runtime just never saw a session, the whole page did nothing.
    // A plain script has none of that deferral, it runs synchronously at
    // its own position in the markup regardless of what else is deferred
    // around it, so it always installs before jellyfin-web's own bundle
    // does. Deliberately not an ES module: no import/export syntax
    // available at this point, self contained on purpose. Keeps the same
    // localStorage shape runtime/auth.js's own setSession writes, so
    // auth.js needs no changes to find what this captures, and dispatches
    // a real DOM event once it does, since the async fetch to resolve the
    // full user object can still finish after app.js's own first sync().
    private const string EarlySessionCaptureScript =
        @"(function () {
  // The hero backdrop the home screen showed first last time, fetched
  // now rather than after the app's code and the hero list have loaded
  // (components/heroCarousel.js stores it).
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
  // Jellio's service worker (Frontend/sw.js, offline support) takes the
  // place of jellyfin-web's: one worker per page scope, and Jellio's loads
  // jellyfin-web's own inside it. Swapped here, before jellyfin-web's
  // bundle asks for its own.
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
