using System.Reflection;
using System.Security.Cryptography;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellio.Services;

public class StartupDiagnosticsService(ILogger<StartupDiagnosticsService> logger) : IHostedService
{
    private const string FingerprintResource = "Jellio.Frontend.app.js";

    public Task StartAsync(CancellationToken cancellationToken)
    {
        try
        {
            var assembly = typeof(StartupDiagnosticsService).Assembly;
            var version = assembly.GetName().Version?.ToString() ?? "unknown";
            var informational = assembly
                .GetCustomAttribute<AssemblyInformationalVersionAttribute>()
                ?.InformationalVersion;

            var location = string.IsNullOrEmpty(assembly.Location)
                ? "(no path)"
                : assembly.Location;

            logger.LogInformation(
                "Jellio {Version} (informational {Informational}) loaded from {Location}, frontend fingerprint {Fingerprint}",
                version,
                informational ?? "none",
                location,
                Fingerprint(assembly)
            );
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: could not report startup diagnostics.");
        }

        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    private static string Fingerprint(Assembly assembly)
    {
        using var stream = assembly.GetManifestResourceStream(FingerprintResource);
        if (stream is null)
        {
            return "missing";
        }

        var hash = SHA256.HashData(ReadAll(stream));
        return Convert.ToHexString(hash)[..12].ToLowerInvariant();
    }

    private static byte[] ReadAll(Stream stream)
    {
        using var buffer = new MemoryStream();
        stream.CopyTo(buffer);
        return buffer.ToArray();
    }
}
