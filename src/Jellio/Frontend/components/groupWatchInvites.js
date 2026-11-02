import { getGroupWatchInvites, getItem, getImageUrl, getCurrentUser } from '../runtime/api.js';
import { isAuthenticated, getCurrentUserId } from '../runtime/auth.js';
import { joinGroup, onWatchTargetChange, onGroupPresenceChange } from '../runtime/syncPlay.js';
import { navigateTo, parseRoute } from '../runtime/router.js';
import { showGroupWatchNotice } from './groupWatchNotice.js';

const POLL_INTERVAL_MS = 5000;

let started = false;
let lastInviteId = 0;

// Remembered per user, so an invite already shown (or clicked away) doesn't
// come back on every reload.
function seenKey() {
  return 'jellio_groupwatch_invite_seen_' + (getCurrentUserId() || '');
}

function loadLastInviteId() {
  try {
    return Number(window.localStorage.getItem(seenKey())) || 0;
  } catch (err) {
    return 0;
  }
}

function saveLastInviteId() {
  try {
    window.localStorage.setItem(seenKey(), String(lastInviteId));
  } catch (err) {
    // Not persisted: invites may show once more after a reload.
  }
}
let myUserName = '';

function pollInvites() {
  getGroupWatchInvites(lastInviteId)
    .then(function (invites) {
      (invites || []).forEach(function (invite) {
        lastInviteId = Math.max(lastInviteId, invite.Id);
        saveLastInviteId();
        showGroupWatchNotice({
          icon: 'mail',
          header: 'Group Watch Invite',
          text: (invite.FromUserName || 'Someone') + ' invited you to join ' + (invite.GroupName || 'Group Watch'),
          cta: 'Click to join',
          onClick: function () {
            joinGroup(invite.GroupId).catch(function (err) {
              console.warn('Jellio: could not join Group Watch group from invite', err);
            });
          },
        });
      });
    })
    .catch(function () {
      // A missed poll just tries again next tick, same as chat's own.
    })
    .then(function () {
      window.setTimeout(pollInvites, POLL_INTERVAL_MS);
    });
}

function handleWatchTargetChange(target) {
  const route = parseRoute();
  console.debug('Jellio: watch target changed to', target, 'current route is', route);
  if (route.path === 'play' && route.params.get('id') === target.itemId) return;

  getItem(target.itemId)
    .then(function (item) {
      const isEpisode = item && item.Type === 'Episode';
      const name = item && (isEpisode && item.SeriesName ? item.SeriesName : item.Name);
      const artId = isEpisode && item.SeriesId ? item.SeriesId : target.itemId;
      showGroupWatchNotice({
        imageUrl: getImageUrl(artId, 'Primary', { maxWidth: 200 }),
        header: 'Group Watch',
        text: 'The group started watching ' + (name || 'something'),
        cta: 'Click to join',
        onClick: function () {
          navigateTo('#/play?id=' + target.itemId + '&groupJoin=1');
        },
      });
    })
    .catch(function () {
      showGroupWatchNotice({
        icon: 'play_circle',
        header: 'Group Watch',
        text: 'The group started watching something',
        cta: 'Click to join',
        onClick: function () {
          navigateTo('#/play?id=' + target.itemId + '&groupJoin=1');
        },
      });
    });
}

function handleGroupPresenceChange(kind, name) {
  if (!name || name === myUserName) return;
  showGroupWatchNotice({
    icon: kind === 'joined' ? 'person_add' : 'person_remove',
    header: 'Group Watch',
    text: name + (kind === 'joined' ? ' joined the group' : ' left the group'),
  });
}

export function startGroupWatchInvites() {
  if (started || !isAuthenticated()) return;
  started = true;
  onWatchTargetChange(handleWatchTargetChange);
  onGroupPresenceChange(handleGroupPresenceChange);
  getCurrentUser()
    .then(function (user) {
      if (user && user.Name) myUserName = user.Name;
    })
    .catch(function () {
      // A reader's own name only being used to self suppress a notice,
      // not fatal to the rest of this file if it never resolves.
    });
  lastInviteId = loadLastInviteId();
  pollInvites();
}
