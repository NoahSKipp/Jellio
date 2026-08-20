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
    }
}
