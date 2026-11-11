using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Jellio.Services.Achievements;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging;

namespace Jellio.Services.Friends;

public record Person(string UserId, string UserName, string? PrimaryImageTag);

public record AddResult(Guid UserId, string Result);

public class FriendsService(
    FriendsStore store,
    AddedByStore addedByStore,
    NotificationStore notifications,
    ProfileSettingsStore profileSettings,
    IUserManager userManager,
    IUserDataManager userDataManager,
    ILibraryManager libraryManager,
    IImageProcessor imageProcessor,
    CalendarService calendarService,
    ILogger<FriendsService> logger
)
{
    public const int MaxUsersPerAdd = 20;

    private readonly WatchlistAddRateLimiter _rateLimiter = new();

    public Person? GetPerson(Guid userId)
    {
        var user = userManager.GetUserById(userId);
        return user == null ? null : ToPerson(user);
    }

    public Person ToPerson(User user)
    {
        string? tag = null;
        if (user.ProfileImage != null)
        {
            try
            {
                tag = imageProcessor.GetImageCacheTag(user);
            }
            catch (Exception ex)
            {
                logger.LogDebug(ex, "Jellio friends: could not read the image tag of user {UserId}", user.Id);
            }
        }

        return new Person(user.Id.ToString("N"), user.Username, tag);
    }

    public bool IsPrivate(Guid userId) => profileSettings.Load(userId).IsPrivate;

    public bool IsClosed(Guid userId) =>
        string.Equals(profileSettings.Load(userId).FriendRequestsFrom, "nobody", StringComparison.OrdinalIgnoreCase);

    // The status a viewer sees, with private and closed profiles layered on.
    public (string Status, string? RequestId, bool CanRequest) StatusFor(Guid viewer, Guid other)
    {
        var now = DateTime.UtcNow;
        var (status, requestId, canRequest) = store.Read(d =>
        {
            var s = FriendsGraph.StatusFor(d, viewer, other);
            return (s.Status, s.RequestId, FriendsGraph.CanRequest(d, viewer, other, now));
        });

        if (status == "none")
        {
            if (IsPrivate(other))
            {
                return ("private", null, false);
            }

            if (IsClosed(other))
            {
                return ("closed", null, false);
            }
        }

        return (status, requestId, canRequest);
    }

    public FriendsData Snapshot() => store.Read(d => new FriendsData
    {
        Friendships = d.Friendships.Select(f => new Friendship
        {
            UserA = f.UserA, UserB = f.UserB, Since = f.Since, MutedByA = f.MutedByA, MutedByB = f.MutedByB,
        }).ToList(),
        Requests = d.Requests.Select(r => new FriendRequest { Id = r.Id, From = r.From, To = r.To, At = r.At }).ToList(),
    });

    public SendResult SendRequest(Guid from, Guid to)
    {
        var now = DateTime.UtcNow;
        var result = store.Mutate(d => FriendsGraph.Send(d, from, to, now));
        switch (result.Outcome)
        {
            case SendOutcome.Sent when result.Request != null:
                NotifyRequest(result.Request);
                break;
            case SendOutcome.AutoAccepted when result.Request != null:
                AfterAccept(result.Request, acceptor: from, now);
                break;
        }

        logger.LogInformation("Jellio friends: request {From} to {To} result {Outcome}", from, to, result.Outcome);
        return result;
    }

    public RespondResult Accept(string requestId, Guid acceptor)
    {
        var now = DateTime.UtcNow;
        var result = store.Mutate(d => FriendsGraph.Accept(d, requestId, acceptor, now));
        if (result is { Outcome: RespondOutcome.Done, Request: not null })
        {
            AfterAccept(result.Request, acceptor, now);
        }

        logger.LogInformation("Jellio friends: accept {RequestId} by {User} result {Outcome}", requestId, acceptor, result.Outcome);
        return result;
    }

    public RespondResult Decline(string requestId, Guid decliner)
    {
        var result = store.Mutate(d => FriendsGraph.Decline(d, requestId, decliner, DateTime.UtcNow));
        if (result is { Outcome: RespondOutcome.Done, Request: not null })
        {
            notifications.UpdateIfChanged(result.Request.To, l => FriendNotifications.RemoveFriendRequest(l, requestId));
        }

        logger.LogInformation("Jellio friends: decline {RequestId} by {User} result {Outcome}", requestId, decliner, result.Outcome);
        return result;
    }

    public RespondResult Cancel(string requestId, Guid sender)
    {
        var result = store.Mutate(d => FriendsGraph.Cancel(d, requestId, sender));
        if (result is { Outcome: RespondOutcome.Done, Request: not null })
        {
            notifications.UpdateIfChanged(result.Request.To, l => FriendNotifications.RemoveFriendRequest(l, requestId));
        }

        logger.LogInformation("Jellio friends: cancel {RequestId} by {User} result {Outcome}", requestId, sender, result.Outcome);
        return result;
    }

    public bool RemoveFriend(Guid user, Guid friend)
    {
        var removed = store.Mutate(d => FriendsGraph.Remove(d, user, friend));
        if (removed)
        {
            addedByStore.RemoveSender(user, friend);
            addedByStore.RemoveSender(friend, user);
        }

        logger.LogInformation("Jellio friends: remove {User} and {Friend} removed {Removed}", user, friend, removed);
        return removed;
    }

    public bool SetMuted(Guid user, Guid friend, bool muted) =>
        store.Mutate(d => FriendsGraph.SetMuted(d, user, friend, muted));

    private void NotifyRequest(FriendRequest request)
    {
        var from = GetPerson(request.From);
        if (from == null)
        {
            return;
        }

        notifications.Update(request.To, l => FriendNotifications.AddFriendRequest(
            l, request.Id, request.From, from.UserName, from.PrimaryImageTag, request.At));
    }

    private void AfterAccept(FriendRequest request, Guid acceptor, DateTime now)
    {
        notifications.UpdateIfChanged(request.To, l => FriendNotifications.RemoveFriendRequest(l, request.Id));
        // The requester is told who accepted; a mutual auto-accept notifies the original requester too.
        var original = request.From;
        var who = GetPerson(acceptor);
        if (who != null && original != acceptor)
        {
            notifications.Update(original, l => FriendNotifications.AddFriendAccepted(
                l, request.Id, acceptor, who.UserName, who.PrimaryImageTag, now));
        }
    }

    public List<AddResult> AddToWatchlists(Guid sender, Guid itemId, IEnumerable<Guid> recipients)
    {
        var item = libraryManager.GetItemById(itemId);
        var target = ResolveTarget(item);
        var senderPerson = GetPerson(sender);
        var results = new List<AddResult>();
        var friendsData = Snapshot();

        foreach (var recipientId in recipients.Where(r => r != sender).Distinct())
        {
            string result;
            try
            {
                result = AddOne(sender, senderPerson, recipientId, target, friendsData);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Jellio friends: add for {Recipient} failed", recipientId);
                result = WatchlistAddResults.NotVisible;
            }

            logger.LogInformation(
                "Jellio friends: watchlist add {Sender} to {Recipient} item {ItemId} result {Result}",
                sender, recipientId, target?.Id, result);
            results.Add(new AddResult(recipientId, result));
        }

        return results;
    }

    private string AddOne(Guid sender, Person? senderPerson, Guid recipientId, BaseItem? target, FriendsData friends)
    {
        if (target == null)
        {
            return WatchlistAddResults.Unsupported;
        }

        var areFriends = FriendsGraph.AreFriends(friends, sender, recipientId);
        var recipient = areFriends ? userManager.GetUserById(recipientId) : null;
        if (recipient == null)
        {
            return WatchlistAddResults.NotFriends;
        }

        var allows = profileSettings.Load(recipientId).FriendsCanAddToWatchlist;
        var visible = target.IsVisible(recipient);
        var data = userDataManager.GetUserData(recipient, target);
        var onList = data?.IsFavorite == true;
        var now = DateTime.UtcNow;

        var facts = new WatchlistAddFacts(
            Supported: true,
            AreFriends: true,
            MutedByRecipient: FriendsGraph.IsMuted(friends, recipientId, sender),
            RecipientAllows: allows,
            Visible: visible,
            OnList: onList,
            Watched: visible && !onList && IsWatched(recipient, target, data),
            RateLimited: _rateLimiter.IsLimited(sender, recipientId, now));

        var result = WatchlistAddRules.Decide(facts);
        if (result == WatchlistAddResults.AlreadyOnList)
        {
            addedByStore.Record(recipientId, target.Id, sender, now);
            return result;
        }

        if (result != WatchlistAddResults.Added)
        {
            return result;
        }

        data ??= userDataManager.GetUserData(recipient, target);
        if (data == null)
        {
            return WatchlistAddResults.NotVisible;
        }

        data.IsFavorite = true;
        // UpdateUserRating is what a favorite toggle uses; the auto-remove service ignores it.
        userDataManager.SaveUserData(recipient, target, data, UserDataSaveReason.UpdateUserRating, CancellationToken.None);
        calendarService.ForgetMonitored(recipientId);
        _rateLimiter.Record(sender, recipientId, now);
        addedByStore.Record(recipientId, target.Id, sender, now);

        if (senderPerson != null)
        {
            notifications.Update(recipientId, l => FriendNotifications.AddWatchlistAdded(
                l, sender, senderPerson.UserName, senderPerson.PrimaryImageTag,
                target.Id, target.Name, target is Series ? "Series" : "Movie", now));
        }

        return result;
    }

    private BaseItem? ResolveTarget(BaseItem? item) => item switch
    {
        Movie or Series => item,
        Episode e => libraryManager.GetItemById(e.SeriesId) as Series,
        Season s => libraryManager.GetItemById(s.SeriesId) as Series,
        _ => null,
    };

    private bool IsWatched(User user, BaseItem item, UserItemData? data)
    {
        if (item is Movie)
        {
            return data?.Played == true;
        }

        var nowUtc = DateTime.UtcNow;
        var episodes = libraryManager.GetItemList(new InternalItemsQuery(user)
        {
            AncestorIds = [item.Id],
            IncludeItemTypes = [BaseItemKind.Episode],
            Recursive = true,
        }).OfType<Episode>()
            .Where(ep => ep.ParentIndexNumber is null || ep.ParentIndexNumber > 0)
            .Where(ep => ep.PremiereDate is not { } premiere || premiere <= nowUtc)
            .ToList();

        return episodes.Count > 0 && episodes.All(ep => userDataManager.GetUserData(user, ep)?.Played == true);
    }

    public Dictionary<string, List<object>> AddedByFor(Guid recipient)
    {
        var user = userManager.GetUserById(recipient);
        var snapshot = addedByStore.Snapshot(recipient);
        var items = new Dictionary<string, List<object>>();
        if (user == null)
        {
            return items;
        }

        var friends = Snapshot();
        var people = new Dictionary<Guid, Person?>();
        foreach (var (key, entries) in snapshot)
        {
            if (!Guid.TryParse(key, out var itemId))
            {
                continue;
            }

            var item = libraryManager.GetItemById(itemId);
            var stillFavorite = item != null && userDataManager.GetUserData(user, item)?.IsFavorite == true;
            if (!stillFavorite)
            {
                addedByStore.RemoveItem(recipient, itemId);
                continue;
            }

            var list = new List<object>();
            foreach (var entry in entries)
            {
                if (!FriendsGraph.AreFriends(friends, recipient, entry.FromUserId))
                {
                    continue;
                }

                if (!people.TryGetValue(entry.FromUserId, out var person))
                {
                    person = GetPerson(entry.FromUserId);
                    people[entry.FromUserId] = person;
                }

                if (person != null)
                {
                    list.Add(new { person.UserId, person.UserName, person.PrimaryImageTag, At = entry.At });
                }
            }

            if (list.Count > 0)
            {
                items[key] = list;
            }
        }

        return items;
    }

    public void OnFavoriteRemoved(Guid userId, Guid itemId) => addedByStore.RemoveItem(userId, itemId);
}
