import { t } from '../runtime/i18n.js';
import { el } from '../runtime/dom.js';
import { getGroupWatchMessages, sendGroupWatchMessage, getPartyState, setPartyItem, setPartyReady, startPartyCountdown, requestPartyControl } from '../runtime/apiSocial.js';
import { getCurrentGroup, requestSeek, requestPause, requestUnpause } from '../runtime/syncPlay.js';
import {
  PARTY_REACTIONS,
  COUNTDOWN_SECONDS,
  READY_WAIT_MS,
  splitTimestamps,
  formatClock,
  clockSkewMs,
  countdownSecondsLeft,
  readyCount,
} from '../runtime/parties.js';

const STATE_POLL_MS = 2000;
const CHAT_POLL_MS = 3000;
const BUBBLE_MS = 8000;
const MAX_BUBBLES = 4;
const TICKS_PER_SECOND = 10000000;

// options: root, itemId, getPlaylistItemId(), getPositionTicks(),
// getUserId(), toast(message)
export function createPartyLayer(options) {
  const root = options.root;
  let destroyed = false;
  let state = null;
  let skew = 0;
  let lastRequestId = 0;
  let lastMessageId = -1;
  let chatPanelOpen = false;
  let startPending = false;
  let startPendingSince = 0;
  let countdownFired = null;
  let countdownTimer = null;
  const readyReported = new Set();

  const bubbles = el('div', 'jellio-party-bubbles');
  const reactions = el('div', 'jellio-party-reactions');
  const center = el('div', 'jellio-party-center');
  center.hidden = true;
  const prompt = el('div', 'jellio-party-prompt');
  prompt.hidden = true;
  root.appendChild(bubbles);
  root.appendChild(reactions);
  root.appendChild(center);
  root.appendChild(prompt);
  reactions.hidden = !getCurrentGroup();

  PARTY_REACTIONS.forEach(function (emoji) {
    const button = el('button', 'jellio-party-reaction', emoji);
    button.type = 'button';
    button.setAttribute('aria-label', t('party_react_with', { emoji: emoji }));
    button.addEventListener('click', function (event) {
      event.stopPropagation();
      const group = getCurrentGroup();
      if (!group) return;
      sendGroupWatchMessage(group.GroupId, emoji)
        .then(function (message) {
          if (message) showBubble(message, true);
        })
        .catch(function () {});
    });
    reactions.appendChild(button);
  });

  function inGroup() {
    return !!getCurrentGroup();
  }

  function groupId() {
    const group = getCurrentGroup();
    return group && group.GroupId;
  }

  function messageText(text) {
    const node = el('span', 'jellio-party-bubble-text');
    splitTimestamps(text).forEach(function (part) {
      if (part.seconds == null) {
        node.appendChild(document.createTextNode(part.text));
        return;
      }
      const jump = el('button', 'jellio-party-timestamp', part.text);
      jump.type = 'button';
      jump.title = t('party_jump_to', { time: part.text });
      jump.addEventListener('click', function (event) {
        event.stopPropagation();
        requestSeek(part.seconds * TICKS_PER_SECOND).catch(function () {});
      });
      node.appendChild(jump);
    });
    return node;
  }

  function showBubble(message, own) {
    if (chatPanelOpen || message.ItemId) return;
    const bubble = el('div', 'jellio-party-bubble' + (own ? ' jellio-party-bubble-own' : ''));
    bubble.appendChild(el('span', 'jellio-party-bubble-author', own ? t('party_you') : message.UserName || 'Someone'));
    if (message.ReplyToText) {
      bubble.appendChild(el('span', 'jellio-party-bubble-reply', '↪ ' + (message.ReplyToName || '') + ': ' + message.ReplyToText));
    }
    bubble.appendChild(messageText(message.Text));
    bubbles.appendChild(bubble);
    while (bubbles.children.length > MAX_BUBBLES) bubbles.removeChild(bubbles.firstChild);
    window.setTimeout(function () {
      bubble.classList.add('jellio-party-bubble-leaving');
      window.setTimeout(function () {
        bubble.remove();
      }, 400);
    }, BUBBLE_MS);
  }

  function pollChat() {
    const id = groupId();
    if (!id || destroyed) return;
    getGroupWatchMessages(id, Math.max(lastMessageId, 0))
      .then(function (messages) {
        const first = lastMessageId < 0;
        (messages || []).forEach(function (message) {
          lastMessageId = Math.max(lastMessageId, message.Id);
          // History from before this player opened isn't replayed.
          if (!first && message.UserId !== options.getUserId()) showBubble(message, false);
        });
        if (first && lastMessageId < 0) lastMessageId = 0;
      })
      .catch(function () {});
  }

  function setCenter(text, big) {
    if (!text) {
      center.hidden = true;
      center.textContent = '';
      return;
    }
    center.hidden = false;
    center.className = 'jellio-party-center' + (big ? ' jellio-party-center-big' : '');
    center.textContent = text;
  }

  // The countdown everyone sees; whoever started the title unpauses the
  // group when it ends.
  function renderCountdown() {
    const playlistItemId = options.getPlaylistItemId();
    if (!state || !state.CountdownEndsAt || state.CountdownPlaylistItemId !== playlistItemId) return false;
    const left = countdownSecondsLeft(state.CountdownEndsAt, skew);
    if (left == null || left < 0) {
      setCenter(null);
      return false;
    }
    setCenter(left > 0 ? String(left) : t('party_go'), true);
    if (countdownTimer == null) {
      countdownTimer = window.setInterval(function () {
        if (!renderCountdown()) {
          window.clearInterval(countdownTimer);
          countdownTimer = null;
        }
      }, 250);
    }
    return left >= 0;
  }

  function maybeStartGroup() {
    const playlistItemId = options.getPlaylistItemId();
    const id = groupId();
    if (!startPending || !playlistItemId || !id || !readyReported.has(playlistItemId)) return;
    const group = getCurrentGroup();
    const count = readyCount(state, playlistItemId, (group && group.Participants && group.Participants.length) || 1);
    if (!count.all && Date.now() - startPendingSince < READY_WAIT_MS) {
      setCenter(t('party_ready_check', { ready: count.ready, total: count.total }));
      return;
    }
    startPending = false;
    startPartyCountdown(id, playlistItemId, COUNTDOWN_SECONDS)
      .then(function (result) {
        skew = clockSkewMs(result.ServerNow, Date.now());
        const waitMs = Math.max(0, Date.parse(result.EndsAt) - skew - Date.now());
        countdownFired = playlistItemId;
        window.setTimeout(function () {
          if (destroyed || options.getPlaylistItemId() !== playlistItemId) return;
          requestUnpause().catch(function () {});
        }, waitMs);
      })
      .catch(function () {
        requestUnpause().catch(function () {});
      });
  }

  // A host-only party: the host gets each request as a prompt.
  function showRequest(request) {
    const label = request.Kind === 'seek' && request.PositionTicks != null
      ? t('party_asks_seek', { name: request.UserName, time: formatClock(request.PositionTicks / TICKS_PER_SECOND) })
      : t(request.Kind === 'pause' ? 'party_asks_pause' : 'party_asks_play', { name: request.UserName });
    prompt.textContent = '';
    prompt.hidden = false;
    prompt.appendChild(el('span', 'jellio-party-prompt-text', label));
    const accept = el('button', 'jellio-settings-button', t('party_do_it'));
    accept.type = 'button';
    accept.addEventListener('click', function () {
      prompt.hidden = true;
      if (request.Kind === 'pause') requestPause().catch(function () {});
      else if (request.Kind === 'play') requestUnpause().catch(function () {});
      else if (request.PositionTicks != null) requestSeek(request.PositionTicks).catch(function () {});
    });
    const ignore = el('button', 'jellio-settings-button jellio-settings-button-secondary', t('party_ignore'));
    ignore.type = 'button';
    ignore.addEventListener('click', function () {
      prompt.hidden = true;
    });
    prompt.appendChild(accept);
    prompt.appendChild(ignore);
    window.setTimeout(function () {
      prompt.hidden = true;
    }, 15000);
  }

  function pollState() {
    const id = groupId();
    reactions.hidden = !id;
    if (!id || destroyed) {
      state = null;
      setCenter(null);
      return;
    }
    const sentAt = Date.now();
    getPartyState(id, lastRequestId)
      .then(function (fresh) {
        state = fresh;
        skew = clockSkewMs(fresh.ServerNow, Date.now() - (Date.now() - sentAt) / 2);
        (fresh.Requests || []).forEach(function (request) {
          if (request.Id > lastRequestId) {
            lastRequestId = request.Id;
            if (fresh.IsHost && request.UserId !== options.getUserId()) showRequest(request);
          }
        });
        if (!renderCountdown() && !startPending) setCenter(null);
        maybeStartGroup();
      })
      .catch(function () {});
  }

  const stateTimer = window.setInterval(pollState, STATE_POLL_MS);
  const chatTimer = window.setInterval(pollChat, CHAT_POLL_MS);
  pollState();
  pollChat();

  return {
    // This title was just put on the group's queue by this reader.
    published: function () {
      const id = groupId();
      if (!id) return false;
      setPartyItem(id, options.itemId).catch(function () {});
      startPending = true;
      startPendingSince = Date.now();
      return true;
    },
    // This player can play the group's current title.
    markReady: function (playlistItemId) {
      const id = groupId();
      if (!id || !playlistItemId || readyReported.has(playlistItemId)) return;
      readyReported.add(playlistItemId);
      setPartyReady(id, playlistItemId, true).catch(function () {});
      maybeStartGroup();
    },
    // Host-only party and this reader isn't the host: ask instead.
    shouldAsk: function () {
      return !!(state && state.HostOnly && !state.IsHost && inGroup());
    },
    ask: function (kind, positionTicks) {
      const id = groupId();
      if (!id) return;
      requestPartyControl(id, kind, positionTicks)
        .then(function () {
          options.toast(t('party_asked_host', { name: (state && state.HostName) || t('party_host') }));
        })
        .catch(function () {});
    },
    setChatPanelOpen: function (open) {
      chatPanelOpen = !!open;
      if (chatPanelOpen) bubbles.textContent = '';
    },
    countdownRunning: function () {
      return countdownFired != null;
    },
    destroy: function () {
      destroyed = true;
      window.clearInterval(stateTimer);
      window.clearInterval(chatTimer);
      if (countdownTimer != null) window.clearInterval(countdownTimer);
      bubbles.remove();
      reactions.remove();
      center.remove();
      prompt.remove();
    },
  };
}

export function askCatchUp(root, positionSeconds) {
  return new Promise(function (resolve) {
    const box = el('div', 'jellio-party-catchup');
    box.appendChild(el('div', 'jellio-party-catchup-title', t('party_catchup_title', { time: formatClock(positionSeconds) })));
    const actions = el('div', 'jellio-party-catchup-actions');
    const join = el('button', 'jellio-settings-button', t('party_catchup_join'));
    join.type = 'button';
    const solo = el('button', 'jellio-settings-button jellio-settings-button-secondary', t('party_catchup_solo'));
    solo.type = 'button';
    actions.appendChild(join);
    actions.appendChild(solo);
    box.appendChild(actions);
    root.appendChild(box);
    let done = false;
    function finish(choice) {
      if (done) return;
      done = true;
      box.remove();
      resolve(choice);
    }
    join.addEventListener('click', function () {
      finish('group');
    });
    solo.addEventListener('click', function () {
      finish('solo');
    });
    window.setTimeout(function () {
      finish('group');
    }, 10000);
    join.focus();
  });
}
