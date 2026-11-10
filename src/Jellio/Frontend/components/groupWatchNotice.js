import { t } from '../runtime/i18n.js';

import { el } from '../runtime/dom.js';
import { cssUrl } from '../runtime/safeUrl.js';

const NOTICE_ID = 'jellioGroupWatchNotice';
const HIDE_MS = 10000;

let notice = null;
let hideTimer = null;

function ensureNotice() {
  if (notice) return notice;
  notice = document.createElement('div');
  notice.id = NOTICE_ID;
  notice.className = 'jellio-groupwatch-notice';
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  document.body.appendChild(notice);
  return notice;
}

function hideGroupWatchNotice() {
  if (notice) notice.classList.remove('jellio-groupwatch-notice-visible');
  if (hideTimer) {
    window.clearTimeout(hideTimer);
    hideTimer = null;
  }
}

export function showGroupWatchNotice(options) {
  const node = ensureNotice();
  node.textContent = '';
  node.onclick = null;

  const media = el('div', 'jellio-groupwatch-notice-media');
  if (options.imageUrl) {
    media.style.backgroundImage = cssUrl(options.imageUrl);
  } else {
    const icon = el('span', 'material-icons ' + (options.icon || 'groups'));
    icon.setAttribute('aria-hidden', 'true');
    media.appendChild(icon);
    media.classList.add('jellio-groupwatch-notice-media-icon');
  }
  node.appendChild(media);

  const body = el('div', 'jellio-groupwatch-notice-body');
  body.appendChild(el('div', 'jellio-groupwatch-notice-header', options.header || 'Group Watch'));
  body.appendChild(el('div', 'jellio-groupwatch-notice-text', options.text || ''));
  if (options.onClick) {
    body.appendChild(el('div', 'jellio-groupwatch-notice-cta', options.cta || 'Tap to join'));
  }
  node.appendChild(body);

  const closeButton = el('button', 'jellio-groupwatch-notice-close');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', t('player_dismiss'));
  const closeIcon = el('span', 'material-icons close');
  closeIcon.setAttribute('aria-hidden', 'true');
  closeButton.appendChild(closeIcon);
  closeButton.addEventListener('click', function (event) {
    event.stopPropagation();
    hideGroupWatchNotice();
  });
  node.appendChild(closeButton);

  if (options.onClick) {
    node.classList.add('jellio-groupwatch-notice-clickable');
    node.onclick = function () {
      hideGroupWatchNotice();
      options.onClick();
    };
  } else {
    node.classList.remove('jellio-groupwatch-notice-clickable');
  }

  node.classList.add('jellio-groupwatch-notice-visible');
  if (hideTimer) window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(hideGroupWatchNotice, HIDE_MS);
}
