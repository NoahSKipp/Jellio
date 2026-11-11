using System;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellio.Services.Friends;

// Drops "added by" entries once the item leaves a user's watchlist.
public class FriendsWatchlistSync(
    IUserDataManager userDataManager,
    AddedByStore addedByStore,
    ILogger<FriendsWatchlistSync> logger
) : IHostedService
{
    public Task StartAsync(CancellationToken cancellationToken)
    {
        userDataManager.UserDataSaved += OnUserDataSaved;
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        userDataManager.UserDataSaved -= OnUserDataSaved;
        return Task.CompletedTask;
    }

    private void OnUserDataSaved(object? sender, UserDataSaveEventArgs e)
    {
        try
        {
            if (e.Item is null || e.UserData is not { IsFavorite: false })
            {
                return;
            }

            addedByStore.RemoveItem(e.UserId, e.Item.Id);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio friends: error cleaning added-by after a user data save.");
        }
    }
}
