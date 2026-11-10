using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Controller;
using MediaBrowser.Model.Plugins;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Jellio.Services.Segments;

// The Intro Skipper plugin's GET /Episode/{id}/Timestamps, the endpoint the
// clients fall back to. It lives in another plugin's load context, so it is
// read over the local API with the caller's own credentials.
public class IntroSkipperTimestamps(
    IHttpClientFactory httpClientFactory,
    IServerApplicationHost appHost,
    IPluginManager pluginManager,
    ILogger<IntroSkipperTimestamps> logger)
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(5);
    private static readonly string[] AuthHeaders = ["Authorization", "X-Emby-Authorization", "X-Emby-Token", "X-MediaBrowser-Token"];

    public bool IsInstalled() =>
        pluginManager.Plugins.Any(p =>
            p.Name.Contains("Intro Skipper", StringComparison.OrdinalIgnoreCase) && p.Manifest.Status == PluginStatus.Active);

    public async Task<IReadOnlyList<NormalizedSegment>> GetAsync(Guid itemId, HttpRequest caller, CancellationToken cancellationToken)
    {
        if (!IsInstalled())
        {
            return [];
        }

        var url = appHost.GetApiUrlForLocalAccess(null, false).TrimEnd('/') + "/Episode/" + itemId.ToString("N") + "/Timestamps";
        if (caller.Query.TryGetValue("api_key", out var apiKey) && !string.IsNullOrEmpty(apiKey))
        {
            url += "?api_key=" + Uri.EscapeDataString(apiKey.ToString());
        }

        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        foreach (var header in AuthHeaders)
        {
            if (caller.Headers.TryGetValue(header, out var value) && !string.IsNullOrEmpty(value))
            {
                request.Headers.TryAddWithoutValidation(header, value.ToString());
            }
        }

        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(Timeout);
            using var response = await httpClientFactory.CreateClient().SendAsync(request, timeout.Token).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                return [];
            }

            await using var body = await response.Content.ReadAsStreamAsync(timeout.Token).ConfigureAwait(false);
            using var document = await JsonDocument.ParseAsync(body, cancellationToken: timeout.Token).ConfigureAwait(false);
            return SkipSegmentNormalizer.FromIntroSkipper(document.RootElement);
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or OperationCanceledException && !cancellationToken.IsCancellationRequested)
        {
            logger.LogWarning(ex, "Jellio: Intro Skipper timestamps lookup failed for {ItemId}", itemId);
            return [];
        }
    }
}
