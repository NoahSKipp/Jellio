using Jellio.Services;
using MediaBrowser.Controller;
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

        // CalendarService's own real TMDB calls go through
        // IHttpClientFactory (CreateClient(), a fresh short lived
        // HttpClient per real request rather than one held open for the
        // plugin's whole lifetime), the same real .NET convention every
        // other outbound HTTP call in an ASP.NET Core host already uses.
        // Safe to call again even if the host already registered this
        // itself, AddHttpClient() is idempotent by design.
        services.AddHttpClient();
        services.AddSingleton<CalendarService>();
    }
}
