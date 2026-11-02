import { el } from '../runtime/dom.js';
import { t } from '../runtime/i18n.js';
import { isAutoPipEnabled } from '../runtime/pipSettings.js';

// Only a window the viewer opened with the button stays open once the
// page is back; one opened automatically or left over closes.
let manualPipElement = null;

export function closeStrayPictureInPicture(attempt) {
  const current = document.pictureInPictureElement;
  if (!current || document.visibilityState !== 'visible') return;
  if (current === manualPipElement && current.isConnected) return;
  const tries = typeof attempt === 'number' ? attempt : 0;
  document.exitPictureInPicture().catch(function () {
    if (tries < 4) {
      window.setTimeout(function () {
        closeStrayPictureInPicture(tries + 1);
      }, 400);
    }
  });
}

if (typeof document !== 'undefined' && document.pictureInPictureEnabled) {
  document.addEventListener('visibilitychange', closeStrayPictureInPicture);
  window.addEventListener('focus', closeStrayPictureInPicture);
  window.addEventListener('pageshow', closeStrayPictureInPicture);
  window.addEventListener('hashchange', closeStrayPictureInPicture);
}

const CONTROLS_SELECTOR = 'button, input, select, a, .jellio-player-pill, .jellio-player-sidepanel, .jellio-player-topbar, .jellio-player-popover';

// The PiP button, the "playing in picture in picture" panel and the
// automatic window on leaving the tab. The panel always follows the
// browser's own state, so it can never be stuck over a video that is back.
export function attachPictureInPicture(options) {
  const video = options.video;
  const root = options.root;
  const onReturn = options.onReturn || function () {};

  const button = el('button', 'jellio-player-back jellio-player-pip');
  button.type = 'button';
  button.setAttribute('aria-label', t('player_pip'));
  const icon = el('span', 'material-icons picture_in_picture_alt');
  icon.setAttribute('aria-hidden', 'true');
  button.appendChild(icon);

  const placeholder = el('div', 'jellio-player-pip-placeholder');
  placeholder.hidden = true;
  placeholder.appendChild(el('span', 'material-icons picture_in_picture_alt'));
  placeholder.appendChild(el('span', 'jellio-player-pip-placeholder-text', t('player_pip_active')));
  const returnButton = el('button', 'jellio-player-pip-placeholder-action', t('player_pip_return'));
  returnButton.type = 'button';
  placeholder.appendChild(returnButton);

  let watchTimer = null;

  function active() {
    return document.pictureInPictureElement === video;
  }

  function sync() {
    const on = active();
    placeholder.hidden = !on;
    button.classList.toggle('jellio-player-pip-active', on);
    if (on && !watchTimer) {
      watchTimer = window.setInterval(sync, 1000);
    } else if (!on && watchTimer) {
      window.clearInterval(watchTimer);
      watchTimer = null;
    }
  }

  function bringBack(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (manualPipElement === video) manualPipElement = null;
    if (!document.pictureInPictureElement) {
      sync();
      onReturn();
      return;
    }
    document
      .exitPictureInPicture()
      .catch(function (err) {
        console.warn('Jellio: could not leave picture in picture', err);
      })
      .then(sync);
  }

  button.addEventListener('click', function () {
    if (active()) {
      bringBack();
      return;
    }
    manualPipElement = video;
    video
      .requestPictureInPicture()
      .catch(function (err) {
        if (manualPipElement === video) manualPipElement = null;
        console.warn('Jellio: could not enter picture in picture', err);
      })
      .then(sync);
  });

  returnButton.addEventListener('click', bringBack);

  function onRootClick(event) {
    if (placeholder.hidden) return;
    if (event.target !== returnButton && event.target.closest && event.target.closest(CONTROLS_SELECTOR)) return;
    bringBack(event);
  }
  root.addEventListener('click', onRootClick, true);

  function onEnter() {
    sync();
    if (document.visibilityState === 'visible' && document.hasFocus()) closeStrayPictureInPicture();
  }
  function onLeave() {
    if (manualPipElement === video) manualPipElement = null;
    sync();
    onReturn();
  }
  video.addEventListener('enterpictureinpicture', onEnter);
  video.addEventListener('leavepictureinpicture', onLeave);

  function enterForTabLeave() {
    if (!isAutoPipEnabled()) return Promise.resolve();
    if (video.paused || video.ended || video.disablePictureInPicture || document.pictureInPictureElement) return Promise.resolve();
    return video.requestPictureInPicture().then(sync, function () {});
  }

  function onVisibility() {
    if (document.visibilityState === 'hidden') {
      enterForTabLeave();
      return;
    }
    closeStrayPictureInPicture();
    sync();
  }
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', sync);

  function destroy() {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', sync);
    root.removeEventListener('click', onRootClick, true);
    video.removeEventListener('enterpictureinpicture', onEnter);
    video.removeEventListener('leavepictureinpicture', onLeave);
    if (watchTimer) window.clearInterval(watchTimer);
    watchTimer = null;
    if (manualPipElement === video) manualPipElement = null;
    if (active()) document.exitPictureInPicture().catch(function () {});
  }

  return { button: button, placeholder: placeholder, enterForTabLeave: enterForTabLeave, sync: sync, destroy: destroy };
}
