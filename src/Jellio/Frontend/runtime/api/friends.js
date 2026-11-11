import { authedFetch, cached, getJson, invalidateCache, postJson } from './core.js';

// Friends and watchlist sharing. An older plugin answers 404 for all of
// it: the probing calls below then flip `supported` to false and every
// friends entry point hides itself.
let supported = null;
let snapshot = null;
let inFlight = null;
let incomingCount = 0;

const ADDED_BY_KEY = 'friends:added-by';
const ADDED_BY_TTL_MS = 15000;

function announce() {
  if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
    document.dispatchEvent(new CustomEvent('jellio:friends-changed'));
  }
}

function probe(promise) {
  return promise.then(
    function (value) {
      if (supported !== true) {
        supported = true;
        announce();
      }
      return value;
    },
    function (err) {
      if (err && err.status === 404 && supported !== false) {
        supported = false;
        announce();
      }
      throw err;
    },
  );
}

// true / false once known, null before the first answer.
export function friendsSupported() {
  return supported;
}

export function friendsIncomingCount() {
  return incomingCount;
}

export function setFriendsIncomingCount(count) {
  const next = Math.max(0, Number(count) || 0);
  if (next === incomingCount) return;
  incomingCount = next;
  announce();
}

export function getFriendsSnapshot() {
  return snapshot;
}

export function loadFriends(force) {
  if (!force && snapshot) return Promise.resolve(snapshot);
  if (inFlight) return inFlight;
  inFlight = probe(getJson('/Jellio/friends'))
    .then(function (data) {
      snapshot = {
        Friends: (data && data.Friends) || [],
        Incoming: (data && data.Incoming) || [],
        Outgoing: (data && data.Outgoing) || [],
      };
      setFriendsIncomingCount(snapshot.Incoming.length);
      announce();
      return snapshot;
    })
    .finally(function () {
      inFlight = null;
    });
  return inFlight;
}

function forget() {
  snapshot = null;
}

export function getFriendStatus(userId) {
  return getJson('/Jellio/friends/status/' + encodeURIComponent(userId));
}

export function searchPeople(query) {
  const path = '/Jellio/friends/people?query=' + encodeURIComponent(query || '');
  return probe(getJson(path)).then(function (list) {
    return list || [];
  });
}

// A POST whose refusals carry a JSON body (err.status, err.body), which
// postJson drops.
async function postForStatus(path, body) {
  const response = await authedFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (e) {}
  if (!response.ok) {
    const err = new Error('Request failed: ' + path);
    err.status = response.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

export function sendFriendRequest(userId) {
  return postForStatus('/Jellio/friends/requests', { UserId: userId }).then(function (result) {
    forget();
    return result;
  });
}

export function acceptFriendRequest(requestId) {
  return postForStatus('/Jellio/friends/requests/' + encodeURIComponent(requestId) + '/accept').then(function (result) {
    forget();
    return result;
  });
}

export function declineFriendRequest(requestId) {
  return postJson('/Jellio/friends/requests/' + encodeURIComponent(requestId) + '/decline').then(function (result) {
    forget();
    return result;
  });
}

async function deleteStatus(path) {
  const response = await authedFetch(path, { method: 'DELETE', headers: { Accept: 'application/json' } });
  if (!response.ok) {
    const err = new Error('Request failed: ' + path);
    err.status = response.status;
    throw err;
  }
  forget();
  const text = await response.text();
  return text ? JSON.parse(text) : { Status: 'none' };
}

export function cancelFriendRequest(requestId) {
  return deleteStatus('/Jellio/friends/requests/' + encodeURIComponent(requestId));
}

export function removeFriend(userId) {
  invalidateCache(ADDED_BY_KEY);
  return deleteStatus('/Jellio/friends/' + encodeURIComponent(userId));
}

export function setFriendMuted(userId, muted) {
  return postJson('/Jellio/friends/' + encodeURIComponent(userId) + '/mute', { Muted: !!muted }).then(function (result) {
    forget();
    return result;
  });
}

export function addToFriendsWatchlists(itemId, userIds) {
  return postJson('/Jellio/watchlist/friends', { ItemId: itemId, UserIds: userIds }).then(function (result) {
    return (result && result.Results) || [];
  });
}

// Who put each title on the caller's watchlist, keyed by item id; {} when
// the server has no such endpoint.
export function getAddedBy() {
  return cached(
    ADDED_BY_KEY,
    function () {
      return probe(getJson('/Jellio/watchlist/added-by')).then(
        function (data) {
          return (data && data.Items) || {};
        },
        function () {
          return {};
        },
      );
    },
    ADDED_BY_TTL_MS,
  );
}

export function getFriendsSettings(profileSettings) {
  const s = profileSettings || {};
  if (typeof s.FriendsCanAddToWatchlist !== 'boolean') return null;
  return {
    FriendsCanAddToWatchlist: s.FriendsCanAddToWatchlist,
    FriendRequestsFrom: s.FriendRequestsFrom === 'nobody' ? 'nobody' : 'everyone',
  };
}

export function saveFriendsSettings(values) {
  return postJson('/Jellio/profile/friends-settings', values);
}
