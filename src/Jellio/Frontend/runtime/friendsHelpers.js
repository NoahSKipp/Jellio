// Pure helpers for the friends feature: no DOM, no network, so they test
// under node. Text comes back as { key, params } for t().

export function normalizeId(id) {
  return String(id || '').replace(/-/g, '').toLowerCase();
}

export function initialOf(name) {
  return String(name || '?').trim().charAt(0).toUpperCase() || '?';
}

// What the Add friend button on a profile or in a list shows for a status.
// `action` is what a click does; 'none' means render nothing.
export function statusToButton(status, canRequest) {
  switch (status) {
    case 'none':
      if (canRequest === false) return { state: 'closed', labelKey: 'friends_closed', action: 'none' };
      return { state: 'add', labelKey: 'friends_add', icon: 'person_add', action: 'send' };
    case 'outgoing':
      return { state: 'sent', labelKey: 'friends_request_sent', icon: 'schedule', action: 'cancel' };
    case 'incoming':
      return { state: 'incoming', labelKey: 'friends_accept', icon: 'check', action: 'respond' };
    case 'friends':
      return { state: 'friends', labelKey: 'friends_are_friends', icon: 'group', action: 'menu' };
    case 'closed':
      return { state: 'closed', labelKey: 'friends_closed', action: 'none' };
    default:
      return { state: 'hidden', labelKey: '', action: 'none' };
  }
}

const RESULT_KEYS = {
  added: 'friends_result_added',
  already_on_list: 'friends_result_already_on_list',
  already_watched: 'friends_result_already_watched',
  not_visible: 'friends_result_not_visible',
  muted: 'friends_result_muted',
  disabled: 'friends_result_disabled',
  limit: 'friends_result_limit',
  not_friends: 'friends_result_not_friends',
  unsupported: 'friends_result_unsupported',
};

export function resultMessageKey(result) {
  return RESULT_KEYS[result] || 'friends_result_unknown';
}

// 'ok' for a title that now sits on their list, 'info' for a harmless
// no-op, 'warn' when it could not be sent.
export function resultTone(result) {
  if (result === 'added') return 'ok';
  if (result === 'already_on_list' || result === 'already_watched') return 'info';
  return 'warn';
}

export function watchlistAddedCount(n) {
  const count = parseInt(n && n.Detail, 10);
  return Number.isFinite(count) && count > 1 ? count : 1;
}

export function notificationText(n) {
  const name = (n && n.FromUserName) || '';
  if (n.Kind === 'friend_request') return { key: 'friends_notice_request', params: { name } };
  if (n.Kind === 'friend_accepted') return { key: 'friends_notice_accepted', params: { name } };
  if (n.Kind === 'watchlist_added') {
    const count = watchlistAddedCount(n);
    if (count === 1) return { key: 'friends_notice_added_one', params: { name, title: n.Name || '' } };
    return { key: 'friends_notice_added_many', params: { name, count } };
  }
  return null;
}

export function isFriendKind(kind) {
  return kind === 'friend_request' || kind === 'friend_accepted' || kind === 'watchlist_added';
}

// Where tapping a notification goes.
export function notificationTarget(n) {
  if (n.Kind === 'friend_request') return '#/people?tab=requests';
  if (n.Kind === 'friend_accepted') return n.FromUserId ? '#/profile?id=' + n.FromUserId : '#/people';
  if (n.Kind === 'watchlist_added') {
    return watchlistAddedCount(n) === 1 && n.ItemId ? '#/item?id=' + n.ItemId : '#/home?tab=1';
  }
  return null;
}

export function countIncomingRequests(items) {
  return (items || []).filter(function (n) {
    return n.Kind === 'friend_request';
  }).length;
}

// The single toast shown when Jellio opens with unread friend news, or
// null when there is none or this exact set was already announced.
export function startupSummary(items, lastAnnouncedId) {
  const unread = (items || []).filter(function (n) {
    return !n.Read && (n.Kind === 'friend_request' || n.Kind === 'watchlist_added');
  });
  if (!unread.length) return null;
  const marker = unread
    .map(function (n) {
      return n.Id;
    })
    .sort()
    .join('|');
  if (marker === lastAnnouncedId) return null;

  const adds = unread.filter(function (n) {
    return n.Kind === 'watchlist_added';
  });
  const requests = unread.filter(function (n) {
    return n.Kind === 'friend_request';
  });
  const titles = adds.reduce(function (sum, n) {
    return sum + watchlistAddedCount(n);
  }, 0);

  let text;
  let target;
  if (adds.length && requests.length) {
    text = { key: 'friends_toast_both', params: { titles: titles, requests: requests.length } };
    target = '#/people?tab=requests';
  } else if (adds.length) {
    const senders = Array.from(new Set(adds.map(function (n) { return n.FromUserName || ''; })));
    text =
      senders.length === 1
        ? titles === 1
          ? { key: 'friends_notice_added_one', params: { name: senders[0], title: adds[0].Name || '' } }
          : { key: 'friends_notice_added_many', params: { name: senders[0], count: titles } }
        : { key: 'friends_toast_added_multi', params: { count: titles } };
    target = titles === 1 && adds.length === 1 && adds[0].ItemId ? '#/item?id=' + adds[0].ItemId : '#/home?tab=1';
  } else {
    text = requests.length === 1
      ? { key: 'friends_toast_request_one', params: {} }
      : { key: 'friends_toast_request_many', params: { count: requests.length } };
    target = '#/people?tab=requests';
  }
  return { marker: marker, text: text, target: target };
}

// "Added by Noah", "Added by Noah, Mia".
export function addedByNames(entries) {
  return (entries || [])
    .map(function (entry) {
      return entry.UserName || '';
    })
    .filter(Boolean)
    .join(', ');
}

export function friendMatches(friend, query) {
  const q = String(query || '').trim().toLowerCase();
  return !q || String(friend.UserName || '').toLowerCase().indexOf(q) !== -1;
}

// The request id of a friend_request notification: Detail, or the tail
// of its `friendreq:{requestId}` id.
export function requestIdOf(n) {
  if (n.Detail) return String(n.Detail);
  const id = String(n.Id || '');
  return id.indexOf('friendreq:') === 0 ? id.slice('friendreq:'.length) : '';
}

// The message for a refused friend request or accept: calm and specific,
// never the generic error for the cases the server explains.
export function requestErrorKey(err) {
  const status = err && err.status;
  const body = (err && err.body) || {};
  if (status === 403) return body.Status === 'closed' ? 'friends_err_closed' : 'friends_err_private';
  if (status === 429) return 'friends_err_cooldown';
  if (status === 409) return 'friends_err_friend_limit';
  if (status === 404) return 'friends_err_request_gone';
  return 'friends_error_generic';
}
