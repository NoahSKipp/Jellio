// A bigger, harder to miss real notification for the two Group Watch
// events that actually need a reader's attention (an invite, or the
// group just starting something), components/toast.js's own plain
// single line undersells either: real feedback found live both read as
// background noise, easy to miss or dismiss before actually reading
// what it said. Same real self starting singleton lifecycle toast.js
// already has, one instance for the whole page, module level so
// components/groupWatchInvites.js's own poll and watch-target listener
// both share it without either needing to hold a reference.
const NOTICE_ID = 'jellioGroupWatchNotice';
const HIDE_MS = 10000;

let notice = null;
let hideTimer = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

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

// options: { icon, header, text, imageUrl, onClick }. icon is a
// material-icons glyph name, used when imageUrl is not given (an
// invite has no real poster of its own to show, the watching notice
// does). onClick, when given, makes the whole card itself the real
// shortcut this exists for in the first place, same real convention
// toast.js's own showToast() already uses.
export function showGroupWatchNotice(options) {
  const node = ensureNotice();
  node.textContent = '';
  node.onclick = null;

  const media = el('div', 'jellio-groupwatch-notice-media');
  if (options.imageUrl) {
    media.style.backgroundImage = "url('" + options.imageUrl + "')";
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
  closeButton.setAttribute('aria-label', 'Dismiss');
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
