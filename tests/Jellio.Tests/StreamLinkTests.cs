using System.Net;
using Jellio.Services.StreamLinks;
using Xunit;

namespace Jellio.Tests;

public class StreamLinkTests
{
    private static readonly Uri Page = new("https://example.com/live/channel-one");

    [Theory]
    [InlineData("127.0.0.1")]
    [InlineData("10.1.2.3")]
    [InlineData("172.20.0.5")]
    [InlineData("192.168.1.10")]
    [InlineData("169.254.169.254")]
    [InlineData("100.64.0.1")]
    [InlineData("0.0.0.0")]
    [InlineData("224.0.0.1")]
    [InlineData("::1")]
    [InlineData("fd00::1")]
    [InlineData("fe80::1")]
    [InlineData("::ffff:192.168.1.1")]
    [InlineData("2002:c0a8:0101::1")]
    public void PrivateAddressesAreBlocked(string address)
    {
        Assert.False(PublicAddressGuard.IsPublic(IPAddress.Parse(address)));
    }

    [Theory]
    [InlineData("1.1.1.1")]
    [InlineData("93.184.216.34")]
    [InlineData("2606:4700:4700::1111")]
    public void PublicAddressesAreAllowed(string address)
    {
        Assert.True(PublicAddressGuard.IsPublic(IPAddress.Parse(address)));
    }

    [Theory]
    [InlineData("https://example.com/a.m3u8", true)]
    [InlineData("http://example.com:8080/live", true)]
    [InlineData("ftp://example.com/a.m3u8", false)]
    [InlineData("file:///etc/passwd", false)]
    [InlineData("http://localhost:8096/", false)]
    [InlineData("http://192.168.1.2/a.m3u8", false)]
    [InlineData("http://[::1]/a.m3u8", false)]
    [InlineData("not a link", false)]
    public void OnlyPublicWebLinksParse(string text, bool expected)
    {
        Assert.Equal(expected, PublicAddressGuard.TryParseLink(text, out _));
    }

    [Fact]
    public void RecognisesHlsPlaylists()
    {
        Assert.True(StreamLinkParser.IsHlsPlaylist("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg1.ts\n"));
        Assert.True(StreamLinkParser.IsHlsPlaylist("﻿#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlow/index.m3u8\n"));
        Assert.False(StreamLinkParser.IsHlsPlaylist("#EXTM3U\n#EXTINF:-1,Channel\nhttp://a/b.ts\n"));
        Assert.True(StreamLinkParser.IsChannelList("#EXTM3U\n#EXTINF:-1,Channel\nhttp://a/b.ts\n"));
        Assert.False(StreamLinkParser.IsChannelList("<html></html>"));
    }

    [Fact]
    public void ParsesChannelListsWithAttributes()
    {
        var text = "#EXTM3U\n"
            + "#EXTINF:-1 tvg-id=\"one\" tvg-logo=\"logos/one.png\" group-title=\"News, World\",News One HD\n"
            + "https://cdn.example.com/one/index.m3u8\n"
            + "#EXTINF:-1 tvg-name=\"Sport Two\",\n"
            + "two.ts\n"
            + "#EXTINF:-1,Duplicate\n"
            + "https://cdn.example.com/one/index.m3u8\n"
            + "#EXTINF:-1,Bad scheme\n"
            + "rtmp://example.com/live\n"
            + "https://example.com/streams/bare-stream.m3u8\n";
        var entries = StreamLinkParser.ParseChannelList(text, new Uri("https://example.com/lists/all.m3u"));

        Assert.Equal(3, entries.Count);
        Assert.Equal("News One HD", entries[0].Name);
        Assert.Equal("News, World", entries[0].Group);
        Assert.Equal("https://example.com/lists/logos/one.png", entries[0].Logo);
        Assert.Equal("Sport Two", entries[1].Name);
        Assert.Equal("https://example.com/lists/two.ts", entries[1].Url);
        Assert.Equal("bare-stream", entries[2].Name);
    }

    [Fact]
    public void FindsStreamsInPages()
    {
        var html = "<html><head><meta property=\"og:title\" content=\"Channel One &amp; Friends\"></head><body>"
            + "<script>var config = {\"file\":\"https:\\/\\/cdn.example.net\\/live\\/master.m3u8?token=abc&amp;x=1\"};</script>"
            + "<script>player.setup({ source: '/hls/backup.m3u8' })</script>"
            + "<video><source src=\"/media/clip.mp4\" type=\"video/mp4\"></video>"
            + "<iframe src=\"https://embed.example.org/player/7\"></iframe>"
            + "<a href=\"https://example.com/live/channel-one\">self</a>"
            + "</body></html>";
        var found = StreamLinkParser.FindCandidates(html, Page).Select(u => u.AbsoluteUri).ToList();

        Assert.Equal("https://cdn.example.net/live/master.m3u8?token=abc&x=1", found[0]);
        Assert.Contains("https://example.com/hls/backup.m3u8", found);
        Assert.Contains("https://example.com/media/clip.mp4", found);
        Assert.Equal("https://embed.example.org/player/7", found[^1]);
        Assert.DoesNotContain(Page.AbsoluteUri, found);
        Assert.Equal("Channel One & Friends", StreamLinkParser.PageTitle(html));
    }

    [Fact]
    public void SniffsMediaContainers()
    {
        var ts = new byte[400];
        ts[0] = 0x47;
        ts[188] = 0x47;
        Assert.Equal(StreamFormats.Ts, StreamLinkParser.SniffMedia(ts));
        Assert.Equal(StreamFormats.Mp4, StreamLinkParser.SniffMedia("\0\0\0\u0018ftypisom"u8));
        Assert.Null(StreamLinkParser.SniffMedia("<!doctype html>"u8));
    }

    [Fact]
    public void RewritesEveryPlaylistAddress()
    {
        var playlist = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXTINF:6,\nseg-1.ts?t=1\n#EXTINF:6,\nhttps://other.example.com/seg-2.ts\n";
        var rewritten = StreamLinkParser.RewritePlaylist(playlist, new Uri("https://cdn.example.com/live/index.m3u8"), u => "P(" + u.AbsoluteUri + ")");

        Assert.Contains("URI=\"P(https://cdn.example.com/live/key.bin)\"", rewritten);
        Assert.Contains("\nP(https://cdn.example.com/live/seg-1.ts?t=1)\n", rewritten);
        Assert.Contains("\nP(https://other.example.com/seg-2.ts)\n", rewritten);
        Assert.Contains("#EXT-X-TARGETDURATION:6", rewritten);
    }

    [Fact]
    public void ProxySignaturesOnlyMatchWhatWasSigned()
    {
        var signer = new StreamProxySigner(new byte[32]);
        var now = DateTimeOffset.FromUnixTimeSeconds(1_000_000);
        var expires = now.ToUnixTimeSeconds() + 60;
        var signature = signer.Sign("https://a.example/x.m3u8", "", expires);

        Assert.True(signer.Verify("https://a.example/x.m3u8", "", expires, signature, now));
        Assert.False(signer.Verify("https://a.example/y.m3u8", "", expires, signature, now));
        Assert.False(signer.Verify("https://a.example/x.m3u8", "https://evil.example/", expires, signature, now));
        Assert.False(signer.Verify("https://a.example/x.m3u8", "", expires, signature, now.AddSeconds(120)));
        Assert.False(new StreamProxySigner(Enumerable.Repeat((byte)1, 32).ToArray()).Verify("https://a.example/x.m3u8", "", expires, signature, now));

        var query = signer.ProxyQuery(new Uri("https://a.example/x.m3u8?a=1&b=2"), null, expires);
        Assert.StartsWith("proxy?u=https%3A%2F%2Fa.example%2Fx.m3u8%3Fa%3D1%26b%3D2&r=&e=", query);
    }

    [Fact]
    public void PairingCodesExpireAndThrottleGuessing()
    {
        var now = new DateTime(2026, 10, 28, 12, 0, 0, DateTimeKind.Utc);
        var service = new StreamPairingService(() => now);
        var owner = Guid.NewGuid();
        var pairing = service.Create(owner);

        Assert.Equal(6, pairing.Code.Length);
        Assert.True(service.TryOpen(pairing.Code.ToLowerInvariant(), "phone", out var opened));
        Assert.Same(pairing, opened);
        Assert.NotNull(service.Status(owner, pairing.Code));
        Assert.Null(service.Status(Guid.NewGuid(), pairing.Code));

        for (var i = 0; i < 20; i++)
        {
            Assert.False(service.TryOpen("ZZZZZZ", "guesser", out _));
        }

        Assert.True(service.IsThrottled("guesser"));
        Assert.False(service.TryOpen(pairing.Code, "guesser", out _));
        Assert.False(service.IsThrottled("phone"));

        now = now.AddMinutes(16);
        Assert.False(service.TryOpen(pairing.Code, "phone", out _));
        Assert.Null(service.Status(owner, pairing.Code));
    }
}
