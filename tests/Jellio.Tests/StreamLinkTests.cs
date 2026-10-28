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
    public void FindsSignedStreamInNestedPlayerConfig()
    {
        // A player page that keeps its signed playlist in an inline config
        // object with escaped slashes, one level below the page the user linked.
        var player = new Uri("https://player.example.net/player/channel-one");
        var html = "<script>window.cfg = { streamUrl: \"https:\\/\\/ds1.cdn.example.org\\/channel-one\\/index.m3u8?t=abc.def&e=1\", tokenExpiresIn: 300 };</script>";
        var found = StreamLinkParser.FindCandidates(html, player).Select(u => u.AbsoluteUri).ToList();

        Assert.Equal("https://ds1.cdn.example.org/channel-one/index.m3u8?t=abc.def&e=1", found[0]);
    }

    [Fact]
    public void FollowsPlayerButtonsAfterIframes()
    {
        var page = new Uri("https://example.com/watch.php?id=9");
        var html = "<iframe src=\"/stream/stream-9.php\"></iframe>"
            + "<button class=\"player-btn\" data-url=\"https://example.com/stream/stream-9.php\">Player 1</button>"
            + "<button class=\"player-btn\" data-url=\"https://example.com/player/stream-9.php\">Player 2</button>";
        var found = StreamLinkParser.FindCandidates(html, page).Select(u => u.AbsoluteUri).ToList();

        Assert.Equal(new[] { "https://example.com/stream/stream-9.php", "https://example.com/player/stream-9.php" }, found);
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

public class StreamLinkMetadataTests
{
    [Fact]
    public void ReadsPageDetailsInAnyAttributeOrder()
    {
        var html = "<html><head><title>Fallback title</title>"
            + "<meta content=\"Live football all day\" property=\"og:description\">"
            + "<meta name=\"description\" content=\"Plain description\">"
            + "<meta property=\"og:site_name\" content=\"Example Sports\">"
            + "<meta property=\"og:image\" content=\"/img/cover.jpg\">"
            + "<link rel=\"icon\" href=\"/favicon.ico\">"
            + "</head></html>";
        var meta = Jellio.Services.StreamLinks.StreamLinkParser.PageMetadata(html, new Uri("https://example.com/live/1"));

        Assert.Equal("Fallback title", meta.Title);
        Assert.Equal("Live football all day", meta.Description);
        Assert.Equal("Example Sports", meta.SiteName);
        Assert.Equal("https://example.com/img/cover.jpg", meta.ImageUrl);
    }

    [Fact]
    public void FallsBackToIconsAndSkipsPlainHttpImages()
    {
        var html = "<meta property=\"og:image\" content=\"http://insecure.example/a.jpg\">"
            + "<link href=\"/icon-180.png\" rel=\"apple-touch-icon\"><link rel=\"shortcut icon\" href=\"/favicon.ico\">";
        var meta = Jellio.Services.StreamLinks.StreamLinkParser.PageMetadata(html, new Uri("https://example.com/"));

        Assert.Equal("https://example.com/icon-180.png", meta.ImageUrl);
        Assert.Null(meta.Description);
        Assert.Null(meta.Title);
    }

    [Fact]
    public void DescriptionsAreTidiedAndCapped()
    {
        var html = "<meta name=\"description\" content=\"  Lots   of\n spaces &amp; " + new string('x', 400) + "\">";
        var meta = Jellio.Services.StreamLinks.StreamLinkParser.PageMetadata(html, new Uri("https://example.com/"));

        Assert.StartsWith("Lots of spaces & xx", meta.Description);
        Assert.EndsWith("…", meta.Description);
        Assert.True(meta.Description!.Length <= 301);
    }

    [Theory]
    [InlineData("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\nhigh.m3u8\n", "1080p")]
    [InlineData("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=20000000,RESOLUTION=3840x2160\nuhd.m3u8\n", "4K")]
    [InlineData("#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg.ts\n", null)]
    public void ReadsTheBestQuality(string playlist, string? expected)
    {
        Assert.Equal(expected, Jellio.Services.StreamLinks.StreamLinkParser.HlsQuality(playlist));
    }

    [Fact]
    public void MetadataPrefersWhatItAlreadyHas()
    {
        var page = new Jellio.Services.StreamLinks.StreamLinkMetadata("Page", null, "https://a/i.png", null);
        var player = new Jellio.Services.StreamLinks.StreamLinkMetadata("Player", "From the player", "https://b/i.png", "Player site");
        var merged = page.Or(player);

        Assert.Equal("Page", merged.Title);
        Assert.Equal("From the player", merged.Description);
        Assert.Equal("https://a/i.png", merged.ImageUrl);
        Assert.Equal("Player site", merged.SiteName);
    }
}

public class StreamLinkStoreTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "jellio-links-" + Guid.NewGuid().ToString("N"));
    private readonly Jellio.Services.StreamLinks.StreamLinkStore _store;
    private readonly Guid _user = Guid.NewGuid();

    public StreamLinkStoreTests()
    {
        _store = new Jellio.Services.StreamLinks.StreamLinkStore(PathsProxy.Create(_dir));
    }

    public void Dispose()
    {
        if (Directory.Exists(_dir))
        {
            Directory.Delete(_dir, true);
        }
    }

    private static Jellio.Services.StreamLinks.ResolveResult Playlist(params string[] urls) =>
        new(null, urls.Select(u => new Jellio.Services.StreamLinks.StreamLinkEntry { Name = u, Url = u }).ToList(), null)
        {
            Metadata = new Jellio.Services.StreamLinks.StreamLinkMetadata("T", "Desc", "https://a/i.png", "Site"),
        };

    [Fact]
    public void LinksTurnFailingOnTheSecondMissAndRecover()
    {
        var link = _store.Add(_user, "https://a/list.m3u", "List", Playlist("https://a/1", "https://a/2"));
        Assert.Equal("ok", link.Health);
        Assert.Equal("Desc", link.Description);

        Assert.False(_store.RecordCheck(_user, link.Id, "unreachable", 2));
        Assert.Equal("ok", _store.Get(_user, link.Id)!.Health);
        Assert.True(_store.RecordCheck(_user, link.Id, "unreachable", 2));
        Assert.Equal("failing", _store.Get(_user, link.Id)!.Health);
        // Already failing: no second notification.
        Assert.False(_store.RecordCheck(_user, link.Id, "timeout", 2));
        Assert.Equal("timeout", _store.Get(_user, link.Id)!.LastError);

        Assert.False(_store.RecordCheck(_user, link.Id, null, 2));
        var healed = _store.Get(_user, link.Id)!;
        Assert.Equal("ok", healed.Health);
        Assert.Equal(0, healed.FailedChecks);
        Assert.Null(healed.LastError);
    }

    [Fact]
    public void RemovedChannelsStayGoneAfterARefresh()
    {
        var link = _store.Add(_user, "https://a/list.m3u", "List", Playlist("https://a/1", "https://a/2", "https://a/3"));
        Assert.True(_store.RemoveEntry(_user, link.Id, 1));
        Assert.False(_store.RemoveEntry(_user, link.Id, 9));
        Assert.Equal(new[] { "https://a/1", "https://a/3" }, _store.Get(_user, link.Id)!.Entries.Select(e => e.Url));

        var refreshed = _store.Refresh(_user, link.Id, Playlist("https://a/3", "https://a/2", "https://a/4") with { Metadata = Jellio.Services.StreamLinks.StreamLinkMetadata.Empty });
        Assert.Equal(new[] { "https://a/3", "https://a/4" }, refreshed!.Entries.Select(e => e.Url));
        // A refresh without page details keeps the ones it had.
        Assert.Equal("Desc", refreshed.Description);
    }

    private class PathsProxy : System.Reflection.DispatchProxy
    {
        private string _dir = string.Empty;

        public static MediaBrowser.Common.Configuration.IApplicationPaths Create(string dir)
        {
            var proxy = Create<MediaBrowser.Common.Configuration.IApplicationPaths, PathsProxy>();
            ((PathsProxy)(object)proxy)._dir = dir;
            return proxy;
        }

        protected override object? Invoke(System.Reflection.MethodInfo? targetMethod, object?[]? args) => _dir;
    }
}

public class LiveChannelHealthTests : IDisposable
{
    private readonly string _path = Path.Combine(Path.GetTempPath(), "jellio-health-" + Guid.NewGuid().ToString("N"), "h.json");
    private DateTime _now = new(2026, 10, 28, 12, 0, 0, DateTimeKind.Utc);

    public void Dispose()
    {
        var dir = Path.GetDirectoryName(_path)!;
        if (Directory.Exists(dir))
        {
            Directory.Delete(dir, true);
        }
    }

    private Jellio.Services.LiveChannelHealthStore NewStore() => new(_path, () => _now);

    [Fact]
    public void TwoFailuresMarkAChannelAndASuccessClearsIt()
    {
        var store = NewStore();
        store.Report("ch1", false, "timeout");
        Assert.Empty(store.Broken());
        store.Report("ch1", false, "timeout");
        Assert.Equal("failing", store.Broken()["ch1"].Status);

        // Survives a restart.
        Assert.True(NewStore().Broken().ContainsKey("ch1"));

        store.Report("ch1", true, null);
        Assert.Empty(store.Broken());
        store.Report("ch2", true, null);
        Assert.Empty(store.Broken());
    }

    [Fact]
    public void MarksLapseAfterADay()
    {
        var store = NewStore();
        store.Report("ch1", false, null);
        store.Report("ch1", false, null);
        _now = _now.AddHours(23);
        Assert.Single(store.Broken());
        _now = _now.AddHours(2);
        Assert.Empty(store.Broken());
    }
}

public class StreamLinkAutoRemoveTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "jellio-autoremove-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_dir))
        {
            Directory.Delete(_dir, true);
        }
    }

    [Fact]
    public void OnlyLinksFailingSinceBeforeTheCutoffGo()
    {
        var store = new Jellio.Services.StreamLinks.StreamLinkStore(StreamLinkStoreTestsPaths.Create(_dir));
        var user = Guid.NewGuid();
        var stream = new Jellio.Services.StreamLinks.ResolveResult(new Jellio.Services.StreamLinks.ResolvedStream("hls", new Uri("https://a/x.m3u8"), null), null, null);
        var broken = store.Add(user, "https://a/1", "Broken", stream);
        var fine = store.Add(user, "https://a/2", "Fine", stream);
        store.RecordCheck(user, broken.Id, "unreachable", 1);

        Assert.Empty(store.RemoveFailingSince(user, DateTime.UtcNow.AddDays(-1)));
        var removed = store.RemoveFailingSince(user, DateTime.UtcNow.AddMinutes(1));
        Assert.Equal(new[] { "Broken" }, removed.Select(l => l.Name));
        Assert.Equal(new[] { fine.Id }, store.List(user).Select(l => l.Id));
    }
}

internal class StreamLinkStoreTestsPaths : System.Reflection.DispatchProxy
{
    private string _dir = string.Empty;

    public static MediaBrowser.Common.Configuration.IApplicationPaths Create(string dir)
    {
        var proxy = Create<MediaBrowser.Common.Configuration.IApplicationPaths, StreamLinkStoreTestsPaths>();
        ((StreamLinkStoreTestsPaths)(object)proxy)._dir = dir;
        return proxy;
    }

    protected override object? Invoke(System.Reflection.MethodInfo? targetMethod, object?[]? args) => _dir;
}

public class LiveWatchingTests
{
    private static Jellio.Services.LiveWatchingEntry At(Guid user, DateTimeOffset when, bool paused = false) =>
        new(user, "noah", "ch1", "Sky Sports F1", "Qualifying", "tuner", null, paused, "TV", "Jellio TV", when);

    [Fact]
    public async Task CountsTimeBetweenCheckInsAndFlushesEveryFiveMinutes()
    {
        var credited = new List<long>();
        var service = new Jellio.Services.LiveWatchingService((_, ticks) => { credited.Add(ticks); return Task.CompletedTask; });
        var user = Guid.NewGuid();
        var start = DateTimeOffset.UtcNow;

        for (var i = 0; i <= 10; i++)
        {
            await service.ReportAsync(At(user, start.AddSeconds(30 * i)));
        }

        // Ten half-minute gaps: written once at five minutes.
        Assert.Equal(new[] { TimeSpan.FromMinutes(5).Ticks }, credited);
        Assert.Equal(0, service.PendingTicks(user));
        Assert.Single(service.Current());
    }

    [Fact]
    public async Task PausesAndLongGapsDoNotCountAndStopFlushes()
    {
        var credited = new List<long>();
        var service = new Jellio.Services.LiveWatchingService((_, ticks) => { credited.Add(ticks); return Task.CompletedTask; });
        var user = Guid.NewGuid();
        var start = DateTimeOffset.UtcNow;

        await service.ReportAsync(At(user, start));
        await service.ReportAsync(At(user, start.AddSeconds(30)));
        await service.ReportAsync(At(user, start.AddSeconds(60), paused: true));
        await service.ReportAsync(At(user, start.AddSeconds(90), paused: true));
        await service.ReportAsync(At(user, start.AddSeconds(120)));
        await service.ReportAsync(At(user, start.AddSeconds(420)));
        Assert.Equal(TimeSpan.FromSeconds(30).Ticks, service.PendingTicks(user));

        await service.StopAsync(user);
        Assert.Equal(new[] { TimeSpan.FromSeconds(30).Ticks }, credited);
        Assert.Empty(service.Current());
    }

    [Fact]
    public void LiveBadgesUnlockByHours()
    {
        var stats = new Jellio.Services.Achievements.UserAchievementStats { LiveTvTicks = TimeSpan.FromHours(26).Ticks };
        var unlocked = Jellio.Services.Achievements.AchievementCatalog.All.Where(b => b.Id.StartsWith("live-") && b.IsUnlocked(stats)).Select(b => b.Id);
        Assert.Equal(new[] { "live-tuned-in", "live-regular" }, unlocked);
    }
}
