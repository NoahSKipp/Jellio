using System.Net.Http;
using Jellio.Services;
using Jellio.Services.Achievements;
using Jellio.Services.Chaptarr;
using Jellio.Services.Language;
using Jellio.Services.CommunitySkip;
using Jellio.Services.Grouplist;
using Jellio.Services.IntroCredits;
using Jellio.Services.Reading;
using Jellyfin.Data.Events.Users;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Events;
using MediaBrowser.Controller.Plugins;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Jellio;

public class ServiceRegistrator : IPluginServiceRegistrator
{
    public void RegisterServices(IServiceCollection services, IServerApplicationHost host)
    {
        services.AddHostedService<StartupDiagnosticsService>();
        services.AddScoped<Filters.SingleGroupWatchFilter>();
        services.PostConfigure<Microsoft.AspNetCore.Mvc.MvcOptions>(options =>
            options.Filters.AddService<Filters.SingleGroupWatchFilter>());
        services.AddHostedService<IndexHtmlPatchService>();

        services.AddSingleton<SleepTimerService>();
        services.AddHostedService(sp => sp.GetRequiredService<SleepTimerService>());

        services.AddSingleton<GroupWatchChatService>();
        services.AddSingleton<GroupWatchInviteService>();

        services.AddHttpClient();
        services.AddSingleton<UpcomingHiddenStore>();
        services.AddSingleton<Jellio.Services.Parties.PartyService>();
        services.AddSingleton<Jellio.Services.Parties.PartyMonitor>();
        services.AddHostedService(sp => sp.GetRequiredService<Jellio.Services.Parties.PartyMonitor>());
        services.AddSingleton<CalendarService>();

        services.AddSingleton<ProfileSettingsStore>();
        services.AddSingleton<WatchlistAutoRemoveService>();
        services.AddHostedService(sp => sp.GetRequiredService<WatchlistAutoRemoveService>());

        services.AddSingleton<DefaultAvatarService>();
        services.AddHostedService(sp => sp.GetRequiredService<DefaultAvatarService>());
        services.AddScoped<IEventConsumer<UserCreatedEventArgs>>(sp => sp.GetRequiredService<DefaultAvatarService>());

        services.AddSingleton<AchievementStore>();
        services.AddSingleton<AchievementService>();
        services.AddHostedService(sp => sp.GetRequiredService<AchievementService>());
        services.AddSingleton<CommunityWatchingCache>();
        services.AddSingleton<CommunityWatchingService>();
        services.AddHostedService(sp => sp.GetRequiredService<CommunityWatchingService>());
        services.AddSingleton<GenreCache>();

        services.AddSingleton<GrouplistStore>();

        services.AddSingleton<NextUpHiddenStore>();
        services.AddSingleton<Jellio.Services.StreamLinks.StreamLinkStore>();
        services.AddSingleton<Jellio.Services.StreamLinks.StreamLinkResolver>();
        services.AddSingleton(_ => new Jellio.Services.StreamLinks.StreamProxySigner());
        services.AddSingleton(_ => new Jellio.Services.StreamLinks.StreamPairingService());
        services.AddSingleton<Jellio.Services.StreamLinks.StreamLinkHealthService>();
        services.AddSingleton<LiveChannelHealthStore>();
        services.AddSingleton(sp => new LiveWatchingService(sp.GetRequiredService<AchievementService>().CreditLiveWatchingAsync));
        services.AddHostedService(sp => sp.GetRequiredService<Jellio.Services.StreamLinks.StreamLinkHealthService>());
        services.AddSingleton<Jellio.Services.Reading.ShelfStore>();
        services.AddSingleton<Jellio.Services.Reading.NowReadingService>();
        services.AddSingleton<NotificationStore>();
        services.AddSingleton<Jellio.Services.Friends.FriendsStore>();
        services.AddSingleton<Jellio.Services.Friends.AddedByStore>();
        services.AddSingleton<Jellio.Services.Friends.FriendsService>();
        services.AddHostedService<Jellio.Services.Friends.FriendsWatchlistSync>();
        services.AddSingleton<RealDurationStore>();
        services.AddSingleton<DurationProbeService>();

        services.AddSingleton<GroupWatchRankingService>();

        services.AddSingleton<GroupWatchJoinSyncService>();

        services.AddSingleton<IntroCreditsStore>();
        services.AddSingleton<Jellio.Services.Segments.IntroSkipperTimestamps>();
        services.AddSingleton<ChromaprintExtractor>();
        services.AddSingleton<IntroCreditsAnalyzer>();
        services.AddSingleton<Jellio.Services.Downloads.ConversionSlotService>();
        services.AddSingleton<IntroCreditsBulkScanner>();

        services.AddHttpClient("SimklRedirect").ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler
        {
            AllowAutoRedirect = false,
        });

        services.AddHttpClient(nameof(SkipMeDbClient)).ConfigureHttpClient(c =>
        {
            c.DefaultRequestHeaders.UserAgent.ParseAdd(SkipMeDbClient.RequiredUserAgent);
        });
        services.AddSingleton<TheIntroDbClient>();
        services.AddSingleton<SkipMeDbClient>();
        services.AddSingleton<IntroDbClient>();
        services.AddSingleton<TmdbExternalIdResolver>();
        services.AddSingleton<SimklIdResolver>();
        services.AddSingleton<AniSkipClient>();
        services.AddSingleton<AnimeSkipClient>();
        services.AddSingleton<CommunitySkipProvider>();

        services.AddHttpClient(nameof(ChaptarrClient));
        services.AddSingleton<ChaptarrClient>();
        services.AddSingleton<BookMetadataService>();
        services.AddHttpClient(nameof(OpenLibraryClient));
        services.AddSingleton<OpenLibraryClient>();
        services.AddHttpClient(nameof(Jellio.Services.Manga.AniListClient));
        services.AddSingleton<Jellio.Services.Manga.AniListClient>();
        services.AddSingleton<Jellio.Services.Manga.AniListTrackerClient>();
        services.AddSingleton<Jellio.Services.Manga.TrackerStore>();
        services.AddHttpClient(nameof(Jellio.Services.Manga.SuwayomiClient));
        services.AddSingleton<Jellio.Services.Manga.SuwayomiClient>();
        services.AddSingleton(sp => new Jellio.Services.Manga.MangaSearchService(
            sp.GetRequiredService<Jellio.Services.Manga.SuwayomiClient>(),
            sp.GetRequiredService<Microsoft.Extensions.Logging.ILogger<Jellio.Services.Manga.MangaSearchService>>()));
        services.AddSingleton<Jellio.Services.Manga.MangaStreamService>();
        services.AddSingleton<Jellio.Services.Manga.MangaImportService>();
        services.AddSingleton<Jellio.Services.Manga.MangaCoverService>();
        services.AddHostedService(sp => sp.GetRequiredService<Jellio.Services.Manga.MangaImportService>());
        services.AddSingleton<Jellio.Services.Manga.MangaUpdatesService>();
        services.AddHostedService(sp => sp.GetRequiredService<Jellio.Services.Manga.MangaUpdatesService>());

        services.AddSingleton<ReadingProgressStore>();
        services.AddSingleton<Jellio.Services.Reading.BookRequestStore>();
        services.AddSingleton<AnnotationStore>();
        services.AddSingleton<ComicArchiveService>();
        services.AddSingleton<VocabularyStore>();
        services.AddHttpClient(nameof(LanguageClient));
        services.AddSingleton<LanguageClient>();
    }
}
