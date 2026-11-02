import { t } from '../runtime/i18n.js';
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
  getParties,
  setupParty,
  getPartyState,
  transferPartyHost,
  resolvePartyCode,
  scheduleParty,
  rsvpParty,
  cancelScheduledParty,
  markScheduledPartyStarted,
  searchItems,
} from '../runtime/api.js';
import { getPublicUsers } from '../runtime/auth.js';
import {
  joinGroup,
  leaveGroup,
  getMyGroupId,
  getCurrentGroup,
  noteCreatingGroup,
  sameId,
  requestSeek,
} from '../runtime/syncPlay.js';
import { splitTimestamps, partyTitle, partyProgress, positionLabel } from '../runtime/parties.js';
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

function closeGroupWatch() {
  stopChatPoll();
  stopListPoll();
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();
  document.removeEventListener('keydown', handleKeydown);
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
  overlay.setAttribute('aria-label', t('gw_title'));
  overlay.addEventListener('click', function (event) {
    if (event.target === overlay) closeGroupWatch();
  });
  document.addEventListener('keydown', handleKeydown);

  const panel = document.createElement('div');
  panel.className = 'jellio-avatar-picker-panel jellio-group-watch-panel';

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'jellio-group-watch-close';
  closeButton.setAttribute('aria-label', t('action_close'));
  const closeIcon = el('span', 'material-icons close');
  closeIcon.setAttribute('aria-hidden', 'true');
  closeButton.appendChild(closeIcon);
  closeButton.addEventListener('click', closeGroupWatch);
  panel.appendChild(closeButton);

  const backButton = document.createElement('button');
  backButton.type = 'button';
  backButton.className = 'jellio-group-watch-back';
  backButton.setAttribute('aria-label', t('gw_back_to_groups'));
  const backIcon = el('span', 'material-icons arrow_back');
  backIcon.setAttribute('aria-hidden', 'true');
  backButton.appendChild(backIcon);
  backButton.style.display = 'none';
  panel.appendChild(backButton);

  const titleEl = el('h2', 'jellio-avatar-picker-title', t('gw_title'));
  panel.appendChild(titleEl);

  const list = el('div', 'jellio-group-watch-list');
  panel.appendChild(list);

  const createRow = el('div', 'jellio-group-watch-create');
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'jellio-group-watch-input';
  nameInput.placeholder = t('gw_new_group_name');
  nameInput.maxLength = 100;
  const createButton = el('button', 'jellio-settings-button', t('gw_start_group'));
  createButton.type = 'button';
  const scheduleButton = el('button', 'jellio-settings-button jellio-settings-button-secondary', t('party_schedule'));
  scheduleButton.type = 'button';
  createRow.appendChild(nameInput);
  createRow.appendChild(createButton);
  createRow.appendChild(scheduleButton);
  panel.appendChild(createRow);

  function optionToggle(label) {
    const wrap = el('label', 'jellio-party-option');
    const box = document.createElement('input');
    box.type = 'checkbox';
    wrap.appendChild(box);
    wrap.appendChild(el('span', null, label));
    return { wrap: wrap, box: box };
  }
  const optionsRow = el('div', 'jellio-party-options');
  const privateOption = optionToggle(t('party_private'));
  const hostOnlyOption = optionToggle(t('party_host_only'));
  optionsRow.appendChild(privateOption.wrap);
  optionsRow.appendChild(hostOnlyOption.wrap);
  panel.appendChild(optionsRow);

  const codeRow = el('div', 'jellio-group-watch-create jellio-party-code-row');
  const codeInput = document.createElement('input');
  codeInput.type = 'text';
  codeInput.className = 'jellio-group-watch-input jellio-party-code-input';
  codeInput.placeholder = t('party_code_placeholder');
  codeInput.maxLength = 8;
  codeInput.autocapitalize = 'characters';
  const codeButton = el('button', 'jellio-settings-button', t('party_join_code'));
  codeButton.type = 'button';
  codeRow.appendChild(codeInput);
  codeRow.appendChild(codeButton);
  panel.appendChild(codeRow);

  const status = el('p', 'jellio-avatar-picker-status', '');
  panel.appendChild(status);

  const chatView = el('div', 'jellio-group-watch-chat');
  chatView.style.display = 'none';
  panel.appendChild(chatView);

  const inviteView = el('div', 'jellio-group-watch-invite');
  inviteView.style.display = 'none';
  panel.appendChild(inviteView);

  const scheduleView = el('div', 'jellio-party-schedule');
  scheduleView.style.display = 'none';
  panel.appendChild(scheduleView);

  const listElements = [list, createRow, optionsRow, codeRow, status];

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
    titleEl.textContent = t('gw_title');
    chatView.style.display = 'none';
    chatView.textContent = '';
    inviteView.style.display = 'none';
    inviteView.textContent = '';
    scheduleView.style.display = 'none';
    scheduleView.textContent = '';
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
    const chatStatus = el('p', 'jellio-avatar-picker-status', t('gw_loading_messages'));
    const inputRow = el('div', 'jellio-group-watch-chat-input-row');
    const textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.className = 'jellio-group-watch-input';
    textInput.placeholder = t('gw_message_placeholder');
    textInput.maxLength = 500;
    const sendButton = el('button', 'jellio-settings-button', t('action_send'));
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
            chatStatus.textContent = t('gw_not_enough_titles');
          }
          throw err;
        });
      });
      chatView.appendChild(pickTrigger);
    }
    chatView.appendChild(inputRow);

    // The party's host can hand hosting to someone else from here.
    let partyState = null;
    let lastParticipants = group.Participants;
    function renderMembers(participants) {
      lastParticipants = participants;
      memberList.textContent = '';
      (participants || []).forEach(function (name) {
        const user = publicUsersByName[name];
        const chip = el('div', 'jellio-group-watch-member');
        chip.appendChild(avatarNode(user && user.Id, name));
        chip.appendChild(el('span', 'jellio-group-watch-member-name', name));
        if (partyState && partyState.HostName === name) {
          chip.appendChild(el('span', 'jellio-party-host-badge', t('party_host')));
        } else if (partyState && partyState.IsHost && user && user.Id !== currentUserId) {
          const makeHost = el('button', 'jellio-party-make-host', t('party_make_host'));
          makeHost.type = 'button';
          makeHost.addEventListener('click', function () {
            makeHost.disabled = true;
            transferPartyHost(group.GroupId, user.Id)
              .then(refreshPartyState)
              .catch(function () {
                makeHost.disabled = false;
              });
          });
          chip.appendChild(makeHost);
        }
        memberList.appendChild(chip);
      });
    }
    function refreshPartyState() {
      return getPartyState(group.GroupId)
        .then(function (state) {
          const changed = JSON.stringify([state && state.HostName, state && state.IsHost]) !== JSON.stringify([partyState && partyState.HostName, partyState && partyState.IsHost]);
          partyState = state;
          if (changed) renderMembers(lastParticipants);
        })
        .catch(function () {});
    }
    renderMembers(group.Participants);
    refreshPartyState();

    // Text with "12:31" style times turned into buttons that take the
    // group there.
    function messageTextNode(text) {
      const node = el('div', 'jellio-group-watch-chat-message-text');
      splitTimestamps(text).forEach(function (part) {
        if (part.seconds == null) {
          node.appendChild(document.createTextNode(part.text));
          return;
        }
        const jump = el('button', 'jellio-party-timestamp', part.text);
        jump.type = 'button';
        jump.title = t('party_jump_to', { time: part.text });
        jump.addEventListener('click', function () {
          if (!sameId(getMyGroupId(), group.GroupId)) return;
          requestSeek(part.seconds * 10000000).catch(function () {});
        });
        node.appendChild(jump);
      });
      return node;
    }

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
      card.appendChild(el('div', 'jellio-group-watch-chat-watch-card-cta', t('gw_click_to_join')));
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
        if (message.ReplyToText) {
          bubble.appendChild(el('div', 'jellio-group-watch-chat-reply', '↪ ' + (message.ReplyToName || '') + ': ' + message.ReplyToText));
        }
        bubble.appendChild(messageTextNode(message.Text));
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
        chatStatus.textContent = t('gw_load_messages_error');
      }
      refreshMembers();
      refreshPartyState();
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
          chatStatus.textContent = t('gw_send_error');
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

    const inviteStatus = el('p', 'jellio-avatar-picker-status', t('gw_loading_online'));
    inviteView.appendChild(inviteStatus);

    let onlineIds = [];
    try {
      const [, ids] = await Promise.all([publicUsersPromise, getOnlineUserIds()]);
      onlineIds = ids || [];
    } catch (err) {
      console.warn('Jellio: could not load online users for Group Watch invite', err);
      inviteStatus.textContent = t('gw_load_online_error');
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
      inviteView.appendChild(el('p', 'jellio-service-empty', t('gw_no_one_online')));
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
      const inviteButton = el('button', 'jellio-settings-button', t('action_invite'));
      inviteButton.type = 'button';
      inviteButton.addEventListener('click', function () {
        inviteButton.disabled = true;
        sendGroupWatchInvite(group.GroupId, group.GroupName, user.Id)
          .then(function () {
            inviteButton.textContent = t('action_invited');
          })
          .catch(function (err) {
            console.warn('Jellio: could not send Group Watch invite', err);
            inviteButton.disabled = false;
            inviteButton.textContent = t('action_invite');
            inviteStatus.textContent = t('gw_send_invite_error');
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
  // Party cards: what each group is watching, how far in, who's there.
  function partyMembersNode(party) {
    const stack = el('div', 'jellio-party-avatars');
    (party.Participants || []).slice(0, 5).forEach(function (person) {
      const avatar = avatarNode(person.UserId, person.Name);
      avatar.title = person.Name;
      stack.appendChild(avatar);
    });
    if ((party.Participants || []).length > 5) {
      stack.appendChild(el('span', 'jellio-party-avatars-more', '+' + (party.Participants.length - 5)));
    }
    return stack;
  }

  function partyArt(item, icon) {
    const art = el('div', 'jellio-party-art');
    if (item && item.ImageItemId) {
      art.style.backgroundImage = "url('" + getImageUrl(item.ImageItemId, 'Primary', { maxWidth: 200 }) + "')";
    } else {
      const glyph = el('span', 'material-icons ' + icon);
      glyph.setAttribute('aria-hidden', 'true');
      art.appendChild(glyph);
    }
    return art;
  }

  function stateLabel(party) {
    if (party.State === 'Playing') return t('party_state_playing');
    if (party.State === 'Waiting') return t('party_state_waiting');
    if (party.State === 'Paused') return t('party_state_paused');
    return t('party_state_idle');
  }

  function buildLiveCard(party) {
    const isMember = sameId(getMyGroupId(), party.GroupId);
    const names = (party.Participants || []).map(function (p) {
      return p.Name;
    });
    const group = { GroupId: party.GroupId, GroupName: party.GroupName, Participants: names };
    const card = el('div', 'jellio-party-card' + (isMember ? ' jellio-party-card-active' : ''));
    card.appendChild(partyArt(party.Item, 'groups'));

    const body = el('div', 'jellio-party-card-body');
    const titleRow = el('div', 'jellio-party-card-title');
    titleRow.appendChild(el('span', null, party.GroupName || 'Group Watch'));
    if (party.Private) {
      const lock = el('span', 'material-icons lock jellio-party-card-flag');
      lock.title = t('party_private');
      titleRow.appendChild(lock);
    }
    if (party.HostOnly) {
      const crown = el('span', 'material-icons admin_panel_settings jellio-party-card-flag');
      crown.title = t('party_host_only');
      titleRow.appendChild(crown);
    }
    body.appendChild(titleRow);

    const watching = partyTitle(party.Item);
    const line = [watching, stateLabel(party), party.PositionTicks != null ? positionLabel(party) : null].filter(Boolean).join(' · ');
    body.appendChild(el('div', 'jellio-party-card-sub', line));
    const progress = partyProgress(party);
    if (progress != null) {
      const bar = el('div', 'jellio-party-progress');
      const fill = el('div', 'jellio-party-progress-fill');
      fill.style.width = Math.round(progress * 100) + '%';
      bar.appendChild(fill);
      body.appendChild(bar);
    }
    const foot = el('div', 'jellio-party-card-foot');
    foot.appendChild(partyMembersNode(party));
    if (party.HostName) foot.appendChild(el('span', 'jellio-party-card-host', t('party_hosted_by', { name: party.HostName })));
    if (isMember && party.Code) {
      const code = el('button', 'jellio-party-code', party.Code);
      code.type = 'button';
      code.title = t('party_copy_code');
      code.addEventListener('click', function () {
        try {
          navigator.clipboard.writeText(party.Code).then(function () {
            status.textContent = t('party_code_copied');
          });
        } catch (err) {}
      });
      foot.appendChild(code);
    }
    body.appendChild(foot);
    card.appendChild(body);

    const actions = el('div', 'jellio-group-watch-row-actions');
    if (isMember) {
      const chatButton = el('button', 'jellio-settings-button', t('gw_chat'));
      chatButton.type = 'button';
      chatButton.addEventListener('click', function () {
        openChatView(group);
      });
      actions.appendChild(chatButton);
      const inviteButton = el('button', 'jellio-settings-button', t('action_invite'));
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
      const action = isMember ? leaveGroup() : joinGroup(party.GroupId);
      action
        .then(function () {
          return refresh().catch(function () {});
        })
        .catch(function (err) {
          console.warn('Jellio: could not update Group Watch membership', err);
          status.textContent = isMember ? t('gw_leave_error') : t('gw_join_error');
          actionButton.disabled = false;
        });
    });
    actions.appendChild(actionButton);
    card.appendChild(actions);
    return card;
  }

  function startsInLabel(startsAt) {
    const date = new Date(startsAt);
    const when = date.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    const minutes = Math.round((date.getTime() - Date.now()) / 60000);
    if (minutes <= 0) return when + ' · ' + t('party_due_now');
    if (minutes < 60) return when + ' · ' + t('party_in_minutes', { count: minutes });
    return when + ' · ' + t('party_in_hours', { count: Math.round(minutes / 60) });
  }

  function buildScheduledCard(party) {
    const card = el('div', 'jellio-party-card jellio-party-card-scheduled');
    card.appendChild(partyArt(party.Item, 'event'));
    const body = el('div', 'jellio-party-card-body');
    const titleRow = el('div', 'jellio-party-card-title');
    titleRow.appendChild(el('span', null, party.Name));
    if (party.Private) {
      const lock = el('span', 'material-icons lock jellio-party-card-flag');
      lock.title = t('party_private');
      titleRow.appendChild(lock);
    }
    body.appendChild(titleRow);
    body.appendChild(el('div', 'jellio-party-card-sub', [partyTitle(party.Item), startsInLabel(party.StartsAt)].filter(Boolean).join(' · ')));
    const foot = el('div', 'jellio-party-card-foot');
    foot.appendChild(el('span', 'jellio-party-card-host', t('party_hosted_by', { name: party.HostName })));
    if ((party.Going || []).length) {
      foot.appendChild(el('span', 'jellio-party-card-host', t('party_going_count', { count: party.Going.length })));
    }
    body.appendChild(foot);
    card.appendChild(body);

    const actions = el('div', 'jellio-group-watch-row-actions');
    if (party.GroupId) {
      const join = el('button', 'jellio-settings-button', 'Join');
      join.type = 'button';
      join.addEventListener('click', function () {
        join.disabled = true;
        joinGroup(party.GroupId)
          .then(function () {
            return refresh();
          })
          .catch(function () {
            status.textContent = t('gw_join_error');
            join.disabled = false;
          });
      });
      actions.appendChild(join);
    } else if (party.CanStart) {
      const start = el('button', 'jellio-settings-button', t('party_start_now'));
      start.type = 'button';
      start.addEventListener('click', function () {
        start.disabled = true;
        startScheduled(party).catch(function (err) {
          console.warn('Jellio: could not start the scheduled party', err);
          status.textContent = t('gw_start_group_error');
          start.disabled = false;
        });
      });
      actions.appendChild(start);
    }
    if (!party.IsHost) {
      const rsvp = el('button', 'jellio-settings-button' + (party.IsGoing ? ' jellio-party-going' : ''), party.IsGoing ? t('party_going') : t('party_im_in'));
      rsvp.type = 'button';
      rsvp.addEventListener('click', function () {
        rsvp.disabled = true;
        rsvpParty(party.Id, !party.IsGoing)
          .then(function () {
            return refresh();
          })
          .catch(function () {
            rsvp.disabled = false;
          });
      });
      actions.appendChild(rsvp);
    } else {
      const cancel = el('button', 'jellio-settings-button jellio-settings-button-danger', t('party_cancel'));
      cancel.type = 'button';
      cancel.addEventListener('click', function () {
        cancel.disabled = true;
        cancelScheduledParty(party.Id)
          .then(function () {
            return refresh();
          })
          .catch(function () {
            cancel.disabled = false;
          });
      });
      actions.appendChild(cancel);
    }
    card.appendChild(actions);
    return card;
  }

  async function refresh(quiet) {
    if (!quiet) {
      list.textContent = '';
      status.textContent = t('gw_loading_groups');
      lastGroupsSignature = null;
    }
    let data = null;
    try {
      data = await getParties();
    } catch (err) {
      console.warn('Jellio: could not load Group Watch parties', err);
      if (!quiet) status.textContent = t('gw_load_error');
      return;
    }
    await currentUserPromise;
    await publicUsersPromise;

    const signature = JSON.stringify([data, getMyGroupId()]);
    if (signature === lastGroupsSignature) {
      if (!quiet) status.textContent = '';
      return;
    }
    lastGroupsSignature = signature;
    list.textContent = '';
    if (!quiet) status.textContent = '';

    const live = (data && data.Live) || [];
    const scheduled = (data && data.Scheduled) || [];
    if (!live.length && !scheduled.length) {
      list.appendChild(el('p', 'jellio-service-empty', t('gw_no_groups')));
      return;
    }
    if (live.length) {
      list.appendChild(el('h3', 'jellio-party-section', t('party_live_now')));
      live.forEach(function (party) {
        list.appendChild(buildLiveCard(party));
      });
    }
    if (scheduled.length) {
      list.appendChild(el('h3', 'jellio-party-section', t('party_upcoming')));
      scheduled.forEach(function (party) {
        list.appendChild(buildScheduledCard(party));
      });
    }
  }

  // The group this browser just created, once its GroupJoined arrives.
  function waitForOwnGroup(name, timeoutMs) {
    return new Promise(function (resolve) {
      const started = Date.now();
      (function check() {
        const group = getCurrentGroup();
        if (group && (!name || group.GroupName === name)) {
          resolve(group);
        } else if (Date.now() - started > (timeoutMs || 8000)) {
          resolve(null);
        } else {
          window.setTimeout(check, 250);
        }
      })();
    });
  }

  async function createParty(name, options) {
    noteCreatingGroup(name);
    await createSyncPlayGroup(name);
    creditGroupWatchStarted().catch(function () {});
    const group = await waitForOwnGroup(name);
    if (group) {
      await setupParty(group.GroupId, options).catch(function (err) {
        console.warn('Jellio: could not set up the party', err);
      });
    }
    return group;
  }

  async function startScheduled(party) {
    const group = await createParty(party.Name, { private: party.Private, hostOnly: party.HostOnly, scheduleId: party.Id });
    if (!group) throw new Error('The group did not start');
    await markScheduledPartyStarted(party.Id, group.GroupId);
    if (party.Item && party.Item.Id) {
      closeGroupWatch();
      // A show opens its page to pick the episode; a film or episode plays.
      navigateTo((party.Item.Type === 'Series' ? '#/item?id=' : '#/play?id=') + party.Item.Id);
      return;
    }
    await refresh();
  }

  async function openScheduleView() {
    stopListPoll();
    listElements.forEach(function (node) {
      node.style.display = 'none';
    });
    backButton.style.display = '';
    panel.classList.add('jellio-group-watch-panel-subview');
    titleEl.textContent = t('party_schedule');
    scheduleView.style.display = '';
    scheduleView.textContent = '';

    function field(label, input) {
      const wrap = el('label', 'jellio-party-field');
      wrap.appendChild(el('span', 'jellio-party-field-label', label));
      wrap.appendChild(input);
      return wrap;
    }
    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'jellio-group-watch-input';
    name.maxLength = 100;
    name.placeholder = t('party_name_placeholder');
    const when = document.createElement('input');
    when.type = 'datetime-local';
    when.className = 'jellio-group-watch-input';
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    soon.setMinutes(0, 0, 0);
    when.value = new Date(soon.getTime() - soon.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    scheduleView.appendChild(field(t('party_name'), name));
    scheduleView.appendChild(field(t('party_when'), when));

    // A title is optional: a party can also just be a time to meet.
    let pickedItem = null;
    const titleSearch = document.createElement('input');
    titleSearch.type = 'search';
    titleSearch.className = 'jellio-group-watch-input';
    titleSearch.placeholder = t('party_title_placeholder');
    const results = el('div', 'jellio-party-title-results');
    const picked = el('div', 'jellio-party-title-picked');
    scheduleView.appendChild(field(t('party_title'), titleSearch));
    scheduleView.appendChild(picked);
    scheduleView.appendChild(results);
    let searchTimer = null;
    titleSearch.addEventListener('input', function () {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(function () {
        const term = titleSearch.value.trim();
        results.textContent = '';
        if (term.length < 2) return;
        searchItems(term, 8)
          .then(function (items) {
            results.textContent = '';
            (items || []).filter(function (item) {
              return item.Type === 'Movie' || item.Type === 'Episode' || item.Type === 'Series';
            }).forEach(function (item) {
              const option = el('button', 'jellio-party-title-option', item.Name + (item.ProductionYear ? ' (' + item.ProductionYear + ')' : ''));
              option.type = 'button';
              option.addEventListener('click', function () {
                pickedItem = item;
                picked.textContent = '✓ ' + item.Name;
                results.textContent = '';
                titleSearch.value = '';
                if (!name.value.trim()) name.value = item.Name;
              });
              results.appendChild(option);
            });
          })
          .catch(function () {});
      }, 250);
    });

    const options = el('div', 'jellio-party-options');
    const priv = optionToggle(t('party_private'));
    const hostOnly = optionToggle(t('party_host_only'));
    options.appendChild(priv.wrap);
    options.appendChild(hostOnly.wrap);
    scheduleView.appendChild(options);

    scheduleView.appendChild(el('div', 'jellio-party-field-label', t('party_invite_people')));
    const people = el('div', 'jellio-party-people');
    await publicUsersPromise;
    const chosen = new Set();
    Object.keys(publicUsersById).forEach(function (id) {
      if (id === currentUserId) return;
      const user = publicUsersById[id];
      const chip = el('button', 'jellio-party-person');
      chip.type = 'button';
      chip.appendChild(avatarNode(user.Id, user.Name));
      chip.appendChild(el('span', null, user.Name));
      chip.addEventListener('click', function () {
        if (chosen.has(user.Id)) chosen.delete(user.Id);
        else chosen.add(user.Id);
        chip.classList.toggle('jellio-party-person-on', chosen.has(user.Id));
      });
      people.appendChild(chip);
    });
    scheduleView.appendChild(people);

    const save = el('button', 'jellio-settings-button', t('party_schedule_save'));
    save.type = 'button';
    const scheduleStatus = el('p', 'jellio-avatar-picker-status', '');
    save.addEventListener('click', function () {
      const startsAt = new Date(when.value);
      if (Number.isNaN(startsAt.getTime())) {
        scheduleStatus.textContent = t('party_bad_time');
        return;
      }
      save.disabled = true;
      scheduleParty({
        name: name.value.trim() || (pickedItem && pickedItem.Name) || '',
        itemId: pickedItem && pickedItem.Id,
        startsAt: startsAt,
        private: priv.box.checked,
        hostOnly: hostOnly.box.checked,
        inviteeUserIds: Array.from(chosen),
      })
        .then(function () {
          showGroupList();
          refresh();
        })
        .catch(function () {
          scheduleStatus.textContent = t('party_schedule_error');
          save.disabled = false;
        });
    });
    scheduleView.appendChild(save);
    scheduleView.appendChild(scheduleStatus);
  }

  function startListPoll() {
    stopListPoll();
    listPollTimer = window.setInterval(function () {
      refresh(true);
    }, LIST_POLL_MS);
  }

  createButton.addEventListener('click', function () {
    createButton.disabled = true;
    status.textContent = t('gw_starting_group');
    const newName = nameInput.value.trim() || 'Group Watch';
    createParty(newName, { private: privateOption.box.checked, hostOnly: hostOnlyOption.box.checked })
      .then(function () {
        nameInput.value = '';
        status.textContent = '';
        return refresh();
      })
      .catch(function (err) {
        console.warn('Jellio: could not start Group Watch group', err);
        status.textContent = t('gw_start_group_error');
      })
      .finally(function () {
        createButton.disabled = false;
      });
  });

  scheduleButton.addEventListener('click', function () {
    openScheduleView();
  });

  function joinByCode() {
    const code = codeInput.value.trim();
    if (!code) return;
    codeButton.disabled = true;
    resolvePartyCode(code)
      .then(function (result) {
        return joinGroup(result.GroupId);
      })
      .then(function () {
        codeInput.value = '';
        status.textContent = '';
        return refresh();
      })
      .catch(function (err) {
        status.textContent = err && err.status === 429 ? t('party_code_throttled') : t('party_code_unknown');
      })
      .finally(function () {
        codeButton.disabled = false;
      });
  }
  codeButton.addEventListener('click', joinByCode);
  codeInput.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') joinByCode();
  });

  refresh();
  startListPoll();
}
