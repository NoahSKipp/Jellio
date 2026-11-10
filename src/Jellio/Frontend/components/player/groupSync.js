// Group Watch: applying SyncPlay commands, queue publishing and the wait-for-others banner.
// Built by screens/player.js; live is its playerLive accessor object.

import {
  getCurrentGroup,
  getSyncUserId,
  estimateCurrentTicks,
  getCurrentPlaylistTarget,
  getLastCommand as getLastSyncCommand,
  leaveGroup as leaveSyncGroup,
  notifyBuffering,
  notifyReady,
  onCommand as onSyncCommand,
  onGroupChange as onSyncGroupChange,
  publishQueue as publishSyncQueue,
  remoteToLocal,
  requestUnpause as requestSyncUnpause,
  sameId as sameSyncId,
} from '../../runtime/syncPlay.js';
import { getJoinSync, clearJoinSync, sendGroupWatchMessage, startJoinSync } from '../../runtime/apiSocial.js';
import { TICKS_PER_SECOND } from '../../runtime/api.js';
import { askCatchUp, createPartyLayer } from '../partyLayer.js';
import { syncDriftSeconds as driftFromCommand } from '../../runtime/syncDrift.js';
import { navigateTo } from '../../runtime/router.js';
import { t } from '../../runtime/i18n.js';

export function startSyncWaitPoll(deps, live) {
  const { scope, syncWaitBanner, syncWaitText } = deps;

  const SYNC_WAIT_POLL_MS = 3000;
  let syncWaitVisible = false;
  function describeSyncWait(entries) {
    const names = entries.map(function (entry) {
      return entry.UserName || 'Someone';
    });
    if (names.length === 1) return 'Waiting for ' + names[0] + ' to finish loading in…';
    if (names.length === 2) return 'Waiting for ' + names[0] + ' and ' + names[1] + ' to finish loading in…';
    return 'Waiting for ' + names[0] + ' and ' + (names.length - 1) + ' others to finish loading in…';
  }
  function pollSyncWait() {
    const group = getCurrentGroup();
    if (!group || !live.syncPlaylistItemId) {
      if (syncWaitVisible) {
        syncWaitVisible = false;
        syncWaitBanner.classList.remove('jellio-player-sync-wait-visible');
      }
      return;
    }
    getJoinSync(group.GroupId, live.syncPlaylistItemId)
      .then(function (entries) {
        const myUserId = getSyncUserId();
        const others = (entries || []).filter(function (entry) {
          return entry.UserId !== myUserId;
        });
        if (others.length) {
          syncWaitText.textContent = describeSyncWait(others);
          syncWaitVisible = true;
          syncWaitBanner.classList.add('jellio-player-sync-wait-visible');
        } else if (syncWaitVisible) {
          syncWaitVisible = false;
          syncWaitBanner.classList.remove('jellio-player-sync-wait-visible');
        }
      })
      .catch(function () {});
  }
  scope.interval(pollSyncWait, SYNC_WAIT_POLL_MS);
  pollSyncWait();
}

export function wireGroupSync(deps, live) {
  const {
    attemptPlay, currentPositionTicks, isEpisodeItem, isGroupJoinNavigation, isInitialGroupCatchUp, itemId,
    root, seekToAbsoluteSeconds, showPlayerToast, video, waitForPlayableBuffer,
  } = deps;

  const SYNC_DRIFT_THRESHOLD_SECONDS = 1.5;
  let scheduledSyncTimeout = null;
  function clearScheduledSync() {
    if (scheduledSyncTimeout) {
      window.clearTimeout(scheduledSyncTimeout);
      scheduledSyncTimeout = null;
    }
  }

  function syncDriftSeconds(command) {
    return driftFromCommand(currentPositionTicks(), command, estimateCurrentTicks, TICKS_PER_SECOND);
  }

  // Every command bumps this; work a command left waiting (a reload, a
  // buffer wait) checks it so a newer command always wins.
  let syncGeneration = 0;
  let lastAppliedSyncCommand = null;

  function syncSeekThenReady(targetSeconds, generation) {
    const playlistItemId = live.syncPlaylistItemId;
    video.pause();
    notifyBuffering(currentPositionTicks(), false, playlistItemId).catch(function () {});
    seekToAbsoluteSeconds(Math.max(0, targetSeconds)).then(function () {
      waitForPlayableBuffer(function () {
        if (generation !== syncGeneration || playlistItemId !== live.syncPlaylistItemId) return;
        notifyReady(currentPositionTicks(), false, playlistItemId).catch(function () {});
      });
    });
  }

  function applySyncCommand(command) {
    if (command.PlaylistItemId !== live.syncPlaylistItemId) return;
    lastAppliedSyncCommand = command;
    clearScheduledSync();
    const generation = ++syncGeneration;

    function run() {
      if (generation !== syncGeneration) return;
      switch (command.Command) {
        case 'Unpause':
          if (syncDriftSeconds(command) > SYNC_DRIFT_THRESHOLD_SECONDS) {
            syncSeekThenReady(estimateCurrentTicks(command.PositionTicks || 0, command.When) / TICKS_PER_SECOND, generation);
          } else {
            attemptPlay();
          }
          break;
        case 'Pause':
          video.pause();
          if (syncDriftSeconds(command) > SYNC_DRIFT_THRESHOLD_SECONDS) {
            seekToAbsoluteSeconds(Math.max(0, (command.PositionTicks || 0) / TICKS_PER_SECOND));
          }
          break;
        case 'Seek':
          // The server waits for every member's Ready after a seek; a seek
          // inside the buffer fires no canplay, so Ready is sent here.
          syncSeekThenReady((command.PositionTicks || 0) / TICKS_PER_SECOND, generation);
          break;
        case 'Stop':
          video.pause();
          break;
        default:
          break;
      }
    }

    const delay = remoteToLocal(command.When).getTime() - Date.now();
    if (delay > 0) {
      scheduledSyncTimeout = window.setTimeout(run, delay);
    } else {
      run();
    }
  }

  let syncQueuePublishAttempted = false;
  console.debug('Jellio: player sync check, group is', getCurrentGroup(), 'syncPlaylistItemId is', live.syncPlaylistItemId);

  live.unsubscribeSyncCommand = onSyncCommand(applySyncCommand);

  live.partyLayer = createPartyLayer({
    root: root,
    itemId: itemId,
    getPlaylistItemId: function () {
      return live.syncPlaylistItemId;
    },
    getPositionTicks: currentPositionTicks,
    getUserId: getSyncUserId,
    toast: showPlayerToast,
  });

  // Joining well into the group's title: follow the group or start alone.
  if (isInitialGroupCatchUp && live.startTicks > 120 * TICKS_PER_SECOND) {
    askCatchUp(root, live.startTicks / TICKS_PER_SECOND).then(function (choice) {
      if (choice !== 'solo' || live.screenTornDown) return;
      if (live.joinSyncGroupId) clearJoinSync(live.joinSyncGroupId).catch(function () {});
      leaveSyncGroup()
        .catch(function () {})
        .then(function () {
          navigateTo('#/play?id=' + encodeURIComponent(itemId) + '&fromStart=1');
        });
    });
  }

  function maybePublishQueue() {
    if (syncQueuePublishAttempted || !getCurrentGroup() || isGroupJoinNavigation) return;
    syncQueuePublishAttempted = true;
    publishSyncQueue(itemId, live.startTicks)
      .then(function () {
        console.debug('Jellio: published Group Watch queue for', itemId);
        const syncGroup = getCurrentGroup();
        if (syncGroup) {
          const watchingName = isEpisodeItem ? live.item.SeriesName : live.item.Name;
          sendGroupWatchMessage(syncGroup.GroupId, 'The group started watching ' + (watchingName || 'something'), itemId).catch(function () {});
        }
        if (!(live.partyLayer && live.partyLayer.published())) {
          waitForPlayableBuffer(function () {
            requestSyncUnpause().catch(function (err) {
              console.warn('Jellio: could not send initial Group Watch unpause', err);
            });
          });
        }
        window.setTimeout(function () {
          if (!live.syncPlaylistItemId) {
            showPlayerToast(t('player_sync_no_access'));
          }
        }, 6000);
      })
      .catch(function (err) {
        console.warn('Jellio: could not publish Group Watch queue', err);
      });
  }

  live.unsubscribeSyncGroupChange = onSyncGroupChange(function () {
    const target = getCurrentPlaylistTarget();
    const previousPlaylistItemId = live.syncPlaylistItemId;
    live.syncPlaylistItemId = target && sameSyncId(target.itemId, itemId) ? target.playlistItemId : null;
    // A command for this queue item can arrive before this player knew it
    // was the group's: apply the last one now instead of losing it.
    if (live.syncPlaylistItemId && live.syncPlaylistItemId !== previousPlaylistItemId) {
      const missed = getLastSyncCommand();
      if (missed && missed !== lastAppliedSyncCommand && missed.PlaylistItemId === live.syncPlaylistItemId
        && Date.now() - remoteToLocal(missed.When).getTime() < 60000) {
        applySyncCommand(missed);
      }
    }
    if (live.syncPlaylistItemId && video.readyState >= 3) {
      notifyReady(currentPositionTicks(), !video.paused, live.syncPlaylistItemId).catch(function () {});
      if (live.partyLayer) live.partyLayer.markReady(live.syncPlaylistItemId);
    } else if (live.syncPlaylistItemId && !live.joinSyncActive && target && target.isPlaying) {
      live.joinSyncActive = true;
      live.joinSyncGroupId = getCurrentGroup().GroupId;
      notifyBuffering(currentPositionTicks(), !video.paused, live.syncPlaylistItemId).catch(function () {});
      startJoinSync(live.joinSyncGroupId, live.syncPlaylistItemId).catch(function () {});
    }
    maybePublishQueue();
  });

  maybePublishQueue();
  return { clearScheduledSync };
}
