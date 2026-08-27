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

/// <summary>
/// Real feedback: a user with no real profile picture read as broken,
/// not "chose no avatar", the same real blank/initial placeholder every
/// native Jellyfin client already shows for one. Assigns the next real
/// preset out of Controllers/AvatarsController.cs's own avatars/Smileys
/// real subfolder instead (an admin's own real Category, same folder
/// grouping that controller already reads), one file per user, wrapping
/// back to the first once every real file has been used once.
///
/// Two real triggers: every existing user with no avatar gets one
/// once, at real server startup (IHostedService.StartAsync), and every
/// new user created from then on gets one too
/// (IEventConsumer&lt;UserCreatedEventArgs&gt;, the exact real event
/// UserManager.CreateUserAsync already publishes through IEventManager,
/// confirmed against real Jellyfin server source before writing this,
/// no other plugin code in this codebase consumed a real server event
/// before now). Rotation position is its own tiny persisted int file
/// rather than derived from how many users currently have no avatar or
/// from user count: a reader who later replaces their own assigned
/// smiley with something else, or a user who gets deleted, must never
/// shift which real smiley the next real signup lands on.
///
/// Real image write mirrors Jellyfin.Api's own ImageController.
/// PostUserImage exactly (ClearProfileImageAsync before overwriting an
/// existing ProfileImage, a real ImageInfo pointed at this user's own
/// UserConfigurationDirectoryPath, IProviderManager.SaveImage to
/// actually write the bytes, UpdateUserAsync to persist the change):
/// the same real path stock Jellyfin's own upload endpoint takes, not
/// a shortcut invented for this plugin.
/// </summary>
public class DefaultAvatarService(
    IUserManager userManager,
    IProviderManager providerManager,
    IServerConfigurationManager serverConfigurationManager,
    ILogger<DefaultAvatarService> logger
) : IHostedService, IEventConsumer<UserCreatedEventArgs>
{
    private static readonly string[] AllowedExtensions = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
    private readonly SemaphoreSlim _rotationLock = new(1, 1);

    // IServerApplicationPaths extends the same real IApplicationPaths
    // AvatarsController.cs already injects for PluginConfigurationsPath,
    // plus the real UserConfigurationDirectoryPath AssignNextSmileyAsync
    // below needs too, confirmed against real Jellyfin.Api's own
    // ImageController.PostUserImage (v10.11.11 tag, checked directly
    // rather than guessed) reaching that same real property through
    // this same real IServerConfigurationManager.ApplicationPaths path,
    // not the plain IApplicationPaths DI alone exposes.
    private string SmileysDirectory =>
        Path.Combine(serverConfigurationManager.ApplicationPaths.PluginConfigurationsPath, "Jellio", "avatars", "Smileys");

    private string RotationStatePath =>
        Path.Combine(serverConfigurationManager.ApplicationPaths.PluginConfigurationsPath, "Jellio", "avatars", ".smileys-rotation");

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        // Cosmetic feature, not load bearing: IHostedService.StartAsync
        // throwing takes the whole Kestrel host down with it, real and
        // confirmed live (a stale IUserManager.Users call, gone in
        // 10.11.11's own real GetUsers(), crashed boot outright before
        // this plugin's own package references caught up to match this
        // deployment). Kept defensive on purpose: a server API surface
        // drifting ahead of whatever this plugin built against is exactly
        // the failure mode that already happened once. SnapshotUsers
        // below stays its own NoInlining method rather than inlined here
        // because a MissingMethodException from that kind of drift is
        // thrown while the JIT compiles whichever method's own IL holds
        // the bad call, so a try/catch only actually catches it from a
        // separate method, confirmed live, the in-method version did not
        // catch it.
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

    // A ProfileImage row surviving on a user whose own real file on disk is
    // gone (an earlier crash cycle left one, or a manual pick that failed
    // partway) reads to Jellyfin's own native UI as the same blank
    // placeholder a user with no avatar at all gets, so it counts as
    // needing one too, not skipped because a record merely exists.
    // AssignNextSmileyAsync's own ClearProfileImageAsync call is what
    // actually makes catching this case safe now: the first time this
    // reassigned an existing row without it, the old row survived
    // orphaned in the database and the switcher kept showing nothing.
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
            // Inside the try too: EnumerateFiles throws on a folder with
            // the wrong host-side ownership same as it already does for
            // avatars/Disney and avatars/Netflix in this admin's own
            // setup, and that must degrade to a skipped avatar same as
            // every other failure here, not bubble out uncaught.
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

            // Real ImageController.PostUserImage's own first step, not
            // optional: ClearProfileImageAsync removes the old ImageInfo
            // row from the database itself (its own SaveChangesAsync, not
            // just nulling the in-memory reference) before a new one gets
            // attached. Skipping it once, reassigning straight over an
            // existing row instead, left a stale row behind that the
            // account switcher's own image tag lookup kept resolving to
            // even though the new file was already on disk, confirmed
            // live.
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
