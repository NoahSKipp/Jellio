// Two small cross-page Group Watch notifications, both delivered through
// the same bigger real card (components/groupWatchNotice.js, not the
// plain single line components/toast.js: real feedback found live an
// invite or "the group started watching X" read as background noise
// there, easy to miss or dismiss before actually reading it), started
// once from app.js's own sync() alongside startSyncPlay() and
// startNowPlaying():
//
//   - a real invite from another online user (Jellio's own
//     GroupWatchInviteController, polled the same way chat already is,
//     see runtime/api.js's own header on getGroupWatchInvites for why
//     this cannot go over the real SyncPlay WebSocket instead).
//   - the watch target prompt: runtime/syncPlay.js's own
//     onWatchTargetChange() fires whenever the reader's own current
//     group's real playing item changes to one not already notified
//     about this session, real join into a group already playing
//     something and any later item change alike, this is the one real
//     place that gets turned into something a reader can actually act
//     on.
//
// Neither depends on components/groupWatch.js's own panel being open:
// an invite or a group's own item change can land while browsing
// anywhere in the app.
import { getGroupWatchInvites, getItem, getImageUrl, getCurrentUser } from '../runtime/api.js';
import { isAuthenticated } from '../runtime/auth.js';
import { joinGroup, onWatchTargetChange, onGroupPresenceChange } from '../runtime/syncPlay.js';
import { navigateTo, parseRoute } from '../runtime/router.js';
import { showGroupWatchNotice } from './groupWatchNotice.js';

const POLL_INTERVAL_MS = 5000;

let started = false;
let lastInviteId = 0;
let myUserName = '';

function pollInvites() {
  getGroupWatchInvites(lastInviteId)
    .then(function (invites) {
      (invites || []).forEach(function (invite) {
        lastInviteId = Math.max(lastInviteId, invite.Id);
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
  // Covers two real cases at once: the reader who just picked this item
  // themselves (screens/player.js's own publishSyncQueue() call already
  // put them right where this would send them), and a reader whose
  // player screen is already sitting on it, in sync mode or not, real
  // feedback found live a self-notification here read as broken rather
  // than helpful either way. parseRoute() over the target's own
  // startPositionTicks/isPlaying: neither tells this file what screen is
  // actually open, only the current real route does.
  const route = parseRoute();
  console.debug('Jellio: watch target changed to', target, 'current route is', route);
  // app.js's own real route table names this screen 'play', not
  // 'player' (that's only ever the screen file's own name), a real
  // mismatch this self-suppression check and both onClick handlers
  // below shared: this check never actually matched, and the two
  // navigateTo() calls sent a real reader to a route nothing ever
  // registers, native jellyfin-web's own fallback then failing to
  // resolve the raw id on its own.
  if (route.path === 'play' && route.params.get('id') === target.itemId) return;

  getItem(target.itemId)
    .then(function (item) {
      const isEpisode = item && item.Type === 'Episode';
      const name = item && (isEpisode && item.SeriesName ? item.SeriesName : item.Name);
      // Same real series-aware poster fallback components/nowPlaying.js's
      // own buildRow() already uses: an episode shows its series' own
      // artwork, not a one-off frame from the episode itself.
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

// Real UserJoined/UserLeft, real feedback asked for this runtime's own
// styled notice instead of the native jellyfin-web toast the same
// event already shows (that code still runs in the background, hidden
// rather than unloaded, app.js's own header explains why): "X joined
// the group"/"X left the group" fits the rest of this UI, a raw native
// toast never did. Self suppressed by name: this reader's own join or
// leave already shows up in components/groupWatch.js's own real panel
// the moment it happens, a real toast on top of that for a reader's own
// action would only ever be noise.
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
  pollInvites();
}
