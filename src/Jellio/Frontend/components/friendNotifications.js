import { t } from '../runtime/i18n.js';
import { getImageUrl, acceptFriendRequest, declineFriendRequest } from '../runtime/api.js';
import { readString, writeString } from '../runtime/storage.js';
import {
  notificationText,
  notificationTarget,
  requestIdOf,
  requestErrorKey,
  startupSummary,
  watchlistAddedCount,
} from '../runtime/friendsHelpers.js';
import { buildFriendAvatar } from './friendAvatar.js';
import { navigateTo } from '../runtime/router.js';
import { showToast } from './toast.js';
import { cssUrl } from '../runtime/safeUrl.js';
import { el } from '../runtime/dom.js';

const ANNOUNCED_KEY = 'jellio_friends_announced';

function sender(n) {
  return { UserId: n.FromUserId, UserName: n.FromUserName, PrimaryImageTag: n.FromImageTag };
}

export function messageFor(n) {
  const text = notificationText(n);
  return text ? t(text.key, text.params) : '';
}

export function openTarget(n) {
  const target = notificationTarget(n);
  if (target) navigateTo(target);
}

function subtitleFor(n) {
  if (n.Kind === 'friend_request') return t('friends_notice_request_sub');
  if (n.Kind === 'friend_accepted') return t('friends_notice_accepted_sub');
  return watchlistAddedCount(n) === 1
    ? t(n.Type === 'Series' ? 'type_series' : 'type_movie')
    : t('friends_notice_open_watchlist');
}

// A row for one of the friends notifications; ctx.remove(id) drops it from
// the list, ctx.open(n) closes the panel and follows it.
export function buildRow(n, ctx) {
  const interactive = n.Kind !== 'friend_request';
  const row = el('div', 'jellio-notifications-row jellio-notifications-row-friend');
  const label = messageFor(n);
  if (interactive) {
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', label);
  }

  const lead = el('div', 'jellio-notifications-row-lead');
  if (n.Kind === 'watchlist_added') {
    const poster = el('div', 'jellio-notifications-row-poster');
    if (n.ItemId) poster.style.backgroundImage = cssUrl(getImageUrl(n.ItemId, 'Primary', { maxWidth: 200 }));
    lead.appendChild(poster);
    lead.appendChild(buildFriendAvatar(sender(n), 'jellio-notifications-row-sender', 64));
  } else {
    lead.appendChild(buildFriendAvatar(sender(n), 'jellio-notifications-row-avatar', 96));
  }
  row.appendChild(lead);

  const text = el('div', 'jellio-notifications-row-text');
  text.appendChild(el('p', 'jellio-notifications-row-title jellio-notifications-row-wrap', label));
  text.appendChild(el('p', 'jellio-notifications-row-meta', subtitleFor(n)));

  if (n.Kind === 'friend_request') {
    const requestId = requestIdOf(n);
    const actions = el('div', 'jellio-notifications-row-actions');
    const accept = el('button', 'jellio-settings-button jellio-notifications-row-action', t('friends_accept'));
    accept.type = 'button';
    const decline = el('button', 'jellio-settings-button jellio-settings-button-secondary jellio-notifications-row-action', t('friends_decline'));
    decline.type = 'button';
    function run(call, doneToast) {
      accept.disabled = true;
      decline.disabled = true;
      call(requestId).then(
        function () {
          if (doneToast) showToast(t('friends_now_friends', { name: n.FromUserName || '' }));
          ctx.remove(n.Id);
        },
        function (err) {
          console.warn('Jellio: friend request action failed', err);
          accept.disabled = false;
          decline.disabled = false;
          showToast(t(requestErrorKey(err)));
          // A request that is gone has nothing left to answer.
          if (err && err.status === 404) ctx.remove(n.Id);
        },
      );
    }
    accept.addEventListener('click', function () { run(acceptFriendRequest, true); });
    decline.addEventListener('click', function () { run(declineFriendRequest, false); });
    actions.appendChild(accept);
    actions.appendChild(decline);
    text.appendChild(actions);
  }
  row.appendChild(text);

  if (n.Kind !== 'friend_request') {
    const dismiss = el('button', 'jellio-notifications-row-delete');
    dismiss.type = 'button';
    dismiss.setAttribute('aria-label', t('notifications_dismiss'));
    dismiss.appendChild(el('span', 'material-icons close'));
    dismiss.addEventListener('click', function (event) {
      event.stopPropagation();
      ctx.dismiss(n.Id);
    });
    dismiss.addEventListener('keydown', function (event) { event.stopPropagation(); });
    row.appendChild(dismiss);
  }

  if (interactive) {
    row.addEventListener('click', function () { ctx.open(n); });
    row.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        ctx.open(n);
      }
    });
  }
  return row;
}

// One toast when Jellio opens with unread friend news, once per unread set.
export function announceStartup(items) {
  const summary = startupSummary(items, readString(ANNOUNCED_KEY, ''));
  if (!summary) return;
  writeString(ANNOUNCED_KEY, summary.marker);
  showToast(t(summary.text.key, summary.text.params), function () {
    navigateTo(summary.target);
  });
}
