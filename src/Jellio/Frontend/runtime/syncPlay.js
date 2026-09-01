// Real Jellyfin SyncPlay client core, independent of native jellyfin-web's
// own plugins/syncPlay (that code never runs, native rendering is hidden
// entirely, see app.js's own header), but interoperable with it: any
// native client in the same group gets and sends the exact same real
// wire messages this file does, confirmed against real source before
// writing a line here rather than guessed at:
//   - jellyfin/jellyfin's own SyncPlayController.cs for every REST action
//     shape (Join/Seek/Buffering/Ready/Ping, field names included).
//   - jellyfin/jellyfin-apiclient-javascript's own apiClient.js for how
//     an incoming WebSocket message actually reaches calling code:
//     onWebSocketMessage() parses it, then always calls
//     `events.trigger(instance, 'message', [msg])`. That events module
//     (its own tiny events.js) does nothing but push the callback onto
//     `instance._callbacks[eventName]` and later walk that same array,
//     no closure state of its own, so this file below reimplements that
//     six line push directly against window.ApiClient rather than
//     needing to import a module instance native's own separately
//     bundled copy of the package could never actually share with this
//     independently loaded bundle.
//   - jellyfin/jellyfin-web's own plugins/syncPlay/core/{TimeSync,
//     TimeSyncServer,PlaybackCore,Manager,QueueCore}.js for the actual
//     clock offset algorithm (NTP style, GetUTCTime, min-delay pick of
//     recent measurements) and for the real GroupUpdate/Command message
//     shapes (Type/Data, Command/When/PositionTicks/PlaylistItemId).
//
// Deliberately narrower than native's own PlaybackCore in one place:
// this only does SkipToSync (seek to correct), not SpeedToSync
// (temporarily changing playbackRate to catch up). Both are real
// supported strategies server side, SkipToSync alone is still fully
// interoperable and fully real, just a plainer correction than a
// playbackRate ramp screens/player.js's own bare <video> element has no
// existing hook for anyway.
import { getCurrentUserId } from './auth.js';
import { getSyncPlayGroups, getCurrentUser } from './api.js';

const TicksPerMillisecond = 10000;
const MaxMeasurements = 6;
const PingIntervalMs = 30000;
const ReconcileIntervalMs = 15000;
// Local correction thresholds, in milliseconds of drift. Below this,
// left alone: normal player jitter, correcting it would fight itself.
const SkipToSyncThresholdMs = 400;
// How long a hidden tab is left grouped before this session leaves on its
// own. pingServerTime()/reconcileGroupMembership() below are both real
// REST/WS activity, on their own real interval regardless of whether a
// human is actually looking at this tab, so a tab someone only ever
// backgrounds (never closes) keeps its own real Jellyfin session looking
// continuously active server side forever, the exact reason a real group
// created hours ago with nobody left actually watching was still found
// alive: nothing about this file's own architecture ever went quiet
// enough for real Jellyfin's own SessionManager to ever decide this
// session had ended (confirmed against SyncPlayManager.cs's own
// OnSessionEnded and Group.cs's own IsGroupEmpty(), which already
// reclaims a group the moment every member session genuinely ends, no
// Jellio side group lifecycle of its own needed once that fires).
const IdleTabLeaveThresholdMs = 30 * 60 * 1000;
// Real upstream Jellyfin bug, confirmed against jellyfin/jellyfin#8140 and
// #4680 (both real, both still open/closed not planned): a left group can
// sit stuck on the server's own side, /SyncPlay/List still listing this
// session as a Participant well after a real, successful Leave request.
// reconcileGroupMembership()'s own real join side below exists to recover
// a lost GroupJoined push by trusting that exact same REST snapshot, so
// without this, a stuck server side leave meant this file spent every
// ReconcileIntervalMs tick undoing the reader's own real Leave click,
// rejoining them right back into the group they just left, reported live
// as "can't leave group". This grace window is the fix: no different
// from the identical real gap this file already accepts on the join
// side (a lost push, not a wrong answer, the REST snapshot itself still
// trusted the moment this window closes), just biased toward the
// reader's own most recent explicit action for long enough to cover it.
const ExplicitLeaveGraceMs = 20000;

let started = false;
let explicitLeaveUntil = 0;
let apiClient = null;
let timeOffsetMeasurements = [];
let pingTimer = null;
let reconcileTimer = null;
let idleLeaveTimer = null;
let myUserName = '';

let currentGroup = null; // GroupInfoDto, or null when not in a group
let currentQueue = null; // last PlayQueueUpdate seen
let lastCommand = null; // last SyncPlayCommand applied, {Command, When, PositionTicks, PlaylistItemId}
// The real PlaylistItemId this session has already notified about,
// real join included: null right after a fresh GroupJoined (nothing
// seen yet, so the very next PlayQueue update always counts as new),
// reset again on GroupLeft/NotInGroup. onWatchTargetChange() below
// fires whenever a PlayQueue update resolves to a PlaylistItemId that
// differs from this, covering "just joined a group already playing
// something", "already in a group that just started, or switched to,
// something else", and a real explicit restart of the exact same
// title: a fresh publishSyncQueue() call always mints a brand new
// real PlaylistItemId server side even when the underlying real item
// id is unchanged (confirmed against real SyncPlay source, a queue
// entry's own identity, not the title's), so tracking by that instead
// of the plain item id is what actually tells a genuine restart apart
// from nothing having changed at all. Real feedback found live: the
// first version of this only ever fired once, right at join, so a
// member already in a group got no real nudge at all the next time
// whoever started it picked something new; a later version tracked
// the plain item id instead, real feedback again: the group's own
// chat message correctly sent on every real restart (screens/
// player.js's own maybePublishQueue() already tracks this per mount,
// not globally), this file's own toast did not.
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

// Real feedback loop: this pushes straight onto window.ApiClient's own
// _callbacks.message array, the exact same array its own bundled
// events.js reads from when the socket receives something, see this
// file's own header above for why importing that module directly is not
// an option here.
function bindApiClientMessage(fn) {
  const client = window.ApiClient;
  if (!client) return;
  client._callbacks = client._callbacks || {};
  client._callbacks.message = client._callbacks.message || [];
  client._callbacks.message.push(fn);
}

// Deliberately loud rather than silent: this whole feature depends on
// window.ApiClient._callbacks.message actually being the real array
// native's own bundled events.js reads from (this file's own header
// explains why), an internal field name a future Jellyfin release could
// rename without warning, and a reverse proxy that does not pass a real
// WebSocket upgrade through (a real, common self hosted misconfiguration,
// native's own SyncPlay depends on the exact same connection and would
// be equally broken) would leave this silently getting nothing at all.
// Logging every real message type that actually arrives here is the one
// real way to tell those two failure modes apart from a group simply
// not existing yet, without needing to reproduce this live.
// KeepAlive/ForceKeepAlive are sent to every connected session on a flat
// server interval regardless of group membership, real payload is either
// absent or just a numeric interval - confirmed against
// WebSocketConnection.cs's own SendKeepAlive path, nothing group specific
// about it in either direction. Logging them at the same level as every
// other real message this handles here would drown out the messages that
// actually carry something, most of all for a reader in no group at all,
// where these are the only messages ever arriving. Still real traffic
// worth being able to see (this handler's own header above explains why
// logging what arrives here matters at all, a live socket that only ever
// sends KeepAlive still proves the socket itself is fine), just not at
// the same volume: this file's own header already explains the real
// silent-failure modes this logging exists to catch, and neither of
// those needs a fresh log line every single keepalive tick to be caught.
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

// Shared by the real GroupJoined push (handleGroupUpdate below) and
// reconcileGroupMembership's own fallback for when that push never
// actually arrives, same reset either way: a freshly joined group means
// nothing about its queue or last command is ours to trust yet.
function applyGroupJoined(groupData) {
  currentGroup = groupData;
  currentQueue = null;
  lastCommand = null;
  lastNotifiedPlaylistItemId = null;
  notifyGroupListeners();
}

// Shared by the real NotInGroup/GroupLeft push and
// reconcileGroupMembership()'s own fallback for the mirror case that push
// covers when it actually arrives: this session genuinely left (or was
// removed from) its group, whether or not the confirmation ever reached
// this exact identity's own WebSocket.
function resetGroupState() {
  currentGroup = null;
  currentQueue = null;
  lastCommand = null;
  lastNotifiedPlaylistItemId = null;
  notifyGroupListeners();
}

// Native jellyfin-web's own SyncPlay Manager.js still runs in the
// background (app.js's own header explains why: hidden, not unloaded)
// and calls its own toast() for the exact same real UserJoined/UserLeft
// broadcast this file already turns into its own styled notice
// (components/groupWatchInvites.js's own handleGroupPresenceChange),
// confirmed against real jellyfin-web source: a synchronous
// document.body.appendChild into a shared .toastContainer, z-index
// 9999999, well above #jellioRoot's own 9999, no suppression hook or
// event bus of any kind exposed for it. Real fix here does not need
// one: both this file's own onApiClientMessage and native's own
// Manager.js read off the exact same real client._callbacks.message
// array, walked synchronously by the same real WebSocket dispatch,
// so a MutationObserver armed the moment this file also sees the same
// real UserJoined/UserLeft still catches native's own already-inserted
// node, its own callback is a real microtask, scheduled only after
// this entire synchronous dispatch (native's handler included,
// whichever order the two actually ran in) has already finished.
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
      // Real bug, live-reported: this file's own suppressNextNativeToast()
      // only ever ran for UserJoined/UserLeft. Native jellyfin-web's own
      // Manager.js (confirmed against real source) calls its own
      // enableSyncPlay() straight off this exact same GroupJoined push,
      // which always shows its own "SyncPlay Enabled" toast, showMessage
      // hardcoded true, nothing this file's own suppression window ever
      // caught before now.
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
      // Mirror of the GroupJoined case above: native's own
      // disableSyncPlay(true) runs off this exact same push, its own
      // "SyncPlay Disabled" toast just as uncaught until now.
      suppressNextNativeToast();
      resetGroupState();
      break;
    case 'StateUpdate':
      // Idle/Waiting/Paused/Playing, not needed for playback scheduling
      // itself (real commands below already drive that), only useful
      // for a status label, left to callers via getGroupState().
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

// Real Jellyfin UserDataChanged: fires on this exact same already open
// WebSocket for a resume position, played state or favorite change on
// ANY of this user's own sessions, not just this one (confirmed against
// real UserDataChangeInfo/SessionManager source before writing this),
// the real reason this codebase's own screens/home.js can keep its
// Continue Watching row live across tabs/devices for free rather than
// polling for it: the connection this rides is already open for real
// SyncPlay regardless of whether this reader is ever in a group at all.
// Filtered to this reader's own UserId: real Jellyfin's own broadcast
// scoping already keeps another account's changes off this exact
// socket in every real deployment this was checked against, but
// nothing here should silently depend on that holding forever.
function handleUserDataChanged(data) {
  if (!data || !data.UserDataList || data.UserId !== getCurrentUserId()) return;
  notifyUserDataListeners(data.UserDataList);
}

// NTP style offset: (requestReceived - requestSent) + (responseSent -
// responseReceived), halved. Positive means the server clock is ahead of
// this device's own clock. Keeps the last few measurements and picks the
// one with the smallest round trip delay, same real strategy
// TimeSync.js's own updateTimeOffset() uses, just without that file's
// separate low/high polling profile since this runtime pings on a flat
// interval instead.
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

// Real feedback: this and reconcileGroupMembership() below both ran on
// their own real interval for the whole life of the page regardless of
// whether the reader had ever so much as opened Group Watch, two real
// requests every ReconcileIntervalMs forever, tab backgrounded or not.
// Neither one has anything real to do while nothing is actually
// looking at this tab: a clock offset measurement only matters the
// next time a real SyncPlayCommand needs converting to this device's
// own local time, and reconcile exists to catch a join/leave push that
// never arrived, not something a backgrounded tab needs to know about
// the instant it happens. onVisibilityChange() further down fires one
// real tick of each the moment this tab is actually looked at again,
// so neither one is ever real more than one real interval stale by the
// time either could actually matter again.
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

// Real bug, found live: currentGroup above is only ever set by a real
// pushed GroupJoined/GroupUpdate message, and real Jellyfin's own
// WebSocket never replays "you are already in group X" on a fresh
// connect, only on an actual real change from then on. A reader already
// a member from earlier in the session (or from before this page ever
// loaded, a real group survives a reload same as it would for any other
// real client) could sit with a null currentGroup here forever, no
// error, nothing to see: screens/player.js's own publishSyncQueue() call
// is gated on getCurrentGroup() being truthy, so a reader in that state
// who starts something never actually queues it for the group at all,
// the exact real "started a show, nobody else got a prompt" symptom
// this reconciles against the same real /SyncPlay/List endpoint
// components/groupWatch.js's own list already trusts for membership
// (matched by this session's own display name, the same real field that
// endpoint's own Participants array carries, confirmed against real
// GroupInfoDto source, which has no user id of its own to match on
// instead).
//
// Deliberately re-joins rather than just trusting that REST snapshot
// straight into currentGroup: real group membership server side is
// keyed by this exact session's own real session.Id
// (Emby.Server.Implementations/SyncPlay/SyncPlayManager.cs's own
// _sessionToGroupMap, confirmed against real source), not by user, and
// not by whatever this reader's own display name happens to already
// show up as a Participant under from some other, possibly stale,
// session. Setting currentGroup directly from Participants here would
// leave THIS session still genuinely unauthorized the moment it
// actually tried a real group action (SetNewQueue and every other
// SyncPlayIsInGroup gated endpoint), a silent 403 with nothing in this
// file able to explain it. JoinGroupRequest's own real server handler
// (SyncPlayManager.cs's own JoinGroup()) already handles a session
// that is already a member of the target group safely, as a real
// "restore session" case, itself still always sending a fresh real
// GroupJoined push back (Group.cs's own SessionJoin(), confirmed
// against real source). Normally that push is what sets currentGroup,
// through the exact same applyGroupJoined() path every other join
// already goes through. Live testing found a real case where that push
// never actually arrives even though the join itself genuinely
// succeeded (two session identities sharing this one page, native
// jellyfin-web's own SyncPlay plugin also live on the same WebSocket,
// real suspects), leaving this stuck re-joining every tick forever with
// nothing to show for it. The short setTimeout fallback below is for
// exactly that: once this session's own join has actually resolved, a
// push that still hasn't shown up a few seconds later isn't coming, so
// applyGroupJoined() runs directly off the REST snapshot already in
// hand instead of waiting on it forever.
// Real feedback: this used to log its own result unconditionally on
// every real tick, ReconcileIntervalMs above meaning every 15s for the
// entire life of the page, group or no group. A reader never in a group
// at all (the common real case, most of a session) got exactly the same
// "found group null, current group is null" line forever, no different
// tick to tick, drowning out every other real log line in this file
// including the ones that actually explain something. Tracked here so
// the line below only actually prints when the reconciled answer is
// different from the last time this ran, still real diagnostic
// evidence (this function's own real job, explained above, of noticing
// a push that never arrived either direction), just not repeated once a
// tick has already reported it.
let lastLoggedReconcileGroupId = undefined;

async function reconcileGroupMembership() {
  if (document.visibilityState === 'hidden') return;
  try {
    const [groups, user] = await Promise.all([getSyncPlayGroups(), getCurrentUser()]);
    if (user && user.Name) myUserName = user.Name;
    if (!myUserName) return;
    const mine = (groups || []).find(function (group) {
      return (group.Participants || []).indexOf(myUserName) !== -1;
    });
    const mineGroupId = mine && mine.GroupId;
    if (mineGroupId !== lastLoggedReconcileGroupId) {
      lastLoggedReconcileGroupId = mineGroupId;
      console.debug('Jellio SyncPlay: reconcile found group', mineGroupId, 'current group is', currentGroup && currentGroup.GroupId);
    }
    if (mine && Date.now() < explicitLeaveUntil) {
      // ExplicitLeaveGraceMs above explains why: a stuck server side
      // leave (real upstream bug) still listing this session as a
      // Participant is not this reconcile's own lost-push case to fix,
      // rejoining right back into a group the reader only just left.
      return;
    }
    if (mine && (!currentGroup || currentGroup.GroupId !== mine.GroupId)) {
      const joinedGroupId = mine.GroupId;
      try {
        await joinGroup(joinedGroupId);
      } catch (err) {
        console.warn('Jellio SyncPlay: could not re-join own group during reconcile', err);
        return;
      }
      // The real join call above just resolved on this exact session, so
      // this session genuinely is a member now, real Group.cs source
      // confirmed above, whether or not the fresh GroupJoined push this
      // same join always sends ever actually reaches
      // onApiClientMessage. A push that lands first wins normally (same
      // applyGroupJoined() either way); this is only for the push that
      // never shows up at all, so reconcile stops silently re-joining
      // every tick forever with nothing to show for it.
      window.setTimeout(function () {
        if (!currentGroup || currentGroup.GroupId !== joinedGroupId) {
          console.warn('Jellio SyncPlay: GroupJoined push never arrived after a real join, applying the REST snapshot directly');
          applyGroupJoined(mine);
        }
      }, 3000);
    } else if (!mine && currentGroup) {
      // Mirror case: this session left (leaveGroup(), or was removed
      // server side) but the real NotInGroup/GroupLeft push confirming
      // that never reached this exact identity's own WebSocket, same
      // real gap the join side above already works around. The REST
      // snapshot above is already the ground truth this reader trusts
      // for the join case, so it is just as trustworthy here: if this
      // session's own display name is genuinely not a participant of
      // any group any more, nothing server side is still waiting on a
      // push, only this file's own stale local state is.
      console.warn('Jellio SyncPlay: reconcile found this session is no longer a participant, clearing stale local group state for', currentGroup.GroupId);
      resetGroupState();
    }
  } catch (err) {
    console.warn('Jellio SyncPlay: reconcile failed', err);
  }
}

// Called once, from app.js's own sync() alongside startNowPlaying():
// SyncPlay needs the same real WebSocket open for the life of the page,
// not lazily from screens/player.js only, both so a pending group's own
// commands are never missed while browsing and so a real invite (a
// separate, Jellio owned polled channel, see runtime/api.js's own header
// on getGroupWatchInvites for why this WebSocket cannot carry that too)
// still lines up with an already-current group state by the time a
// reader acts on it.
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
    // pingServerTime()/reconcileGroupMembership() above both skip their
    // own real work while hidden, real feedback's own reason this file
    // no longer polls forever for a tab nobody is looking at; one real
    // tick of each right here means neither is ever more than one real
    // ReconcileIntervalMs stale by the time this tab is actually looked
    // at again, not however long is left on whatever interval was
    // already in flight when it was backgrounded.
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
  // Real feedback: a socket that never actually opens (a reverse proxy
  // in front of this deployment not passing a real WebSocket upgrade
  // through, a common self hosted misconfiguration native's own
  // SyncPlay would be equally broken by) fails with nothing visible
  // anywhere in this file otherwise, ensureWebSocket() above only ever
  // throws for the synchronous setup case, never for a handshake that
  // starts and then just never completes. One real check a few seconds
  // in is enough to tell that apart from every other real failure mode
  // this file already logs for.
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

// The real item id (and PlaylistItemId) the group is currently on, or
// null when the queue has nothing playing yet. Used for the join prompt:
// a reader who joins a group already mid episode gets offered a jump to
// that title rather than silently sitting on whatever page they were
// already on.
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

// Fires whenever the reader's own current group's real playing item
// changes to one this session has not already notified about, with
// { itemId, playlistItemId, startPositionTicks, isPlaying }: a real join
// into a group already playing something (nothing notified yet this
// session, so the first PlayQueue update always counts as new), and
// every later item change too, someone else in the group picking
// something new while this reader is already a member. Real feedback:
// the first version of this only ever covered the join case, so an
// existing member got no real nudge at all when the group moved on to
// something else, "group shown as Playing X in the list, with no way to
// actually reach X" all over again just past the moment of joining.
// components/groupWatchInvites.js's own handler is the one place this
// gets filtered down to "not the reader who is already on this exact
// item" (checked against the current real route there, not here: this
// file has no idea what screen is actually open).
export function onWatchTargetChange(fn) {
  watchTargetListeners.push(fn);
  return function unsubscribe() {
    const index = watchTargetListeners.indexOf(fn);
    if (index !== -1) watchTargetListeners.splice(index, 1);
  };
}

// Real UserJoined/UserLeft, fn called as (kind, name) with kind either
// 'joined' or 'left'. Native jellyfin-web's own SyncPlay UI still runs
// in the background (app.js's own header explains why: hidden, not
// unloaded) and shows its own native styled toast for both, real
// feedback asked for this runtime's own equivalent instead, matching
// the rest of this UI rather than looking like a native page leaking
// through.
export function onGroupPresenceChange(fn) {
  presenceListeners.push(fn);
  return function unsubscribe() {
    const index = presenceListeners.indexOf(fn);
    if (index !== -1) presenceListeners.splice(index, 1);
  };
}

// handleUserDataChanged's own header above explains where this actually
// comes from. fn called with the real UserItemDataDto array a single
// change can carry more than one of (confirmed against real source,
// not assumed to always be exactly one entry).
export function onUserDataChange(fn) {
  userDataListeners.push(fn);
  return function unsubscribe() {
    const index = userDataListeners.indexOf(fn);
    if (index !== -1) userDataListeners.splice(index, 1);
  };
}

export { remoteToLocal, localToRemote, estimateCurrentTicks, getTimeOffsetMs, TicksPerMillisecond, SkipToSyncThresholdMs };

// Client initiated actions below, all going through window.ApiClient's
// own already authenticated SyncPlay REST helpers (confirmed field names
// against SyncPlayController.cs) rather than this file hand rolling
// fetch() calls runtime/api.js would otherwise need to duplicate.

// Real feedback, found live by matching real server side Session and
// SyncPlay category Debug logs against each other: the exact session id
// this file's own Join/Play/etc calls run under could be a real session
// that never once owns a real WebSocket connection. A close+reopen of
// the real socket right before this identity's own first real action
// used to live here to work around that gap. Real feedback since:
// exactly one such realignment, tied to whichever real action happened
// to run first after a real page load, reliably kicked the reader
// clean out of their own group ("thrown out... have to join again"),
// only ever once per load, matching the one-shot flag this used to
// gate on precisely. Real root cause found and fixed properly instead
// (runtime/auth.js's own syncNativeApiClientState(), confirmed against
// real apiClient.js source): setAuthenticationInfo() only ever swapped
// the token, leaving window.ApiClient's own _deviceId/_appName/
// _deviceName/_appVersion sitting at whatever native's own construction
// set them to, a real REST/WebSocket identity split this exact realign
// was closing over rather than actually closing. That fix keeps every
// one of those fields consistent with the token the moment a real
// login (native capture or this runtime's own) actually happens, before
// startSyncPlay() below ever opens a first real socket at all, so the
// join/publish/leave calls immediately below need no realignment of
// their own left over from before that fix existed, only the one real
// gap it does not cover: a genuinely stale REST snapshot, which
// reconcileGroupMembership() above already works around on its own.
export function joinGroup(groupId) {
  if (!apiClient) return Promise.reject(new Error('SyncPlay not started'));
  // A fresh, explicit join always supersedes an earlier leave's own
  // grace window (ExplicitLeaveGraceMs above): this reader's real intent
  // just changed back to "be in a group", reconcile's own real recovery
  // for a lost push on this exact join should not stay suppressed
  // behind a leave that is no longer the last real thing they did.
  explicitLeaveUntil = 0;
  return apiClient.joinSyncPlayGroup({ GroupId: groupId });
}

export function leaveGroup() {
  if (!apiClient) return Promise.reject(new Error('SyncPlay not started'));
  explicitLeaveUntil = Date.now() + ExplicitLeaveGraceMs;
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

// Publishes a single item queue to the reader's own current group,
// screens/player.js's own real fix for the exact bug that started this
// whole feature ("I joined a group and nothing happened, group just
// shows idle"): nothing ever populated a real queue for it, since a
// Jellio reader joining or starting a group never called this before.
// A native client's own SyncPlay button already does the same real
// call the moment it starts something while in a group; this is that,
// from this runtime's own player screen instead.
export function publishQueue(itemId, startPositionTicks) {
  if (!apiClient) return Promise.reject(new Error('SyncPlay not started'));
  // Real feedback: this method is only present on jellyfin-apiclient-
  // javascript since real Jellyfin 10.7.0 (confirmed against real
  // source), a call against an older bundled version would throw
  // synchronously rather than reject, easy to miss entirely if it ever
  // happened partway through screens/player.js's own render. Checked
  // and logged explicitly instead of letting that surface as a silent
  // crash somewhere else.
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
