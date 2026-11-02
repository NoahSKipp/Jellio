import { getCurrentUserId } from './auth.js';
import { getSyncPlayGroups, getCurrentUser } from './api.js';

const TicksPerMillisecond = 10000;
const MaxMeasurements = 6;
const PingIntervalMs = 30000;
const ReconcileIntervalMs = 15000;
// Local correction thresholds, in milliseconds of drift. Below this,
// left alone: normal player jitter, correcting it would fight itself.
const SkipToSyncThresholdMs = 400;
const IdleTabLeaveThresholdMs = 30 * 60 * 1000;
const ExplicitLeaveGraceMs = 20000;

let started = false;
let explicitLeaveUntil = 0;

const MY_GROUP_KEY = 'jellio.syncplay.groupId';
let pendingCreateName = null;
let pendingCreateUntil = 0;

function readMyGroupId() {
  try {
    return window.localStorage.getItem(MY_GROUP_KEY) || null;
  } catch (err) {
    return null;
  }
}

function writeMyGroupId(groupId) {
  try {
    if (groupId) window.localStorage.setItem(MY_GROUP_KEY, groupId);
    else window.localStorage.removeItem(MY_GROUP_KEY);
  } catch (err) {}
}

export function sameId(a, b) {
  if (!a || !b) return false;
  return String(a).replace(/-/g, '').toLowerCase() === String(b).replace(/-/g, '').toLowerCase();
}
let apiClient = null;
let timeOffsetMeasurements = [];
let pingTimer = null;
let reconcileTimer = null;
let idleLeaveTimer = null;
let myUserName = '';

let currentGroup = null; // GroupInfoDto, or null when not in a group
let currentQueue = null; // last PlayQueueUpdate seen
let lastCommand = null; // last SyncPlayCommand applied, {Command, When, PositionTicks, PlaylistItemId}
let lastNotifiedPlaylistItemId = null;

const groupListeners = [];
const commandListeners = [];
const watchTargetListeners = [];
const presenceListeners = [];
const userDataListeners = [];

function notifyGroupListeners() {
  groupListeners.forEach(function (fn) {
    try {
      fn(currentGroup, currentQueue);
    } catch (err) {
      console.warn('Jellio SyncPlay: group listener failed', err);
    }
  });
}

function notifyCommandListeners(command) {
  commandListeners.forEach(function (fn) {
    try {
      fn(command);
    } catch (err) {
      console.warn('Jellio SyncPlay: command listener failed', err);
    }
  });
}

function notifyPresenceListeners(kind, name) {
  presenceListeners.forEach(function (fn) {
    try {
      fn(kind, name);
    } catch (err) {
      console.warn('Jellio SyncPlay: presence listener failed', err);
    }
  });
}

function notifyWatchTargetListeners(target) {
  watchTargetListeners.forEach(function (fn) {
    try {
      fn(target);
    } catch (err) {
      console.warn('Jellio SyncPlay: watch target listener failed', err);
    }
  });
}

function notifyUserDataListeners(userDataList) {
  userDataListeners.forEach(function (fn) {
    try {
      fn(userDataList);
    } catch (err) {
      console.warn('Jellio SyncPlay: user data listener failed', err);
    }
  });
}

function bindApiClientMessage(fn) {
  const client = window.ApiClient;
  if (!client) return;
  client._callbacks = client._callbacks || {};
  client._callbacks.message = client._callbacks.message || [];
  client._callbacks.message.push(fn);
}

const LOW_SIGNAL_MESSAGE_TYPES = ['KeepAlive', 'ForceKeepAlive'];

function onApiClientMessage(event, msg) {
  if (!msg || !msg.MessageType) return;
  if (LOW_SIGNAL_MESSAGE_TYPES.indexOf(msg.MessageType) === -1) {
    console.debug('Jellio SyncPlay: received', msg.MessageType, msg.Data);
  }
  if (msg.MessageType === 'SyncPlayGroupUpdate') {
    handleGroupUpdate(msg.Data);
  } else if (msg.MessageType === 'SyncPlayCommand') {
    handleCommand(msg.Data);
  } else if (msg.MessageType === 'UserDataChanged') {
    handleUserDataChanged(msg.Data);
  }
}

function applyGroupJoined(groupData) {
  currentGroup = groupData;
  if (groupData && groupData.GroupId) writeMyGroupId(groupData.GroupId);
  pendingCreateName = null;
  currentQueue = null;
  lastCommand = null;
  lastNotifiedPlaylistItemId = null;
  notifyGroupListeners();
}

function resetGroupState() {
  currentGroup = null;
  writeMyGroupId(null);
  currentQueue = null;
  lastCommand = null;
  lastNotifiedPlaylistItemId = null;
  notifyGroupListeners();
}

let nativeToastSuppressUntil = 0;
let nativeToastObserver = null;

function suppressNextNativeToast() {
  nativeToastSuppressUntil = Date.now() + 1000;
  if (nativeToastObserver) return;
  nativeToastObserver = new MutationObserver(function (mutations) {
    if (Date.now() > nativeToastSuppressUntil) return;
    mutations.forEach(function (mutation) {
      (mutation.addedNodes || []).forEach(function (node) {
        if (node.nodeType === 1 && node.classList && node.classList.contains('toast')) {
          node.remove();
        }
      });
    });
  });
  nativeToastObserver.observe(document.body, { childList: true, subtree: true });
}

function handleGroupUpdate(update) {
  if (!update || !update.Type) return;
  switch (update.Type) {
    case 'GroupJoined':
      suppressNextNativeToast();
      applyGroupJoined(update.Data);
      break;
    case 'GroupUpdate':
      currentGroup = update.Data;
      notifyGroupListeners();
      break;
    case 'UserJoined':
      suppressNextNativeToast();
      if (currentGroup) {
        currentGroup = Object.assign({}, currentGroup, {
          Participants: (currentGroup.Participants || []).concat([update.Data]),
        });
        notifyGroupListeners();
        notifyPresenceListeners('joined', update.Data);
      }
      break;
    case 'UserLeft':
      suppressNextNativeToast();
      if (currentGroup) {
        currentGroup = Object.assign({}, currentGroup, {
          Participants: (currentGroup.Participants || []).filter(function (name) {
            return name !== update.Data;
          }),
        });
        notifyGroupListeners();
        notifyPresenceListeners('left', update.Data);
      }
      break;
    case 'PlayQueue': {
      currentQueue = update.Data;
      notifyGroupListeners();
      const target = getCurrentPlaylistTarget();
      console.debug('Jellio SyncPlay: PlayQueue update resolved to', target, 'last notified was', lastNotifiedPlaylistItemId);
      if (target && target.playlistItemId !== lastNotifiedPlaylistItemId) {
        lastNotifiedPlaylistItemId = target.playlistItemId;
        notifyWatchTargetListeners(target);
      }
      break;
    }
    case 'NotInGroup':
    case 'GroupLeft':
      suppressNextNativeToast();
      resetGroupState();
      break;
    case 'StateUpdate':
      notifyGroupListeners();
      break;
    default:
      break;
  }
}

function handleCommand(command) {
  if (!command || !command.Command) return;
  const parsed = {
    Command: command.Command,
    When: new Date(command.When),
    PositionTicks: command.PositionTicks != null ? Number(command.PositionTicks) : null,
    PlaylistItemId: command.PlaylistItemId,
  };
  lastCommand = parsed;
  notifyCommandListeners(parsed);
}

function handleUserDataChanged(data) {
  if (!data || !data.UserDataList || data.UserId !== getCurrentUserId()) return;
  notifyUserDataListeners(data.UserDataList);
}

function recordMeasurement(requestSent, requestReceived, responseSent, responseReceived) {
  const offset = (requestReceived.getTime() - requestSent.getTime()) + (responseSent.getTime() - responseReceived.getTime());
  const delay = (responseReceived.getTime() - requestSent.getTime()) - (responseSent.getTime() - requestReceived.getTime());
  timeOffsetMeasurements.push({ offset: offset / 2, delay: delay });
  if (timeOffsetMeasurements.length > MaxMeasurements) {
    timeOffsetMeasurements.shift();
  }
}

function getTimeOffsetMs() {
  if (!timeOffsetMeasurements.length) return 0;
  let best = timeOffsetMeasurements[0];
  timeOffsetMeasurements.forEach(function (m) {
    if (m.delay < best.delay) best = m;
  });
  return best.offset;
}

async function pingServerTime() {
  if (!apiClient || document.visibilityState === 'hidden') return;
  const requestSent = new Date();
  try {
    const response = await apiClient.getServerTime();
    const responseReceived = new Date();
    const data = await response.json();
    recordMeasurement(requestSent, new Date(data.RequestReceptionTime), new Date(data.ResponseTransmissionTime), responseReceived);
  } catch (err) {
    // A missed measurement just leaves the previous offset in place.
  }
}

// remote (server) Date -> local Date, using the current offset estimate.
function remoteToLocal(remoteDate) {
  return new Date(remoteDate.getTime() - getTimeOffsetMs());
}

function localToRemote(localDate) {
  return new Date(localDate.getTime() + getTimeOffsetMs());
}

function estimateCurrentTicks(positionTicks, whenRemote, atLocalTime) {
  const nowRemote = localToRemote(atLocalTime || new Date());
  return positionTicks + (nowRemote.getTime() - whenRemote.getTime()) * TicksPerMillisecond;
}

let lastLoggedReconcileGroupId = undefined;

async function reconcileGroupMembership() {
  if (document.visibilityState === 'hidden') return;
  try {
    const [groups, user] = await Promise.all([getSyncPlayGroups(), getCurrentUser()]);
    if (user && user.Name) myUserName = user.Name;
    if (!myUserName) return;
    const list = groups || [];
    const myGroupId = readMyGroupId();
    let mine = myGroupId
      ? list.find(function (group) {
          return sameId(group.GroupId, myGroupId);
        })
      : null;
    // A group this browser just created whose GroupJoined push went missing.
    if (!mine && pendingCreateName && Date.now() < pendingCreateUntil) {
      mine = list.find(function (group) {
        return group.GroupName === pendingCreateName && (group.Participants || []).indexOf(myUserName) !== -1;
      });
    }
    if (myGroupId && !mine) writeMyGroupId(null);
    const mineGroupId = mine && mine.GroupId;
    if (mineGroupId !== lastLoggedReconcileGroupId) {
      lastLoggedReconcileGroupId = mineGroupId;
      console.debug('Jellio SyncPlay: reconcile found group', mineGroupId, 'current group is', currentGroup && currentGroup.GroupId);
    }
    if (mine && Date.now() < explicitLeaveUntil) {
      return;
    }
    if (mine && (!currentGroup || !sameId(currentGroup.GroupId, mine.GroupId))) {
      const joinedGroupId = mine.GroupId;
      try {
        await joinGroup(joinedGroupId);
      } catch (err) {
        console.warn('Jellio SyncPlay: could not re-join own group during reconcile', err);
        return;
      }
      window.setTimeout(function () {
        if (!currentGroup || !sameId(currentGroup.GroupId, joinedGroupId)) {
          console.warn('Jellio SyncPlay: GroupJoined push never arrived after a real join, applying the REST snapshot directly');
          applyGroupJoined(mine);
        }
      }, 3000);
    } else if (currentGroup && !list.some(function (group) {
      return sameId(group.GroupId, currentGroup.GroupId);
    })) {
      // The group itself is gone and the push saying so never arrived.
      console.warn('Jellio SyncPlay: reconcile found this session is no longer a participant, clearing stale local group state for', currentGroup.GroupId);
      resetGroupState();
    }
  } catch (err) {
    console.warn('Jellio SyncPlay: reconcile failed', err);
  }
}

function scheduleIdleTabLeave() {
  if (idleLeaveTimer) return;
  idleLeaveTimer = window.setTimeout(function () {
    idleLeaveTimer = null;
    if (currentGroup && document.visibilityState === 'hidden') {
      console.debug('Jellio SyncPlay: tab hidden for', IdleTabLeaveThresholdMs, 'ms while grouped, leaving so this real session can go idle');
      leaveGroup().catch(function (err) {
        console.warn('Jellio SyncPlay: idle tab auto-leave failed', err);
      });
    }
  }, IdleTabLeaveThresholdMs);
}

function cancelIdleTabLeave() {
  if (idleLeaveTimer) {
    window.clearTimeout(idleLeaveTimer);
    idleLeaveTimer = null;
  }
}

function onVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    scheduleIdleTabLeave();
  } else {
    cancelIdleTabLeave();
    pingServerTime();
    reconcileGroupMembership();
  }
}

export function startSyncPlay() {
  if (started) return;
  if (!window.ApiClient) {
    console.debug('Jellio SyncPlay: window.ApiClient not present yet, not starting');
    return;
  }
  started = true;
  apiClient = window.ApiClient;
  try {
    apiClient.ensureWebSocket();
  } catch (err) {
    console.warn('Jellio SyncPlay: could not open WebSocket', err);
  }
  bindApiClientMessage(onApiClientMessage);
  window.setTimeout(function () {
    if (apiClient && typeof apiClient.isWebSocketOpen === 'function' && !apiClient.isWebSocketOpen()) {
      console.warn('Jellio SyncPlay: WebSocket still not open a few seconds in, check for a reverse proxy not passing WebSocket upgrades through');
    }
  }, 5000);
  pingServerTime();
  pingTimer = window.setInterval(pingServerTime, PingIntervalMs);
  reconcileGroupMembership();
  reconcileTimer = window.setInterval(reconcileGroupMembership, ReconcileIntervalMs);
  document.addEventListener('visibilitychange', onVisibilityChange);
  if (document.visibilityState === 'hidden') {
    scheduleIdleTabLeave();
  }
}

export function getCurrentGroup() {
  return currentGroup;
}

// The last command pushed, for a player that only learns the group's
// queue item after the command for it already arrived.
export function getLastCommand() {
  return lastCommand;
}

export function getCurrentPlaylistTarget() {
  if (!currentQueue || !currentQueue.Playlist || currentQueue.PlayingItemIndex == null) return null;
  const entry = currentQueue.Playlist[currentQueue.PlayingItemIndex];
  if (!entry) return null;
  return {
    itemId: entry.ItemId,
    playlistItemId: entry.PlaylistItemId,
    startPositionTicks: currentQueue.StartPositionTicks || 0,
    isPlaying: !!currentQueue.IsPlaying,
  };
}

export function onGroupChange(fn) {
  groupListeners.push(fn);
  return function unsubscribe() {
    const index = groupListeners.indexOf(fn);
    if (index !== -1) groupListeners.splice(index, 1);
  };
}

export function onCommand(fn) {
  commandListeners.push(fn);
  return function unsubscribe() {
    const index = commandListeners.indexOf(fn);
    if (index !== -1) commandListeners.splice(index, 1);
  };
}

export function onWatchTargetChange(fn) {
  watchTargetListeners.push(fn);
  return function unsubscribe() {
    const index = watchTargetListeners.indexOf(fn);
    if (index !== -1) watchTargetListeners.splice(index, 1);
  };
}

export function onGroupPresenceChange(fn) {
  presenceListeners.push(fn);
  return function unsubscribe() {
    const index = presenceListeners.indexOf(fn);
    if (index !== -1) presenceListeners.splice(index, 1);
  };
}

export function onUserDataChange(fn) {
  userDataListeners.push(fn);
  return function unsubscribe() {
    const index = userDataListeners.indexOf(fn);
    if (index !== -1) userDataListeners.splice(index, 1);
  };
}

export { remoteToLocal, localToRemote, estimateCurrentTicks, getTimeOffsetMs, TicksPerMillisecond, SkipToSyncThresholdMs };

export function noteCreatingGroup(name) {
  pendingCreateName = name;
  pendingCreateUntil = Date.now() + 15000;
}

export function getMyGroupId() {
  return (currentGroup && currentGroup.GroupId) || readMyGroupId();
}

export function joinGroup(groupId) {
  if (!apiClient) return Promise.reject(new Error('SyncPlay not started'));
  explicitLeaveUntil = 0;
  return apiClient.joinSyncPlayGroup({ GroupId: groupId }).then(function (result) {
    writeMyGroupId(groupId);
    return result;
  });
}

export function leaveGroup() {
  if (!apiClient) return Promise.reject(new Error('SyncPlay not started'));
  explicitLeaveUntil = Date.now() + ExplicitLeaveGraceMs;
  writeMyGroupId(null);
  return apiClient.leaveSyncPlayGroup();
}

export function requestUnpause() {
  if (!apiClient) return Promise.reject(new Error('SyncPlay not started'));
  return apiClient.requestSyncPlayUnpause();
}

export function requestPause() {
  if (!apiClient) return Promise.reject(new Error('SyncPlay not started'));
  return apiClient.requestSyncPlayPause();
}

export function requestSeek(positionTicks) {
  if (!apiClient) return Promise.reject(new Error('SyncPlay not started'));
  return apiClient.requestSyncPlaySeek({ PositionTicks: Math.round(positionTicks) });
}

export function notifyBuffering(positionTicks, isPlaying, playlistItemId) {
  if (!apiClient) return Promise.reject(new Error('SyncPlay not started'));
  return apiClient.requestSyncPlayBuffering({
    When: localToRemote(new Date()).toISOString(),
    PositionTicks: Math.round(positionTicks),
    IsPlaying: isPlaying,
    PlaylistItemId: playlistItemId,
  });
}

export function publishQueue(itemId, startPositionTicks) {
  if (!apiClient) return Promise.reject(new Error('SyncPlay not started'));
  if (typeof apiClient.requestSyncPlaySetNewQueue !== 'function') {
    console.warn('Jellio SyncPlay: this server\'s own ApiClient has no requestSyncPlaySetNewQueue, too old for real SyncPlay queue publishing');
    return Promise.reject(new Error('requestSyncPlaySetNewQueue not available'));
  }
  console.debug('Jellio SyncPlay: publishing queue', itemId, startPositionTicks);
  return apiClient.requestSyncPlaySetNewQueue({
    PlayingQueue: [itemId],
    PlayingItemPosition: 0,
    StartPositionTicks: Math.round(startPositionTicks || 0),
  });
}

export function notifyReady(positionTicks, isPlaying, playlistItemId) {
  if (!apiClient) return Promise.reject(new Error('SyncPlay not started'));
  return apiClient.requestSyncPlayReady({
    When: localToRemote(new Date()).toISOString(),
    PositionTicks: Math.round(positionTicks),
    IsPlaying: isPlaying,
    PlaylistItemId: playlistItemId,
  });
}

export function getSyncUserId() {
  return getCurrentUserId();
}
