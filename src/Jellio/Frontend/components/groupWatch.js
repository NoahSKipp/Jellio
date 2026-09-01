// Group Watch, opened from the sidebar's own rail. Used to just forward
// a click at native jellyfin-web's own hidden .headerSyncButton (that
// header sits under display: none once this shell takes over, so its
// own real SyncPlay menu rendered small and pinned to a corner nothing
// visible actually anchors it to anymore, real feedback live). This is
// a real styled panel instead, driving the same real Jellyfin SyncPlay
// endpoints that menu already did (runtime/api.js's own
// getSyncPlayGroups/createSyncPlayGroup, runtime/syncPlay.js's own
// joinGroup/leaveGroup), same real backend underneath either way.
//
// Real scope, stated plainly rather than left to look finished: this
// covers real group membership, creating, joining, leaving, seeing who
// else is in one, a real chat per group (Jellio's own
// GroupWatchChatController, polled rather than pushed, see
// runtime/api.js's own header on getGroupWatchMessages), and inviting
// any other online user (Jellio's own GroupWatchInviteController, same
// real polling tradeoff, delivered as a toast by
// components/groupWatchInvites.js). Keeping actual playback position and
// state in lockstep once a reader is in a group is runtime/syncPlay.js's
// own job, a real WebSocket backed client screens/player.js drives
// directly; this panel only owns membership, chat and invites.
import {
  getCurrentUser,
  getSyncPlayGroups,
  createSyncPlayGroup,
  getGroupWatchMessages,
  sendGroupWatchMessage,
  sendGroupWatchInvite,
  getOnlineUserIds,
  getUserImageUrl,
  getItem,
  getImageUrl,
  creditGroupWatchStarted,
  voteRankingSession,
} from '../runtime/api.js';
import { getPublicUsers } from '../runtime/auth.js';
import { joinGroup, leaveGroup } from '../runtime/syncPlay.js';
import { navigateTo } from '../runtime/router.js';
import { isGrouplistEnabled } from '../runtime/grouplistSettings.js';
import {
  buildPickTrigger,
  fetchRankingSession,
  startPick,
  renderRankingSession,
  stopRankingCountdown,
} from './groupWatchRanking.js';
import { el } from '../runtime/dom.js';

const OVERLAY_ID = 'jellioGroupWatch';
const CHAT_POLL_MS = 3000;
// Real bug, found live: the group list only ever rendered once, at
// open, and again after this reader's own create/join/leave, real
// feedback was member counts and status sitting stale until the whole
// panel was closed and reopened. Someone else joining or a group
// starting something never updates it on its own without this.
const LIST_POLL_MS = 5000;

function handleKeydown(event) {
  if (event.key === 'Escape') closeGroupWatch();
}

let chatPollTimer = null;
let listPollTimer = null;
// Set by openChatView() the moment it builds its own rankingContainer,
// the one real reference stopChatPoll() (called from both Back and a
// full close, groupWatch.js's own header on the identical real reason
// already covers why) needs to actually stop that container's own
// countdown interval alongside the chat poll timer right here, rather
// than leaving it running orphaned. groupWatchRanking.js's own header
// on stopRankingCountdown() explains the real bug this closes off.
let activeRankingContainer = null;

function stopChatPoll() {
  if (chatPollTimer) {
    window.clearInterval(chatPollTimer);
    chatPollTimer = null;
  }
  stopRankingCountdown(activeRankingContainer);
  activeRankingContainer = null;
}

function stopListPoll() {
  if (listPollTimer) {
    window.clearInterval(listPollTimer);
    listPollTimer = null;
  }
}

export function closeGroupWatch() {
  stopChatPoll();
  stopListPoll();
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();
  document.removeEventListener('keydown', handleKeydown);
}

// Real bug, found live: GroupInfoDto has no PlayingItemName field at
// all (confirmed against real jellyfin/jellyfin source), so this always
// read as undefined and every group showed "Idle" here regardless of
// its own real state. State is the one real field this endpoint
// actually carries for that; the item's own real name is only ever
// known from a real pushed PlayQueue update (runtime/syncPlay.js's own
// currentQueue), not exposed by GET /SyncPlay/List at all, so a group
// this reader is not a member of can only ever show a coarse status
// here, never a title.
function groupSubtitle(group) {
  if (group.State === 'Playing') return 'Playing';
  if (group.State === 'Paused' || group.State === 'Waiting') return 'Paused';
  return 'Idle';
}

function formatChatTime(isoTimestamp) {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export async function openGroupWatch() {
  closeGroupWatch();

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'jellio-avatar-picker-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Group Watch');
  overlay.addEventListener('click', function (event) {
    if (event.target === overlay) closeGroupWatch();
  });
  document.addEventListener('keydown', handleKeydown);

  const panel = document.createElement('div');
  panel.className = 'jellio-avatar-picker-panel jellio-group-watch-panel';

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'jellio-group-watch-close';
  closeButton.setAttribute('aria-label', 'Close');
  const closeIcon = el('span', 'material-icons close');
  closeIcon.setAttribute('aria-hidden', 'true');
  closeButton.appendChild(closeIcon);
  closeButton.addEventListener('click', closeGroupWatch);
  panel.appendChild(closeButton);

  const backButton = document.createElement('button');
  backButton.type = 'button';
  backButton.className = 'jellio-group-watch-back';
  backButton.setAttribute('aria-label', 'Back to groups');
  const backIcon = el('span', 'material-icons arrow_back');
  backIcon.setAttribute('aria-hidden', 'true');
  backButton.appendChild(backIcon);
  backButton.style.display = 'none';
  panel.appendChild(backButton);

  const titleEl = el('h2', 'jellio-avatar-picker-title', 'Group Watch');
  panel.appendChild(titleEl);

  const list = el('div', 'jellio-group-watch-list');
  panel.appendChild(list);

  const createRow = el('div', 'jellio-group-watch-create');
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'jellio-group-watch-input';
  nameInput.placeholder = 'New group name';
  nameInput.maxLength = 100;
  const createButton = el('button', 'jellio-settings-button', 'Start a group');
  createButton.type = 'button';
  createRow.appendChild(nameInput);
  createRow.appendChild(createButton);
  panel.appendChild(createRow);

  const status = el('p', 'jellio-avatar-picker-status', '');
  panel.appendChild(status);

  const chatView = el('div', 'jellio-group-watch-chat');
  chatView.style.display = 'none';
  panel.appendChild(chatView);

  const inviteView = el('div', 'jellio-group-watch-invite');
  inviteView.style.display = 'none';
  panel.appendChild(inviteView);

  const listElements = [list, createRow, status];

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  let currentUserName = '';
  let currentUserId = '';
  // Real bug, live-reported: refresh() below did a real full rebuild
  // (list.textContent = '', every row and action button rebuilt from
  // scratch) on every single call, quiet poll ticks included,
  // LIST_POLL_MS meaning a fresh Leave/Join/Chat/Invite button every 5s
  // the panel sat open. A click landing anywhere near that rebuild hit a
  // node already torn down and replaced under it, reading back as the
  // click having done nothing ("can't leave group"). Tracked here so a
  // quiet tick whose own snapshot matches what is already on screen can
  // skip the rebuild outright; a real membership or status change still
  // rebuilds exactly as before.
  let lastGroupsSignature = null;
  // Real bug, found live: this used to be awaited right here, so
  // refresh() below (its own real getSyncPlayGroups() call, neither
  // fetch depending on the other) never even started until this one
  // had fully round tripped. Started here instead, refresh() itself
  // awaits it once it actually needs currentUserName for membership
  // highlighting, by which point it is very likely already resolved.
  const currentUserPromise = getCurrentUser()
    .then(function (user) {
      if (user && user.Name) currentUserName = user.Name;
      if (user && user.Id) currentUserId = user.Id;
    })
    .catch(function () {
      // Membership highlighting below just quietly finds nothing, not
      // fatal to the rest of this panel.
    });

  // Same real /Users/Public list components/accountSwitcher.js already
  // reads for its own switcher grid, reused here for three things: a
  // real avatar next to each chat message's own author (chat messages
  // only ever carry a UserId, no image tag of their own), the member
  // list openChatView() renders (Participants is a list of real display
  // names, not ids, confirmed against GroupInfoDto's own real source, so
  // that view needs the name keyed map below rather than the id keyed
  // one everything else here uses), and the online user picker
  // openInviteView() builds. Keyed both ways up front so none of the
  // three has to scan the array itself.
  let publicUsersById = {};
  let publicUsersByName = {};
  const publicUsersPromise = getPublicUsers()
    .then(function (users) {
      (users || []).forEach(function (user) {
        if (user && user.Id) publicUsersById[user.Id] = user;
        if (user && user.Name) publicUsersByName[user.Name] = user;
      });
    })
    .catch(function () {
      // Chat rows fall back to a plain initial, the invite picker below
      // to an empty list with its own status message, neither fatal.
    });

  function avatarNode(userId, name) {
    const avatar = el('div', 'jellio-group-watch-avatar');
    const user = publicUsersById[userId];
    if (user && user.PrimaryImageTag) {
      avatar.style.backgroundImage = "url('" + getUserImageUrl(userId, user.PrimaryImageTag, { maxWidth: 100 }) + "')";
    } else {
      avatar.textContent = (name || '?').charAt(0).toUpperCase();
    }
    return avatar;
  }

  function showGroupList() {
    stopChatPoll();
    backButton.style.display = 'none';
    panel.classList.remove('jellio-group-watch-panel-subview');
    titleEl.textContent = 'Group Watch';
    chatView.style.display = 'none';
    chatView.textContent = '';
    inviteView.style.display = 'none';
    inviteView.textContent = '';
    listElements.forEach(function (node) {
      node.style.display = '';
    });
    startListPoll();
  }

  function openChatView(group) {
    stopListPoll();
    listElements.forEach(function (node) {
      node.style.display = 'none';
    });
    backButton.style.display = '';
    panel.classList.add('jellio-group-watch-panel-subview');
    titleEl.textContent = (group.GroupName || 'Group Watch') + ' · Chat';
    chatView.style.display = '';
    chatView.textContent = '';

    const memberList = el('div', 'jellio-group-watch-members');
    const messageList = el('div', 'jellio-group-watch-chat-messages');
    const rankingContainer = el('div', 'jellio-pick-container');
    activeRankingContainer = rankingContainer;
    const chatStatus = el('p', 'jellio-avatar-picker-status', 'Loading messages…');
    const inputRow = el('div', 'jellio-group-watch-chat-input-row');
    const textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.className = 'jellio-group-watch-input';
    textInput.placeholder = 'Message the group…';
    textInput.maxLength = 500;
    const sendButton = el('button', 'jellio-settings-button', 'Send');
    sendButton.type = 'button';
    inputRow.appendChild(textInput);
    inputRow.appendChild(sendButton);

    chatView.appendChild(memberList);
    chatView.appendChild(messageList);
    chatView.appendChild(rankingContainer);
    chatView.appendChild(chatStatus);

    // Grouplist gated the same way everywhere else this feature shows
    // up: off, chat looks exactly as it always has, no trigger, no
    // real ranking poll below either.
    if (isGrouplistEnabled()) {
      const pickTrigger = buildPickTrigger(function () {
        const participantIds = (group.Participants || [])
          .map(function (name) {
            const user = publicUsersByName[name];
            return user && user.Id;
          })
          .filter(Boolean);
        return startPick(group.GroupId, participantIds).catch(function (err) {
          if (err && err.status === 400) {
            chatStatus.textContent = 'Not enough titles across the group’s own Grouplists to start a pick.';
          }
          throw err;
        });
      });
      chatView.appendChild(pickTrigger);
    }
    chatView.appendChild(inputRow);

    function renderMembers(participants) {
      memberList.textContent = '';
      (participants || []).forEach(function (name) {
        const user = publicUsersByName[name];
        const chip = el('div', 'jellio-group-watch-member');
        chip.appendChild(avatarNode(user && user.Id, name));
        chip.appendChild(el('span', 'jellio-group-watch-member-name', name));
        memberList.appendChild(chip);
      });
    }
    renderMembers(group.Participants);

    // Refreshed alongside the chat poll below rather than a second real
    // timer of its own: real feedback found live this same panel's own
    // member count sat stale until the whole thing was closed and
    // reopened, GET /SyncPlay/List is the one real place membership for
    // a group this reader is not the only one in actually lives.
    async function refreshMembers() {
      try {
        const groups = await getSyncPlayGroups();
        const fresh = (groups || []).find(function (candidate) {
          return candidate.GroupId === group.GroupId;
        });
        if (fresh) renderMembers(fresh.Participants);
      } catch (err) {
        // Stale member list left showing, not fatal, tried again next tick.
      }
    }

    // Real bug, audit-found: this panel can sit open for a whole real
    // session, CHAT_POLL_MS appending a fresh DOM row on every tick with
    // nothing ever removed, an unbounded real node count for a long
    // enough watch. Same real cap the backend's own
    // GroupWatchChatService.MaxMessagesPerGroup already enforces, so
    // trimming here never drops anything the server has not already
    // dropped on its own next poll response anyway.
    const MAX_CHAT_DOM_MESSAGES = 200;

    let lastMessageId = 0;
    let atBottom = true;
    messageList.addEventListener('scroll', function () {
      atBottom = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 40;
    });

    // A message carrying a real ItemId (screens/player.js's own send,
    // right alongside the same real toast components/groupWatchInvites.js
    // already shows the moment someone actually starts playback) renders
    // as a real clickable watch card instead of a plain bubble: a reader
    // who was not looking at the exact moment that toast appeared still
    // has a real, permanent way to reach it from chat, same real
    // navigateTo('#/play?...') that toast's own onClick already uses.
    function appendWatchCard(message, isOwn) {
      const row = el('div', 'jellio-group-watch-chat-message' + (isOwn ? ' jellio-group-watch-chat-message-own' : ''));
      if (!isOwn) row.appendChild(avatarNode(message.UserId, message.UserName));
      const card = el('button', 'jellio-group-watch-chat-message-bubble jellio-group-watch-chat-watch-card');
      card.type = 'button';
      if (!isOwn) card.appendChild(el('div', 'jellio-group-watch-chat-message-author', message.UserName || 'Someone'));
      card.appendChild(el('div', 'jellio-group-watch-chat-message-text', message.Text));
      card.appendChild(el('div', 'jellio-group-watch-chat-watch-card-cta', 'Click to join'));
      card.appendChild(el('div', 'jellio-group-watch-chat-message-time', formatChatTime(message.Timestamp)));
      card.addEventListener('click', function () {
        closeGroupWatch();
        navigateTo('#/play?id=' + message.ItemId + '&groupJoin=1');
      });
      row.appendChild(card);
      messageList.appendChild(row);

      getItem(message.ItemId)
        .then(function (item) {
          const isEpisode = item && item.Type === 'Episode';
          const artId = isEpisode && item.SeriesId ? item.SeriesId : message.ItemId;
          const img = document.createElement('img');
          img.className = 'jellio-group-watch-chat-watch-card-art';
          img.src = getImageUrl(artId, 'Primary', { maxWidth: 200 });
          img.alt = '';
          card.insertBefore(img, card.firstChild);
        })
        .catch(function () {
          // No art, still a real clickable card either way.
        });
    }

    function appendMessages(messages) {
      messages.forEach(function (message) {
        const isOwn = currentUserId && message.UserId === currentUserId;
        if (message.ItemId) {
          appendWatchCard(message, isOwn);
          lastMessageId = Math.max(lastMessageId, message.Id);
          return;
        }
        const row = el('div', 'jellio-group-watch-chat-message' + (isOwn ? ' jellio-group-watch-chat-message-own' : ''));
        if (!isOwn) row.appendChild(avatarNode(message.UserId, message.UserName));
        const bubble = el('div', 'jellio-group-watch-chat-message-bubble');
        if (!isOwn) bubble.appendChild(el('div', 'jellio-group-watch-chat-message-author', message.UserName || 'Someone'));
        bubble.appendChild(el('div', 'jellio-group-watch-chat-message-text', message.Text));
        bubble.appendChild(el('div', 'jellio-group-watch-chat-message-time', formatChatTime(message.Timestamp)));
        row.appendChild(bubble);
        messageList.appendChild(row);
        lastMessageId = Math.max(lastMessageId, message.Id);
      });
      while (messageList.children.length > MAX_CHAT_DOM_MESSAGES) {
        messageList.removeChild(messageList.firstChild);
      }
      if (messages.length && atBottom) {
        messageList.scrollTop = messageList.scrollHeight;
      }
    }

    // Real bug, live-reported: renderRankingSession rebuilt this whole
    // container from scratch on every single poll tick regardless of
    // whether the session had actually changed, CHAT_POLL_MS meaning a
    // fresh set of option buttons (and a fresh poster fetch/redraw for
    // each) every 3s the panel sat open. A click landing anywhere near
    // that rebuild hit a node already torn down and replaced under it,
    // reading back as "clicking an item does nothing", and the
    // redundant poster churn was the real "images load slow" a reader
    // actually saw. lastRankingSignature below is the fix: skip the
    // rebuild entirely when this tick's session is identical to what is
    // already on screen, real change (a new vote landing, a round
    // advancing) is still exactly one rebuild, same as before.
    let lastRankingSignature = null;

    function onVote(itemId) {
      voteRankingSession(group.GroupId, itemId)
        .then(function (updated) {
          lastRankingSignature = updated ? JSON.stringify(updated) : null;
          renderRankingSession(rankingContainer, updated, currentUserId, onVote);
        })
        .catch(function (err) {
          console.warn('Jellio: could not cast a Group Watch pick vote', err);
        });
    }

    function pollRanking() {
      if (!isGrouplistEnabled()) return;
      fetchRankingSession(group.GroupId).then(function (session) {
        const signature = session ? JSON.stringify(session) : null;
        if (signature === lastRankingSignature) return;
        lastRankingSignature = signature;
        renderRankingSession(rankingContainer, session, currentUserId, onVote);
      });
    }

    async function poll() {
      try {
        const messages = await getGroupWatchMessages(group.GroupId, lastMessageId);
        chatStatus.textContent = '';
        if (messages.length) appendMessages(messages);
      } catch (err) {
        console.warn('Jellio: could not load Group Watch chat', err);
        chatStatus.textContent = 'Could not load messages.';
      }
      refreshMembers();
      pollRanking();
    }

    function send() {
      const text = textInput.value.trim();
      if (!text) return;
      textInput.value = '';
      sendButton.disabled = true;
      sendGroupWatchMessage(group.GroupId, text)
        .then(function (message) {
          if (message) appendMessages([message]);
        })
        .catch(function (err) {
          console.warn('Jellio: could not send Group Watch message', err);
          chatStatus.textContent = 'Could not send that message.';
        })
        .finally(function () {
          sendButton.disabled = false;
          textInput.focus();
        });
    }

    sendButton.addEventListener('click', send);
    textInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') send();
    });

    stopChatPoll();
    poll();
    chatPollTimer = window.setInterval(poll, CHAT_POLL_MS);
  }

  async function openInviteView(group) {
    stopListPoll();
    listElements.forEach(function (node) {
      node.style.display = 'none';
    });
    backButton.style.display = '';
    panel.classList.add('jellio-group-watch-panel-subview');
    titleEl.textContent = (group.GroupName || 'Group Watch') + ' · Invite';
    inviteView.style.display = '';
    inviteView.textContent = '';

    const inviteStatus = el('p', 'jellio-avatar-picker-status', 'Loading online people…');
    inviteView.appendChild(inviteStatus);

    let onlineIds = [];
    try {
      const [, ids] = await Promise.all([publicUsersPromise, getOnlineUserIds()]);
      onlineIds = ids || [];
    } catch (err) {
      console.warn('Jellio: could not load online users for Group Watch invite', err);
      inviteStatus.textContent = 'Could not load online people.';
      return;
    }

    const invitable = onlineIds
      .filter(function (userId) {
        return userId !== currentUserId && publicUsersById[userId];
      })
      .map(function (userId) {
        return publicUsersById[userId];
      });

    inviteStatus.textContent = '';

    if (!invitable.length) {
      inviteView.appendChild(el('p', 'jellio-service-empty', 'No one else is online right now.'));
      return;
    }

    const inviteList = el('div', 'jellio-group-watch-list');
    invitable.forEach(function (user) {
      const row = el('div', 'jellio-group-watch-row');
      const info = el('div', 'jellio-group-watch-row-info jellio-group-watch-row-info-invite');
      info.appendChild(avatarNode(user.Id, user.Name));
      info.appendChild(el('div', 'jellio-group-watch-row-name', user.Name || 'Someone'));
      row.appendChild(info);

      const actions = el('div', 'jellio-group-watch-row-actions');
      const inviteButton = el('button', 'jellio-settings-button', 'Invite');
      inviteButton.type = 'button';
      inviteButton.addEventListener('click', function () {
        inviteButton.disabled = true;
        sendGroupWatchInvite(group.GroupId, group.GroupName, user.Id)
          .then(function () {
            inviteButton.textContent = 'Invited';
          })
          .catch(function (err) {
            console.warn('Jellio: could not send Group Watch invite', err);
            inviteButton.disabled = false;
            inviteButton.textContent = 'Invite';
            inviteStatus.textContent = 'Could not send that invite.';
          });
      });
      actions.appendChild(inviteButton);
      row.appendChild(actions);

      inviteList.appendChild(row);
    });
    inviteView.appendChild(inviteList);
  }

  backButton.addEventListener('click', showGroupList);

  // quiet, when true, skips the "Loading groups…" flash and swallows a
  // failed fetch rather than replacing the list with an error: real
  // feedback found live a plain refresh() on a real interval (see
  // startListPoll() below, the actual real fix for member counts and
  // status sitting stale until the whole panel was closed and reopened)
  // made the whole list flicker back to a loading state every real tick,
  // reading as broken rather than live. lastGroupsSignature above is
  // what actually stops the real rebuild itself from running every tick
  // regardless of a quiet flag.
  async function refresh(quiet) {
    if (!quiet) {
      list.textContent = '';
      status.textContent = 'Loading groups…';
      // list was just cleared above, so the real rebuild below has to
      // run even if this fetch happens to come back identical to the
      // last one rendered.
      lastGroupsSignature = null;
    }
    let groups = [];
    try {
      groups = await getSyncPlayGroups();
    } catch (err) {
      console.warn('Jellio: could not load Group Watch groups', err);
      if (!quiet) status.textContent = 'Could not load groups.';
      return;
    }
    // Already in flight since openGroupWatch() started it alongside
    // the fetch above, so this only really waits on a slower-than-usual
    // user lookup rather than starting one fresh.
    await currentUserPromise;

    const signature = JSON.stringify(groups);
    if (signature === lastGroupsSignature) {
      status.textContent = '';
      return;
    }
    lastGroupsSignature = signature;

    list.textContent = '';
    status.textContent = '';

    if (!groups.length) {
      list.appendChild(el('p', 'jellio-service-empty', 'No groups yet. Start one below.'));
      return;
    }

    groups.forEach(function (group) {
      const participants = group.Participants || [];
      const isMember = currentUserName && participants.indexOf(currentUserName) !== -1;

      const row = el('div', 'jellio-group-watch-row' + (isMember ? ' jellio-group-watch-row-active' : ''));
      const info = el('div', 'jellio-group-watch-row-info');
      info.appendChild(el('div', 'jellio-group-watch-row-name', group.GroupName || 'Group Watch'));
      const meta = el('div', 'jellio-group-watch-row-meta');
      meta.appendChild(el('span', null, groupSubtitle(group)));
      meta.appendChild(el('span', null, participants.length + (participants.length === 1 ? ' person' : ' people')));
      info.appendChild(meta);
      row.appendChild(info);

      const actions = el('div', 'jellio-group-watch-row-actions');

      if (isMember) {
        const chatButton = el('button', 'jellio-settings-button', 'Chat');
        chatButton.type = 'button';
        chatButton.addEventListener('click', function () {
          openChatView(group);
        });
        actions.appendChild(chatButton);
      }

      if (isMember) {
        const inviteButton = el('button', 'jellio-settings-button', 'Invite');
        inviteButton.type = 'button';
        inviteButton.addEventListener('click', function () {
          openInviteView(group);
        });
        actions.appendChild(inviteButton);
      }

      const actionButton = el('button', 'jellio-settings-button' + (isMember ? ' jellio-settings-button-danger' : ''), isMember ? 'Leave' : 'Join');
      actionButton.type = 'button';
      actionButton.addEventListener('click', function () {
        actionButton.disabled = true;
        const action = isMember ? leaveGroup() : joinGroup(group.GroupId);
        action
          .then(function () {
            // Explicit no-arg call, not .then(refresh) directly: real
            // bug this would otherwise risk now that refresh() takes a
            // real quiet flag, whatever leaveSyncPlayGroup/
            // joinSyncPlayGroup's own real 204 response resolves to
            // landing straight in that param instead.
            //
            // Real bug, found live: refresh()'s own rejection used to
            // fall straight through into the one catch below, meant
            // only for leaveGroup()/joinGroup() itself. The real
            // membership change had already succeeded by then (real
            // feedback confirmed live: "Could not leave that group",
            // group correctly left regardless), refresh() only ever
            // fetching a fresh list to redraw the panel with, no real
            // reason a real network hiccup fetching that list should
            // read back as the leave or join itself having failed.
            return refresh().catch(function (err) {
              console.warn('Jellio: Group Watch membership changed but the panel could not refresh', err);
            });
          })
          .catch(function (err) {
            console.warn('Jellio: could not update Group Watch membership', err);
            status.textContent = 'Could not ' + (isMember ? 'leave' : 'join') + ' that group.';
            actionButton.disabled = false;
          });
      });
      actions.appendChild(actionButton);
      row.appendChild(actions);

      list.appendChild(row);
    });
  }

  function startListPoll() {
    stopListPoll();
    listPollTimer = window.setInterval(function () {
      refresh(true);
    }, LIST_POLL_MS);
  }

  createButton.addEventListener('click', function () {
    createButton.disabled = true;
    status.textContent = 'Starting group…';
    createSyncPlayGroup(nameInput.value.trim() || 'Group Watch')
      .then(function () {
        nameInput.value = '';
        creditGroupWatchStarted().catch(function () {
          // Not fatal to the real group actually starting, just one
          // missed real credit towards the Group Starter badge.
        });
        return refresh();
      })
      .catch(function (err) {
        console.warn('Jellio: could not start Group Watch group', err);
        status.textContent = 'Could not start a group.';
      })
      .finally(function () {
        createButton.disabled = false;
      });
  });

  refresh();
  startListPoll();
}
