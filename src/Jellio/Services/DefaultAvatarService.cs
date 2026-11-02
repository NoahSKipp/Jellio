using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Events.Users;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Events;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Providers;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellio.Services;

public class DefaultAvatarService(
    IUserManager userManager,
    IProviderManager providerManager,
    IServerConfigurationManager serverConfigurationManager,
    ILogger<DefaultAvatarService> logger
) : IHostedService, IEventConsumer<UserCreatedEventArgs>
{
    private static readonly string[] AllowedExtensions = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
    private readonly SemaphoreSlim _rotationLock = new(1, 1);

    private string SmileysDirectory =>
        Path.Combine(serverConfigurationManager.ApplicationPaths.PluginConfigurationsPath, "Jellio", "avatars", "Smileys");

    private string RotationStatePath =>
        Path.Combine(serverConfigurationManager.ApplicationPaths.PluginConfigurationsPath, "Jellio", "avatars", ".smileys-rotation");

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        List<User> users;
        try
        {
            users = SnapshotUsers();
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: could not sweep existing users for default avatars.");
            return;
        }

        try
        {
            foreach (var user in users)
            {
                if (cancellationToken.IsCancellationRequested)
                {
                    return;
                }

                if (NeedsAvatar(user))
                {
                    await AssignNextSmileyAsync(user).ConfigureAwait(false);
                }
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: could not sweep existing users for default avatars.");
        }
    }

    private static bool NeedsAvatar(User user) =>
        user.ProfileImage is null || !File.Exists(user.ProfileImage.Path);

    [MethodImpl(MethodImplOptions.NoInlining)]
    private List<User> SnapshotUsers() => userManager.GetUsers().ToList();

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public async Task OnEvent(UserCreatedEventArgs eventArgs)
    {
        try
        {
            var user = eventArgs.Argument;
            if (NeedsAvatar(user))
            {
                await AssignNextSmileyAsync(user).ConfigureAwait(false);
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: could not assign a default avatar on user creation.");
        }
    }

    private async Task AssignNextSmileyAsync(User user)
    {
        await _rotationLock.WaitAsync().ConfigureAwait(false);
        try
        {
            var files = ListSmileys();
            if (files.Count == 0)
            {
                return;
            }

            var index = ReadRotationIndex() % files.Count;
            var file = files[index];
            WriteRotationIndex(index + 1);

            var extension = Path.GetExtension(file).ToLowerInvariant();
            var mimeType = extension switch
            {
                ".jpg" or ".jpeg" => "image/jpeg",
                ".png" => "image/png",
                ".webp" => "image/webp",
                ".gif" => "image/gif",
                _ => "application/octet-stream",
            };

            await userManager.ClearProfileImageAsync(user).ConfigureAwait(false);

            var userDataPath = Path.Combine(serverConfigurationManager.ApplicationPaths.UserConfigurationDirectoryPath, user.Username);
            user.ProfileImage = new ImageInfo(Path.Combine(userDataPath, "profile" + extension));
            await using var stream = File.OpenRead(file);
            await providerManager.SaveImage(stream, mimeType, user.ProfileImage.Path).ConfigureAwait(false);
            await userManager.UpdateUserAsync(user).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: could not assign a default Smileys avatar to {User}", user.Username);
        }
        finally
        {
            _rotationLock.Release();
        }
    }

    private List<string> ListSmileys()
    {
        var dir = SmileysDirectory;
        if (!Directory.Exists(dir))
        {
            return [];
        }

        return Directory
            .EnumerateFiles(dir)
            .Where(f => AllowedExtensions.Contains(Path.GetExtension(f).ToLowerInvariant()))
            .OrderBy(f => Path.GetFileName(f), StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private int ReadRotationIndex()
    {
        try
        {
            if (!File.Exists(RotationStatePath))
            {
                return 0;
            }

            var text = File.ReadAllText(RotationStatePath);
            return int.TryParse(text, out var value) && value >= 0 ? value : 0;
        }
        catch (IOException)
        {
            return 0;
        }
    }

    private void WriteRotationIndex(int value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(RotationStatePath)!);
        File.WriteAllText(RotationStatePath, value.ToString());
    }
}
