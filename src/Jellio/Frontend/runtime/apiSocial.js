import { getAccessToken, getAuthHeaders, getServerAddress } from './auth.js';
import { deleteJson, getJson, postJson } from './api.js';
import { applyServerSubtitleStyle } from './playerPrefs.js';

export function getSyncPlayGroups() {
  return getJson('/SyncPlay/List');
}

export function createSyncPlayGroup(groupName) {
  return postJson('/SyncPlay/New', { GroupName: groupName });
}

export function getGroupWatchMessages(groupId, afterId) {
  const params = new URLSearchParams({ after: String(afterId || 0) });
  return getJson('/Jellio/groupwatch/' + groupId + '/messages?' + params.toString());
}

export function sendGroupWatchMessage(groupId, text, itemId, replyToId) {
  return postJson('/Jellio/groupwatch/' + groupId + '/messages', { Text: text, ItemId: itemId || null, ReplyToId: replyToId || null });
}

// Watch parties (Controllers/PartiesController.cs): the party side of a
// Group Watch, SyncPlay still does the syncing.
export function getParties() {
  return getJson('/Jellio/parties', 15000);
}

export function setupParty(groupId, options) {
  return postJson('/Jellio/parties/' + groupId + '/setup', {
    Private: options.private == null ? null : !!options.private,
    HostOnly: options.hostOnly == null ? null : !!options.hostOnly,
    ScheduleId: options.scheduleId || null,
  });
}

export function getPartyState(groupId, afterRequestId) {
  return getJson('/Jellio/parties/' + groupId + '/state?after=' + (afterRequestId || 0), 10000);
}

export function setPartyItem(groupId, itemId) {
  return postJson('/Jellio/parties/' + groupId + '/item', { ItemId: itemId });
}

export function transferPartyHost(groupId, userId) {
  return postJson('/Jellio/parties/' + groupId + '/host', { UserId: userId });
}

export function requestPartyControl(groupId, kind, positionTicks) {
  return postJson('/Jellio/parties/' + groupId + '/request', { Kind: kind, PositionTicks: positionTicks == null ? null : Math.round(positionTicks) });
}

export function setPartyReady(groupId, playlistItemId, ready) {
  return postJson('/Jellio/parties/' + groupId + '/ready', { PlaylistItemId: playlistItemId, Ready: !!ready });
}

export function startPartyCountdown(groupId, playlistItemId, seconds) {
  return postJson('/Jellio/parties/' + groupId + '/countdown', { PlaylistItemId: playlistItemId, Seconds: seconds });
}

export function resolvePartyCode(code) {
  return postJson('/Jellio/parties/code', { Code: code });
}

export function scheduleParty(options) {
  return postJson('/Jellio/parties/schedule', {
    Name: options.name || null,
    ItemId: options.itemId || null,
    StartsAt: new Date(options.startsAt).toISOString(),
    Private: !!options.private,
    HostOnly: !!options.hostOnly,
    InviteeUserIds: options.inviteeUserIds || [],
  });
}

export function rsvpParty(scheduleId, going) {
  return postJson('/Jellio/parties/schedule/' + scheduleId + '/rsvp', { Going: !!going });
}

export function cancelScheduledParty(scheduleId) {
  return deleteJson('/Jellio/parties/schedule/' + scheduleId);
}

export function markScheduledPartyStarted(scheduleId, groupId) {
  return postJson('/Jellio/parties/schedule/' + scheduleId + '/started', { GroupId: groupId });
}

export function getRankingSession(groupId) {
  return getJson('/Jellio/groupwatch/' + groupId + '/ranking');
}

export function startRankingSession(groupId, participantUserIds) {
  return postJson('/Jellio/groupwatch/' + groupId + '/ranking/start', { ParticipantUserIds: participantUserIds });
}

export function voteRankingSession(groupId, itemId) {
  return postJson('/Jellio/groupwatch/' + groupId + '/ranking/vote', { ItemId: itemId });
}

export function startJoinSync(groupId, playlistItemId) {
  return postJson('/Jellio/groupwatch/' + groupId + '/join-sync/start', { PlaylistItemId: playlistItemId });
}

export function clearJoinSync(groupId) {
  return postJson('/Jellio/groupwatch/' + groupId + '/join-sync/clear');
}

export function getJoinSync(groupId, playlistItemId) {
  const params = new URLSearchParams({ playlistItemId: playlistItemId });
  return getJson('/Jellio/groupwatch/' + groupId + '/join-sync?' + params.toString());
}

export function getGroupWatchInvites(afterId) {
  const params = new URLSearchParams({ after: String(afterId || 0) });
  return getJson('/Jellio/groupwatch/invites?' + params.toString());
}

export function sendGroupWatchInvite(groupId, groupName, toUserId) {
  return postJson('/Jellio/groupwatch/' + groupId + '/invite', { ToUserId: toUserId, GroupName: groupName });
}

export function getProfileSettings() {
  return getJson('/Jellio/profile/settings').then(function (settings) {
    if (settings && settings.subtitleStyle) {
      applyServerSubtitleStyle(settings.subtitleStyle);
    }
    return settings;
  });
}

export function saveSubtitleStyleSetting(style) {
  return postJson('/Jellio/profile/subtitles', style);
}

export function setProfilePrivacy(isPrivate) {
  return postJson('/Jellio/profile/privacy', { IsPrivate: isPrivate });
}

export function setGrouplistEnabled(enabled) {
  return postJson('/Jellio/profile/grouplist-enabled', { GrouplistEnabled: enabled });
}

export function saveWatchlistAutoRemoveSetting(removeFromWatchlistAfterWatching) {
  return postJson('/Jellio/profile/watchlist-auto-remove', {
    RemoveFromWatchlistAfterWatching: Boolean(removeFromWatchlistAfterWatching),
  });
}

export function saveProfileRecommendations(selectedGenres, customGenres) {
  return postJson('/Jellio/profile/recommendations', {
    SelectedGenres: selectedGenres,
    CustomGenres: customGenres,
  });
}

export function getMyAchievements() {
  return getJson('/Jellio/achievements');
}

export function getAchievementsForUser(userId) {
  return getJson('/Jellio/achievements/' + userId);
}

export function deleteActivityEntry(userId, itemId, completedAtUtc) {
  return deleteJson(
    '/Jellio/achievements/' + userId + '/activity?itemId=' + itemId + '&completedAtUtc=' + encodeURIComponent(completedAtUtc),
  );
}

// Takes a badge unlock off the Feed; the badge itself stays unlocked.
// The owner or an admin.
export function hideFeedBadge(userId, badgeId) {
  return deleteJson('/Jellio/achievements/' + userId + '/feed-badges/' + encodeURIComponent(badgeId));
}

export function lockBadgeForUser(userId, badgeId) {
  return postJson('/Jellio/achievements/' + userId + '/badges/' + badgeId + '/lock');
}

export function resetAchievementsForUser(userId) {
  return postJson('/Jellio/achievements/' + userId + '/reset');
}

export function creditGroupWatchStarted() {
  return postJson('/Jellio/achievements/group-watch/started');
}

export function creditGroupWatchTogether() {
  return postJson('/Jellio/achievements/group-watch/together');
}

// Bio (like the profile picture and banner) always visible: only
// getAchievementsForUser above goes dark for a private profile.
export function getProfileForUser(userId) {
  return getJson('/Jellio/profile/' + userId);
}

export function setProfileBio(bio) {
  return postJson('/Jellio/profile/bio', { Bio: bio });
}

export function getBannerUrl(userId) {
  const token = getAccessToken();
  const query = token ? '?ApiKey=' + encodeURIComponent(token) : '';
  return getServerAddress() + '/Jellio/profile/banner/' + userId + query;
}

const MAX_BANNER_BYTES = 8 * 1024 * 1024;

export async function setProfileBannerFromFile(file) {
  if (file.size > MAX_BANNER_BYTES) {
    throw new Error('Image too large. Please use a banner under 8 MB.');
  }

  const contentType = file.type || 'image/png';
  const base64 = await new Promise(function (resolve, reject) {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = function () {
      resolve(String(reader.result).split(',')[1]);
    };
    reader.readAsDataURL(file);
  });

  const response = await fetch(getServerAddress() + '/Jellio/profile/banner', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': contentType }, getAuthHeaders()),
    body: base64,
  });
  if (!response.ok) {
    const raw = await response.text().catch(function () {
      return '';
    });
    let message = raw;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'string') message = parsed;
    } catch (err) {
    }
    throw new Error(message || 'Could not set banner');
  }
}

export function getActivityFeed() {
  return getJson('/Jellio/feed');
}

// Community recommendations: items active users are watching or recently finished.
const COMMUNITY_TIMEOUT_MS = 45000;

const communityWatchingCache = new Map();

const communityWatchingInFlight = new Map();

const COMMUNITY_CACHE_TTL_MS = 60000;

export function invalidateCommunityWatchingCache() {
  communityWatchingCache.clear();
}

export function getCommunityWatching(excludedUserIds) {
  const params = new URLSearchParams();
  if (excludedUserIds) params.set('excludedUserIds', excludedUserIds);
  const query = params.toString();
  const cacheKey = query || '__all__';

  const now = Date.now();
  if (communityWatchingCache.has(cacheKey)) {
    const entry = communityWatchingCache.get(cacheKey);
    if (now - entry.time < COMMUNITY_CACHE_TTL_MS) {
      return Promise.resolve(entry.items);
    }
    communityWatchingCache.delete(cacheKey);
  }

  if (communityWatchingInFlight.has(cacheKey)) {
    return communityWatchingInFlight.get(cacheKey);
  }

  // Priority slot: jumps ahead of background catalog and genre queries
  const request = getJson('/Jellio/community/watching' + (query ? '?' + query : ''), COMMUNITY_TIMEOUT_MS, null, true)
    .then(function (result) {
      const items = ((result && result.Items) || []).map(function (entry) {
        const item = Object.assign({}, entry.Item);
        item.Watchers = entry.Watchers || [];
        return item;
      });
      communityWatchingCache.set(cacheKey, { time: Date.now(), items: items });
      return items;
    })
    .finally(function () {
      communityWatchingInFlight.delete(cacheKey);
    });

  communityWatchingInFlight.set(cacheKey, request);
  return request;
}

// Community users list for settings filter.
export function getCommunityUsers() {
  return getJson('/Jellio/community/users').then(function (result) {
    return Array.isArray(result) ? result : [];
  });
}
