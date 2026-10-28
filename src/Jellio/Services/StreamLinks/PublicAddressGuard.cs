using System;
using System.Net;
using System.Net.Sockets;

namespace Jellio.Services.StreamLinks;

// Links come from any user, so the server only ever fetches addresses on
// the public internet: never itself, the LAN or cloud metadata services.
public static class PublicAddressGuard
{
    public static bool IsPublic(IPAddress address)
    {
        if (address.IsIPv4MappedToIPv6)
        {
            address = address.MapToIPv4();
        }

        if (IPAddress.IsLoopback(address))
        {
            return false;
        }

        var b = address.GetAddressBytes();
        if (address.AddressFamily == AddressFamily.InterNetwork)
        {
            return IsPublicV4(b);
        }

        if (address.AddressFamily != AddressFamily.InterNetworkV6)
        {
            return false;
        }

        if (address.Equals(IPAddress.IPv6Any) || address.Equals(IPAddress.IPv6None))
        {
            return false;
        }

        if (address.IsIPv6LinkLocal || address.IsIPv6SiteLocal || address.IsIPv6Multicast)
        {
            return false;
        }

        // Unique local fc00::/7.
        if ((b[0] & 0xfe) == 0xfc)
        {
            return false;
        }

        // 6to4 and NAT64 carry an IPv4 address that must be public too.
        if (b[0] == 0x20 && b[1] == 0x02)
        {
            return IsPublicV4([b[2], b[3], b[4], b[5]]);
        }

        if (b[0] == 0x00 && b[1] == 0x64 && b[2] == 0xff && b[3] == 0x9b)
        {
            return IsPublicV4([b[12], b[13], b[14], b[15]]);
        }

        return true;
    }

    private static bool IsPublicV4(byte[] b) =>
        !(b[0] == 0
            || b[0] == 10
            || b[0] == 127
            || (b[0] == 100 && b[1] >= 64 && b[1] <= 127)
            || (b[0] == 169 && b[1] == 254)
            || (b[0] == 172 && b[1] >= 16 && b[1] <= 31)
            || (b[0] == 192 && b[1] == 168)
            || (b[0] == 192 && b[1] == 0 && b[2] == 0)
            || (b[0] == 198 && (b[1] == 18 || b[1] == 19))
            || b[0] >= 224);

    // Only plain web links, by name rather than raw address where possible.
    public static bool TryParseLink(string? text, out Uri uri)
    {
        uri = null!;
        if (string.IsNullOrWhiteSpace(text) || text.Length > 4096)
        {
            return false;
        }

        if (!Uri.TryCreate(text.Trim(), UriKind.Absolute, out var parsed))
        {
            return false;
        }

        if (parsed.Scheme != Uri.UriSchemeHttp && parsed.Scheme != Uri.UriSchemeHttps)
        {
            return false;
        }

        if (string.IsNullOrEmpty(parsed.Host) || parsed.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        if (IPAddress.TryParse(parsed.Host.Trim('[', ']'), out var literal) && !IsPublic(literal))
        {
            return false;
        }

        uri = parsed;
        return true;
    }
}
