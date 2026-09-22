using System.Net.Http;
using Jellio.Services;
using Jellio.Services.Achievements;
using Jellio.Services.CommunitySkip;
using Jellio.Services.Grouplist;
using Jellio.Services.IntroCredits;
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
        services.AddHostedService<IndexHtmlPatchService>();

        // Registered as itself first, both the background loop and the
        // controller need the same instance, one holding the timers, the
        // other reading/writing them.
        services.AddSingleton<SleepTimerService>();
        services.AddHostedService(sp => sp.GetRequiredService<SleepTimerService>());

        // In memory only, no background loop of its own, see this
        // service's own header for why.
        services.AddSingleton<GroupWatchChatService>();
        services.AddSingleton<GroupWatchInviteService>();

        // CalendarService's own real TMDB calls go through
        // IHttpClientFactory (CreateClient(), a fresh short lived
        // HttpClient per real request rather than one held open for the
        // plugin's whole lifetime), the same real .NET convention every
        // other outbound HTTP call in an ASP.NET Core host already uses.
        // Safe to call again even if the host already registered this
        // itself, AddHttpClient() is idempotent by design.
        services.AddHttpClient();
        services.AddSingleton<CalendarService>();

        // Registered as itself first, same real reason SleepTimerService
        // above is: the startup sweep (IHostedService) and every new user
        // from then on (IEventConsumer<UserCreatedEventArgs>, real
        // EventManager.PublishAsync UserManager.CreateUserAsync already
        // fires) both need to share the same real rotation state rather
        // than two independent instances racing each other over it.
        services.AddSingleton<DefaultAvatarService>();
        services.AddHostedService(sp => sp.GetRequiredService<DefaultAvatarService>());
        services.AddScoped<IEventConsumer<UserCreatedEventArgs>>(sp => sp.GetRequiredService<DefaultAvatarService>());

        // AchievementStore has no state of its own (every call re-reads
        // the file it needs), shared as-is by both AchievementService
        // (the only writer) and AchievementsController (read only).
        // AchievementService itself is registered as itself first, same
        // real reason DefaultAvatarService above is: AchievementsController
        // now calls its own group-watch credit methods directly, sharing
        // the exact same write lock the real playback-stop path already
        // uses rather than a second one racing it over the same file.
        services.AddSingleton<AchievementStore>();
        services.AddSingleton<AchievementService>();
        services.AddHostedService(sp => sp.GetRequiredService<AchievementService>());
        services.AddSingleton<ProfileSettingsStore>();

        // Same no-state-of-its-own shape AchievementStore above already
        // has, no hosted service of its own: GrouplistController is
        // this store's only writer.
        services.AddSingleton<GrouplistStore>();

        // Extracted from their own controllers (audit-found: a controller
        // is a fresh instance per real request, so a JSON store inlined
        // straight into one and only guarded by a static lock field was
        // the odd one out against every other store above already being
        // its own shared singleton). Same no-state-of-its-own shape.
        services.AddSingleton<NextUpHiddenStore>();
        services.AddSingleton<NotificationStore>();
        services.AddSingleton<RealDurationStore>();

        // In memory only, same real reason GroupWatchChatService above
        // is, and takes a direct dependency on that exact instance to
        // post its own winner announcement through the same real chat
        // channel once a bracket actually finishes.
        services.AddSingleton<GroupWatchRankingService>();

        // Same no-state-of-its-own shape GroupWatchChatService above
        // has, no hosted service of its own: GroupWatchJoinSyncController
        // is this store's only writer.
        services.AddSingleton<GroupWatchJoinSyncService>();

        // No hosted service of its own any more: Gelato's own resolution
        // only works from inside a real request (IntroCreditsAnalyzer's
        // own header explains why, a real live bug found after the fact),
        // so IntroCreditsController's own admin-only POST .../scan is the
        // only real trigger for the analyzer's own expensive fallback,
        // awaited there rather than a detached background sweep or
        // anything fired automatically on playback.
        services.AddSingleton<IntroCreditsStore>();
        services.AddSingleton<ChromaprintExtractor>();
        services.AddSingleton<IntroCreditsAnalyzer>();
        services.AddSingleton<IntroCreditsBulkScanner>();

        // Services/CommunitySkip: the real NuvioTV-style tier, tried
        // before any of the above. A real named client, not the default
        // one AddHttpClient() above already registers: Simkl's own real
        // /redirect endpoint IS its own real answer as a 302, following
        // it the normal way would discard the one real Location header
        // SimklIdResolver.cs actually needs.
        services.AddHttpClient("SimklRedirect").ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler
        {
            AllowAutoRedirect = false,
        });

        // Real bug, found live: SkipMe.db's own real Cloudflare Worker
        // rejects every single request with a real 403 "Client not
        // supported" unless it carries this exact literal User-Agent -
        // confirmed against their own real PluginServiceRegistrator.cs
        // (github.com/intro-skipper/skipme.db-plugin) and against a real
        // curl repro from both a real host and inside the Jellyfin
        // container itself, a spoofed real Chrome UA included, neither
        // one satisfying it. A real named client for exactly this reason,
        // same shape SimklRedirect above already uses.
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
    }
}
