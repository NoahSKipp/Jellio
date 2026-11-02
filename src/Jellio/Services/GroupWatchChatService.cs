using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;

namespace Jellio.Services;

public record GroupWatchChatMessage(long Id, Guid GroupId, Guid UserId, string UserName, string Text, DateTime Timestamp, Guid? ItemId, long? ReplyToId = null, string? ReplyToName = null, string? ReplyToText = null);

public class GroupWatchChatService
{
    private const int MaxMessagesPerGroup = 200;

    private static readonly TimeSpan StaleGroupAge = TimeSpan.FromHours(24);

    private readonly ConcurrentDictionary<Guid, List<GroupWatchChatMessage>> _messagesByGroup = new();
    private long _nextId;

    public GroupWatchChatMessage Add(Guid groupId, Guid userId, string userName, string text, Guid? itemId = null, long? replyToId = null)
    {
        // A reply (a TV answering with an emoji) carries what it answers.
        var replyTo = replyToId is { } rid ? Find(groupId, rid) : null;
        var message = new GroupWatchChatMessage(
            System.Threading.Interlocked.Increment(ref _nextId),
            groupId,
            userId,
            userName,
            text,
            DateTime.UtcNow,
            itemId,
            replyTo?.Id,
            replyTo?.UserName,
            replyTo is null ? null : replyTo.Text.Length > 80 ? replyTo.Text[..80] + "…" : replyTo.Text
        );

        var list = _messagesByGroup.GetOrAdd(groupId, _ => new List<GroupWatchChatMessage>());
        lock (list)
        {
            list.Add(message);
            if (list.Count > MaxMessagesPerGroup)
            {
                list.RemoveRange(0, list.Count - MaxMessagesPerGroup);
            }
        }

        SweepStaleGroups();
        return message;
    }

    private void SweepStaleGroups()
    {
        var cutoff = DateTime.UtcNow - StaleGroupAge;
        foreach (var (groupId, list) in _messagesByGroup)
        {
            DateTime lastActivity;
            lock (list)
            {
                if (list.Count == 0)
                {
                    continue;
                }

                lastActivity = list[^1].Timestamp;
            }

            if (lastActivity < cutoff)
            {
                _messagesByGroup.TryRemove(new KeyValuePair<Guid, List<GroupWatchChatMessage>>(groupId, list));
            }
        }
    }

    public GroupWatchChatMessage? Find(Guid groupId, long id)
    {
        if (!_messagesByGroup.TryGetValue(groupId, out var list))
        {
            return null;
        }

        lock (list)
        {
            return list.FirstOrDefault(m => m.Id == id);
        }
    }

    // Only emoji (and the joiners emoji use), no words: a reaction.
    public static bool IsReaction(string text) =>
        text.Length is > 0 and <= 16
        && !text.Any(c => char.IsLetterOrDigit(c) || char.IsWhiteSpace(c) || char.IsPunctuation(c));

    public IReadOnlyList<GroupWatchChatMessage> Since(Guid groupId, long afterId)
    {
        if (!_messagesByGroup.TryGetValue(groupId, out var list))
        {
            return Array.Empty<GroupWatchChatMessage>();
        }

        lock (list)
        {
            return list.Where(m => m.Id > afterId).ToList();
        }
    }
}
