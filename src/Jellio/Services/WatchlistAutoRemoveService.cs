using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellio.Services.Achievements;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellio.Services;

public class WatchlistAutoRemoveService(
    ILibraryManager libraryManager,
    IUserManager userManager,
    IUserDataManager userDataManager,
    ISessionManager sessionManager,
    ProfileSettingsStore profileSettingsStore,
    CalendarService? calendarService,
    ILogger<WatchlistAutoRemoveService> logger
) : IHostedService
{
    private readonly AsyncLocal<bool> _isProcessing = new();

    public Task StartAsync(CancellationToken cancellationToken)
    {
        try
        {
            userDataManager.UserDataSaved += OnUserDataSaved;
            sessionManager.PlaybackStopped += OnPlaybackStopped;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: could not subscribe to user data or playback events for watchlist auto-remove.");
        }

        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        try
        {
            userDataManager.UserDataSaved -= OnUserDataSaved;
            sessionManager.PlaybackStopped -= OnPlaybackStopped;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: could not unsubscribe from user data or playback events for watchlist auto-remove.");
        }

        return Task.CompletedTask;
    }

    private void OnUserDataSaved(object? sender, UserDataSaveEventArgs e)
    {
        try
        {
            if (e.SaveReason == UserDataSaveReason.UpdateUserRating)
            {
                return;
            }

            if (e.UserData is not { Played: true })
            {
                return;
            }

            if (e.Item is null)
            {
                return;
            }

            OnItemWatched(e.UserId, e.Item);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: error handling UserDataSaved for watchlist auto-remove.");
        }
    }

    private void OnPlaybackStopped(object? sender, PlaybackStopEventArgs e)
    {
        try
        {
            if (!e.PlayedToCompletion || e.Item is null)
            {
                return;
            }

            foreach (var user in e.Users)
            {
                OnItemWatched(user.Id, e.Item);
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: error handling PlaybackStopped for watchlist auto-remove.");
        }
    }

    public void OnItemWatched(Guid userId, BaseItem item)
    {
        if (item is null)
        {
            return;
        }

        if (_isProcessing.Value)
        {
            return;
        }

        try
        {
            _isProcessing.Value = true;

            var settings = profileSettingsStore.Load(userId);
            if (!settings.RemoveFromWatchlistAfterWatching)
            {
                return;
            }

            var user = userManager.GetUserById(userId);
            if (user == null)
            {
                return;
            }

            if (item is Movie movie)
            {
                var userData = userDataManager.GetUserData(user, movie);
                if (userData is { IsFavorite: true })
                {
                    userData.IsFavorite = false;
                    userDataManager.SaveUserData(user, movie, userData, UserDataSaveReason.UpdateUserRating, CancellationToken.None);
                    calendarService?.ForgetMonitored(userId);
                }

                return;
            }

            if (item is Episode episode)
            {
                var epData = userDataManager.GetUserData(user, episode);
                if (epData is { IsFavorite: true })
                {
                    epData.IsFavorite = false;
                    userDataManager.SaveUserData(user, episode, epData, UserDataSaveReason.UpdateUserRating, CancellationToken.None);
                }

                Season? season = null;
                try
                {
                    season = episode.Season;
                }
                catch
                {
                }
                season ??= (episode.SeasonId != Guid.Empty ? libraryManager.GetItemById(episode.SeasonId) as Season : null);

                if (season != null)
                {
                    TryRemoveSeasonIfCompleted(user, userId, season, justWatchedEpisodeId: episode.Id);
                }

                Series? series = null;
                try
                {
                    series = episode.Series;
                }
                catch
                {
                }
                series ??= (episode.SeriesId != Guid.Empty ? libraryManager.GetItemById(episode.SeriesId) as Series : null);

                if (series != null)
                {
                    if (series.ProviderIds.TryGetValue("Tmdb", out var tmdbId) && !string.IsNullOrEmpty(tmdbId))
                    {
                        calendarService?.ForgetCachedSeries(tmdbId);
                    }
                    calendarService?.ForgetMonitored(userId);
                    TryRemoveSeriesIfCompleted(user, userId, series, justWatchedEpisodeId: episode.Id);
                }

                return;
            }

            if (item is Season seasonItem)
            {
                TryRemoveSeasonIfCompleted(user, userId, seasonItem);

                Series? series = null;
                try
                {
                    series = seasonItem.Series;
                }
                catch
                {
                }
                series ??= (seasonItem.SeriesId != Guid.Empty ? libraryManager.GetItemById(seasonItem.SeriesId) as Series : null);

                if (series != null)
                {
                    TryRemoveSeriesIfCompleted(user, userId, series);
                }

                return;
            }

            if (item is Series seriesItem)
            {
                TryRemoveSeriesIfCompleted(user, userId, seriesItem);
                return;
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: error in OnItemWatched for user {UserId}, item {ItemId}", userId, item?.Id);
        }
        finally
        {
            _isProcessing.Value = false;
        }
    }

    private void TryRemoveSeasonIfCompleted(User user, Guid userId, Season? season, Guid? justWatchedEpisodeId = null)
    {
        if (season == null)
        {
            return;
        }

        var seasonUserData = userDataManager.GetUserData(user, season);
        if (seasonUserData is not { IsFavorite: true })
        {
            return;
        }

        var episodes = libraryManager.GetItemList(new InternalItemsQuery(user)
        {
            AncestorIds = [season.Id],
            IncludeItemTypes = [BaseItemKind.Episode],
            Recursive = true,
        }).OfType<Episode>().ToList();

        var regularEpisodes = episodes.Where(ep => ep.ParentIndexNumber is null || ep.ParentIndexNumber > 0).ToList();
        if (regularEpisodes.Count == 0)
        {
            return;
        }

        var nowUtc = DateTime.UtcNow;
        foreach (var ep in regularEpisodes)
        {
            if (ep.PremiereDate is { } premiere && (premiere.Year >= 9000 || premiere > nowUtc))
            {
                return;
            }

            if (ep.EndDate is { } endDate && (endDate.Year >= 9000 || endDate > nowUtc))
            {
                return;
            }

            bool isPlayed = (justWatchedEpisodeId.HasValue && ep.Id == justWatchedEpisodeId.Value) ||
                            (userDataManager.GetUserData(user, ep)?.Played == true);
            if (!isPlayed)
            {
                return;
            }
        }

        seasonUserData.IsFavorite = false;
        userDataManager.SaveUserData(user, season, seasonUserData, UserDataSaveReason.UpdateUserRating, CancellationToken.None);
        calendarService?.ForgetMonitored(userId);
    }

    private void TryRemoveSeriesIfCompleted(User user, Guid userId, Series? series, Guid? justWatchedEpisodeId = null)
    {
        if (series == null)
        {
            return;
        }

        var seriesUserData = userDataManager.GetUserData(user, series);
        if (seriesUserData is not { IsFavorite: true })
        {
            return;
        }

        // Continuing shows or shows with unknown status must never be auto-removed
        if (series.Status != SeriesStatus.Ended)
        {
            return;
        }

        var episodes = libraryManager.GetItemList(new InternalItemsQuery(user)
        {
            AncestorIds = [series.Id],
            IncludeItemTypes = [BaseItemKind.Episode],
            Recursive = true,
        }).OfType<Episode>().ToList();

        var regularEpisodes = episodes.Where(ep => ep.ParentIndexNumber is null || ep.ParentIndexNumber > 0).ToList();
        if (regularEpisodes.Count == 0)
        {
            return;
        }

        var nowUtc = DateTime.UtcNow;
        foreach (var ep in regularEpisodes)
        {
            if (ep.PremiereDate is { } premiere && (premiere.Year >= 9000 || premiere > nowUtc))
            {
                return;
            }

            if (ep.EndDate is { } endDate && (endDate.Year >= 9000 || endDate > nowUtc))
            {
                return;
            }

            bool isPlayed = (justWatchedEpisodeId.HasValue && ep.Id == justWatchedEpisodeId.Value) ||
                            (userDataManager.GetUserData(user, ep)?.Played == true);
            if (!isPlayed)
            {
                return;
            }
        }

        seriesUserData.IsFavorite = false;
        userDataManager.SaveUserData(user, series, seriesUserData, UserDataSaveReason.UpdateUserRating, CancellationToken.None);
        calendarService?.ForgetMonitored(userId);
    }
}
