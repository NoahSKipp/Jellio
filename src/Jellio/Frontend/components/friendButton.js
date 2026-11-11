import { t } from '../runtime/i18n.js';
import {
  getFriendStatus,
  loadFriends,
  sendFriendRequest,
  cancelFriendRequest,
  acceptFriendRequest,
  declineFriendRequest,
} from '../runtime/api.js';
import { statusToButton, normalizeId, requestErrorKey } from '../runtime/friendsHelpers.js';
import { openFriendMenu } from './friendMenu.js';
import { showToast } from './toast.js';
import { el } from '../runtime/dom.js';

function iconButton(className, icon, label, onClick) {
  const button = el('button', className);
  button.type = 'button';
  if (icon) button.appendChild(el('span', 'material-icons', icon));
  button.appendChild(el('span', 'jellio-friend-btn-label', label));
  button.addEventListener('click', onClick);
  return button;
}

// The friend button next to another member's name on their profile.
// Optimistic: the state flips at once and rolls back if the server says no.
export function mountFriendButton(container, userId, userName) {
  let state = null;
  let pendingRequestId = null;
  let busy = false;

  function setState(next) {
    state = next;
    paint();
  }

  // After sending a request the server returns only a status; the id
  // needed to cancel it comes from a follow-up status call.
  function learnRequestId() {
    pendingRequestId = getFriendStatus(userId).then(
      function (s) {
        if (state && state.Status === 'outgoing') state.RequestId = s.RequestId;
        return s.RequestId;
      },
      function () { return null; },
    );
    return pendingRequestId;
  }

  function guard(optimistic, work, onDone) {
    if (busy) return;
    busy = true;
    const previous = state;
    setState(optimistic);
    work().then(
      function (result) {
        busy = false;
        if (onDone) onDone(result);
        else paint();
      },
      function (err) {
        busy = false;
        console.warn('Jellio: friend action failed', err);
        showToast(t(requestErrorKey(err)));
        setState(err && err.body && (err.body.Status === 'private' || err.body.Status === 'closed') ? { Status: err.body.Status } : previous);
      },
    );
  }

  function send() {
    guard({ Status: 'outgoing', CanRequest: true }, function () { return sendFriendRequest(userId); }, function (result) {
      if (result && result.Status === 'friends') setState({ Status: 'friends' });
      else {
        paint();
        learnRequestId();
      }
    });
  }

  function cancel() {
    const id = state.RequestId;
    guard({ Status: 'none', CanRequest: true }, async function () {
      const requestId = id || (await pendingRequestId);
      if (!requestId) throw new Error('No request id');
      return cancelFriendRequest(requestId);
    });
  }

  function accept() {
    const id = state.RequestId;
    guard({ Status: 'friends' }, function () { return acceptFriendRequest(id); });
  }

  function decline() {
    const id = state.RequestId;
    guard({ Status: 'none', CanRequest: true }, function () { return declineFriendRequest(id); });
  }

  function openMenu(anchor) {
    loadFriends().then(function (data) {
      const friend = data.Friends.find(function (f) { return normalizeId(f.UserId) === normalizeId(userId); });
      const target = friend || { UserId: userId, UserName: userName, Muted: false };
      openFriendMenu(target, anchor, {
        onRemoved: function () { setState({ Status: 'none', CanRequest: true }); },
      });
    }).catch(function () {
      showToast(t('friends_error_generic'));
    });
  }

  function paint() {
    container.textContent = '';
    container.hidden = true;
    if (!state) return;
    const spec = statusToButton(state.Status, state.CanRequest);
    if (spec.state === 'hidden') return;
    container.hidden = false;
    if (spec.state === 'closed') {
      container.appendChild(el('span', 'jellio-friend-note', t(spec.labelKey)));
    } else if (spec.state === 'add') {
      container.appendChild(iconButton('jellio-settings-button jellio-friend-btn', spec.icon, t(spec.labelKey), send));
    } else if (spec.state === 'sent') {
      const button = iconButton('jellio-settings-button jellio-settings-button-secondary jellio-friend-btn', spec.icon, t(spec.labelKey), cancel);
      button.title = t('friends_cancel_request');
      button.setAttribute('aria-label', t('friends_request_sent') + '. ' + t('friends_cancel_request'));
      container.appendChild(button);
    } else if (spec.state === 'incoming') {
      container.appendChild(iconButton('jellio-settings-button jellio-friend-btn', 'check', t('friends_accept'), accept));
      container.appendChild(iconButton('jellio-settings-button jellio-settings-button-secondary jellio-friend-btn', 'close', t('friends_decline'), decline));
    } else if (spec.state === 'friends') {
      const button = iconButton('jellio-settings-button jellio-settings-button-secondary jellio-friend-btn', spec.icon, t(spec.labelKey), function () {
        openMenu(button);
      });
      button.setAttribute('aria-haspopup', 'menu');
      button.appendChild(el('span', 'material-icons jellio-friend-btn-caret', 'expand_more'));
      container.appendChild(button);
    }
  }

  container.hidden = true;
  getFriendStatus(userId).then(
    function (s) { setState(s); },
    function () { container.hidden = true; },
  );
}
