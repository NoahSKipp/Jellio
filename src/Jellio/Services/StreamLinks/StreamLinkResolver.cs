using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellio.Services.StreamLinks;

// Follows a link to something a player can open. Every connection is
// checked against PublicAddressGuard at connect time, so neither a
// redirect nor a DNS answer that changes can reach a private address.
public class StreamLinkResolver : IDisposable
{
    public const string BrowserUserAgent =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

    private const int MaxTextBytes = 4 * 1024 * 1024;
    private const int SniffBytes = 4096;
    // A page that offers several players can need a few dead ends before the right one.
    private const int MaxFetchesPerResolve = 24;
    // Channel page -> player page -> embedded player -> nested player -> the stream itself.
    private const int MaxDepth = 4;
    private static readonly TimeSpan ResolveTimeout = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan CacheLifetime = TimeSpan.FromMinutes(2);

    private readonly ILogger<StreamLinkResolver> _logger;
    private readonly Dictionary<string, (DateTime At, ResolveResult Result)> _cache = new();

    public StreamLinkResolver(ILogger<StreamLinkResolver> logger)
    {
        _logger = logger;
        Client = new HttpClient(CreateHandler(), disposeHandler: true) { Timeout = Timeout.InfiniteTimeSpan };
    }

    // Shared with the proxy: same address checks for every segment.
    public HttpClient Client { get; }

    public static SocketsHttpHandler CreateHandler() => new()
    {
        // A configured outbound proxy would hide the real destination
        // from the check below.
        UseProxy = false,
        AllowAutoRedirect = true,
        MaxAutomaticRedirections = 5,
        AutomaticDecompression = DecompressionMethods.All,
        PooledConnectionLifetime = TimeSpan.FromMinutes(5),
        ConnectTimeout = TimeSpan.FromSeconds(10),
        ConnectCallback = async (context, cancellationToken) =>
        {
            var addresses = await Dns.GetHostAddressesAsync(context.DnsEndPoint.Host, cancellationToken).ConfigureAwait(false);
            if (addresses.Length == 0 || !addresses.All(PublicAddressGuard.IsPublic))
            {
                throw new StreamLinkException(StreamLinkErrors.BlockedAddress);
            }

            var socket = new Socket(SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
            try
            {
                await socket.ConnectAsync(addresses, context.DnsEndPoint.Port, cancellationToken).ConfigureAwait(false);
                return new NetworkStream(socket, ownsSocket: true);
            }
            catch
            {
                socket.Dispose();
                throw;
            }
        },
    };

    public static HttpRequestMessage BuildRequest(Uri url, Uri? referer)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.TryAddWithoutValidation("User-Agent", BrowserUserAgent);
        request.Headers.TryAddWithoutValidation("Accept", "*/*");
        if (referer != null)
        {
            request.Headers.Referrer = referer;
            request.Headers.TryAddWithoutValidation("Origin", referer.GetLeftPart(UriPartial.Authority));
        }

        return request;
    }

    public async Task<ResolveResult> ResolveAsync(Uri url, CancellationToken cancellationToken, bool useCache = true)
    {
        var key = url.AbsoluteUri;
        if (useCache)
        {
            lock (_cache)
            {
                if (_cache.TryGetValue(key, out var hit) && DateTime.UtcNow - hit.At < CacheLifetime)
                {
                    return hit.Result;
                }
            }
        }

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(ResolveTimeout);
        var budget = new Budget();
        var started = DateTime.UtcNow;
        try
        {
            var result = await ResolveInnerAsync(url, null, 0, budget, timeout.Token).ConfigureAwait(false);
            if (result == null)
            {
                // Some sites only put the player on a page that was opened
                // from the site itself, as a browser click-through does.
                // Tried second, so links that already work send nothing new.
                budget = new Budget();
                var home = new Uri(url.GetLeftPart(UriPartial.Authority) + "/");
                result = await ResolveInnerAsync(url, null, 0, budget, timeout.Token, firstReferer: home).ConfigureAwait(false);
            }

            if (result == null)
            {
                throw new StreamLinkException(StreamLinkErrors.NoStream);
            }

            _logger.LogInformation(
                "Jellio stream link resolved on {Host} as {Kind} after {Fetches} fetches in {Ms} ms",
                url.Host,
                result.Stream?.Format ?? "list",
                budget.Used,
                (int)(DateTime.UtcNow - started).TotalMilliseconds);
            lock (_cache)
            {
                if (_cache.Count > 500)
                {
                    _cache.Clear();
                }

                _cache[key] = (DateTime.UtcNow, result);
            }

            return result;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new StreamLinkException(StreamLinkErrors.Timeout);
        }
    }

    private async Task<ResolveResult?> ResolveInnerAsync(Uri url, Uri? referer, int depth, Budget budget, CancellationToken ct, Uri? firstReferer = null)
    {
        if (++budget.Used > MaxFetchesPerResolve)
        {
            return null;
        }

        var fetched = await FetchAsync(url, referer ?? firstReferer, ct).ConfigureAwait(false);
        var finalUri = fetched.FinalUri;
        if (fetched.MediaFormat != null)
        {
            return new ResolveResult(new ResolvedStream(fetched.MediaFormat, finalUri, referer), null, null);
        }

        if (fetched.Text == null)
        {
            return null;
        }

        if (StreamLinkParser.IsHlsPlaylist(fetched.Text))
        {
            return new ResolveResult(new ResolvedStream(StreamFormats.Hls, finalUri, referer), null, null)
            {
                Quality = StreamLinkParser.HlsQuality(fetched.Text),
            };
        }

        if (StreamLinkParser.IsChannelList(fetched.Text))
        {
            var entries = StreamLinkParser.ParseChannelList(fetched.Text, finalUri);
            if (entries.Count == 0)
            {
                return null;
            }

            if (entries.Count == 1 && Uri.TryCreate(entries[0].Url, UriKind.Absolute, out var only))
            {
                return new ResolveResult(new ResolvedStream(StreamLinkParser.FormatFromPath(only), only, referer), null, entries[0].Name);
            }

            return new ResolveResult(null, entries, null);
        }

        if (depth >= MaxDepth)
        {
            return null;
        }

        // The page the user linked describes the stream better than an
        // embedded player page does, so its details come first.
        var page = StreamLinkParser.PageMetadata(fetched.Text, finalUri);
        foreach (var candidate in StreamLinkParser.FindCandidates(fetched.Text, finalUri))
        {
            try
            {
                var inner = await ResolveInnerAsync(candidate, finalUri, depth + 1, budget, ct).ConfigureAwait(false);
                if (inner != null)
                {
                    var metadata = page.Or(inner.Metadata);
                    return inner with { Title = metadata.Title ?? inner.Title, Metadata = metadata };
                }
            }
            catch (StreamLinkException)
            {
            }
            catch (HttpRequestException)
            {
            }
        }

        return null;
    }

    private async Task<Fetched> FetchAsync(Uri url, Uri? referer, CancellationToken ct)
    {
        using var request = BuildRequest(url, referer);
        HttpResponseMessage response;
        try
        {
            response = await Client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
        }
        catch (HttpRequestException err) when (FindLinkError(err) is { } linkError)
        {
            throw linkError;
        }
        catch (HttpRequestException)
        {
            throw new StreamLinkException(StreamLinkErrors.Unreachable);
        }

        using (response)
        {
            if (!response.IsSuccessStatusCode)
            {
                throw new StreamLinkException(StreamLinkErrors.Unreachable, ((int)response.StatusCode).ToString(System.Globalization.CultureInfo.InvariantCulture));
            }

            var finalUri = response.RequestMessage?.RequestUri ?? url;
            await using var body = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            var head = new byte[SniffBytes];
            var headLength = await ReadAtMostAsync(body, head, ct).ConfigureAwait(false);
            var headSpan = head.AsSpan(0, headLength);
            var contentType = response.Content.Headers.ContentType?.MediaType ?? string.Empty;
            if (StreamLinkParser.SniffMedia(headSpan) != null
                || contentType.StartsWith("video/", StringComparison.OrdinalIgnoreCase)
                || contentType.StartsWith("audio/", StringComparison.OrdinalIgnoreCase))
            {
                // Never read a live video stream to the end.
                return new Fetched(finalUri, StreamLinkParser.SniffMedia(headSpan) ?? StreamLinkParser.FormatFromPath(finalUri), null);
            }

            using var all = new MemoryStream();
            all.Write(headSpan);
            var buffer = new byte[16 * 1024];
            while (all.Length < MaxTextBytes)
            {
                var read = await body.ReadAsync(buffer, ct).ConfigureAwait(false);
                if (read == 0)
                {
                    break;
                }

                all.Write(buffer, 0, read);
            }

            var text = Encoding.UTF8.GetString(all.GetBuffer(), 0, (int)Math.Min(all.Length, MaxTextBytes));
            return new Fetched(finalUri, null, text);
        }
    }

    public static StreamLinkException? FindLinkError(Exception err)
    {
        for (Exception? current = err; current != null; current = current.InnerException)
        {
            if (current is StreamLinkException linkError)
            {
                return linkError;
            }
        }

        return null;
    }

    private static async Task<int> ReadAtMostAsync(Stream stream, byte[] buffer, CancellationToken ct)
    {
        var total = 0;
        while (total < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(total), ct).ConfigureAwait(false);
            if (read == 0)
            {
                break;
            }

            total += read;
        }

        return total;
    }

    public void Dispose()
    {
        Client.Dispose();
        GC.SuppressFinalize(this);
    }

    private sealed class Budget
    {
        public int Used { get; set; }
    }

    private sealed record Fetched(Uri FinalUri, string? MediaFormat, string? Text);
}
