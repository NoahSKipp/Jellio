using System;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace Jellio.Services.StreamLinks;

// Proxy addresses carry their own permission: only addresses the server
// handed out (or found inside a playlist it handed out) are fetched, so
// the proxy can't be pointed anywhere else. Players that can't send an
// auth header (Safari's own HLS, plain <video>) still work.
public sealed class StreamProxySigner
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromHours(8);

    private readonly byte[] _key;

    public StreamProxySigner()
        : this(RandomNumberGenerator.GetBytes(32))
    {
    }

    public StreamProxySigner(byte[] key)
    {
        _key = key;
    }

    public string Sign(string url, string referer, long expiresUnix)
    {
        var payload = Encoding.UTF8.GetBytes(url + "\n" + referer + "\n" + expiresUnix.ToString(CultureInfo.InvariantCulture));
        var mac = HMACSHA256.HashData(_key, payload);
        return Convert.ToBase64String(mac, 0, 18).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    public bool Verify(string url, string referer, long expiresUnix, string? signature, DateTimeOffset now)
    {
        if (string.IsNullOrEmpty(signature) || expiresUnix < now.ToUnixTimeSeconds())
        {
            return false;
        }

        var expected = Encoding.ASCII.GetBytes(Sign(url, referer, expiresUnix));
        return CryptographicOperations.FixedTimeEquals(expected, Encoding.ASCII.GetBytes(signature));
    }

    // Relative on purpose: it resolves next to the playlist that holds it,
    // whatever base path the server runs under.
    public string ProxyQuery(Uri url, Uri? referer, long expiresUnix)
    {
        var u = url.AbsoluteUri;
        var r = referer?.AbsoluteUri ?? string.Empty;
        return "proxy?u=" + Uri.EscapeDataString(u)
            + "&r=" + Uri.EscapeDataString(r)
            + "&e=" + expiresUnix.ToString(CultureInfo.InvariantCulture)
            + "&s=" + Sign(u, r, expiresUnix);
    }
}
