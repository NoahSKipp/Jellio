// Group Watch chat panel in the top bar.
// Built by screens/player.js; live is its playerLive accessor object.

import { el } from '../../runtime/dom.js';
import { fetchRankingSession, renderRankingSession, stopRankingCountdown } from '../groupWatchRanking.js';
import { getGroupWatchMessages, sendGroupWatchMessage, voteRankingSession } from '../../runtime/apiSocial.js';
import { getSyncUserId } from '../../runtime/syncPlay.js';
import { isGrouplistEnabled } from '../../runtime/grouplistSettings.js';
import { navigateTo } from '../../runtime/router.js';
import { t } from '../../runtime/i18n.js';

export function buildPartyChat(deps, live) {
  const { currentSyncGroup, root, topbarActions, wakeControls } = deps;

  const CHAT_POLL_MS = 3000;
  if (currentSyncGroup) {
    const chatToggleButton = el('button', 'jellio-player-back jellio-player-chat-toggle');
    chatToggleButton.type = 'button';
    chatToggleButton.setAttribute('aria-label', t('gw_chat_title'));
    chatToggleButton.setAttribute('aria-expanded', 'false');
    const chatToggleIcon = el('span', 'material-icons chat_bubble_outline');
    chatToggleIcon.setAttribute('aria-hidden', 'true');
    chatToggleButton.appendChild(chatToggleIcon);
    topbarActions.appendChild(chatToggleButton);

    const chatPanel = el('div', 'jellio-player-chat-panel');
    const chatMessages = el('div', 'jellio-player-chat-messages');
    const chatRankingContainer = el('div', 'jellio-pick-container');
    const chatInputRow = el('div', 'jellio-player-chat-input-row');
    const chatInput = document.createElement('input');
    chatInput.type = 'text';
    chatInput.className = 'jellio-player-chat-input';
    chatInput.placeholder = t('gw_message_placeholder');
    chatInput.maxLength = 500;
    const chatSendButton = el('button', 'jellio-player-chat-send');
    chatSendButton.type = 'button';
    chatSendButton.setAttribute('aria-label', t('action_send'));
    const chatSendIcon = el('span', 'material-icons send');
    chatSendIcon.setAttribute('aria-hidden', 'true');
    chatSendButton.appendChild(chatSendIcon);
    chatInputRow.appendChild(chatInput);
    chatInputRow.appendChild(chatSendButton);
    chatPanel.appendChild(chatMessages);
    chatPanel.appendChild(chatRankingContainer);
    chatPanel.appendChild(chatInputRow);
    root.appendChild(chatPanel);

    let chatLastMessageId = 0;
    let chatPollTimer = null;
    let chatOpen = false;

    const MAX_CHAT_DOM_MESSAGES = 200;

    function appendChatMessages(messages) {
      messages.forEach(function (message) {
        const row = el('div', 'jellio-player-chat-message');
        if (message.ItemId) {
          row.classList.add('jellio-player-chat-message-watch-card');
          row.setAttribute('role', 'button');
          row.setAttribute('tabindex', '0');
          row.addEventListener('click', function () {
            navigateTo('#/play?id=' + message.ItemId + '&groupJoin=1');
          });
        }
        row.appendChild(el('span', 'jellio-player-chat-message-author', (message.UserName || 'Someone') + ':'));
        row.appendChild(el('span', 'jellio-player-chat-message-text', message.Text));
        if (message.ItemId) row.appendChild(el('span', 'jellio-player-chat-message-cta', t('gw_click_to_join')));
        chatMessages.appendChild(row);
        chatLastMessageId = Math.max(chatLastMessageId, message.Id);
      });
      while (chatMessages.children.length > MAX_CHAT_DOM_MESSAGES) {
        chatMessages.removeChild(chatMessages.firstChild);
      }
      if (messages.length) chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    function onVote(itemId) {
      voteRankingSession(currentSyncGroup.GroupId, itemId)
        .then(function (updated) {
          renderRankingSession(chatRankingContainer, updated, getSyncUserId(), onVote);
        })
        .catch(function (err) {
          console.warn('Jellio: could not cast a Group Watch pick vote', err);
        });
    }

    function pollRanking() {
      if (!isGrouplistEnabled()) return;
      fetchRankingSession(currentSyncGroup.GroupId).then(function (session) {
        renderRankingSession(chatRankingContainer, session, getSyncUserId(), onVote);
      });
    }

    function pollChat() {
      getGroupWatchMessages(currentSyncGroup.GroupId, chatLastMessageId)
        .then(function (messages) {
          if (messages.length) appendChatMessages(messages);
        })
        .catch(function () {
        });
      pollRanking();
    }

    function sendChatMessage() {
      const text = chatInput.value.trim();
      if (!text) return;
      chatInput.value = '';
      sendGroupWatchMessage(currentSyncGroup.GroupId, text)
        .then(function (message) {
          if (message) appendChatMessages([message]);
        })
        .catch(function (err) {
          console.warn('Jellio: could not send Group Watch message', err);
        });
    }

    chatSendButton.addEventListener('click', sendChatMessage);
    chatInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') sendChatMessage();
    });
    chatInput.addEventListener('focus', wakeControls);

    chatToggleButton.addEventListener('click', function () {
      chatOpen = !chatOpen;
      if (live.partyLayer) live.partyLayer.setChatPanelOpen(chatOpen);
      chatPanel.classList.toggle('jellio-player-chat-panel-visible', chatOpen);
      chatToggleButton.setAttribute('aria-expanded', String(chatOpen));
      if (chatOpen) {
        pollChat();
        chatPollTimer = window.setInterval(pollChat, CHAT_POLL_MS);
        wakeControls();
      } else if (chatPollTimer) {
        window.clearInterval(chatPollTimer);
        chatPollTimer = null;
        stopRankingCountdown(chatRankingContainer);
      }
    });

    live.closeChatPanel = function () {
      if (chatOpen) chatToggleButton.click();
    };

    live.stopChatOnCleanup = function () {
      if (chatPollTimer) window.clearInterval(chatPollTimer);
      stopRankingCountdown(chatRankingContainer);
    };
  }
}
