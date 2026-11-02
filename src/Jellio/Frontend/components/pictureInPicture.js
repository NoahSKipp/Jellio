import { el } from '../runtime/dom.js';
import { t } from '../runtime/i18n.js';
import { isAutoPipEnabled } from '../runtime/pipSettings.js';

// Only a window the viewer opened with the button stays open once the
// page is back; one opened automatically or left over closes.
let manualPipElement = null;
const controllers = new Map();

function wait(ms) {
  return new Promise(function (resolve) {
    window.setTimeout(resolve, ms);
  });
}

function waitUntilLeft(element, ms) {
  const until = Date.now() + ms;
  return new Promise(function (resolve) {
    (function check() {
      if (document.pictureInPictureElement !== element) return resolve(true);
      if (Date.now() >= until) return resolve(false);
      window.setTimeout(check, 50);
    })();
  });
}

// Chrome can keep a video marked as in picture in picture after its own
// automatic window closed, and then ignores exitPictureInPicture. Within
// a click, reopening and closing the window resets it; false means the
// browser still holds the video and the caller has to replace it.
export async function forceLeavePictureInPicture(element, fromClick) {
  if (document.pictureInPictureElement !== element) return true;
  await Promise.race([document.exitPictureInPicture().catch(function () {}), wait(800)]);
  if (await waitUntilLeft(element, 300)) return true;
  if (fromClick) {
    await Promise.race([
      element
        .requestPictureInPicture()
        .then(function () {
          return document.exitPictureInPicture();
        })
        .catch(function () {}),
      wait(1200),
    ]);
    if (await waitUntilLeft(element, 300)) return true;
  }
  return false;
}

let strayCheck = null;
export function closeStrayPictureInPicture() {
  window.clearTimeout(strayCheck);
  if (!document.pictureInPictureElement || document.visibilityState !== 'visible') return;
  // Give the browser a moment to close its own automatic window first.
  strayCheck = window.setTimeout(function () {
    const current = document.pictureInPictureElement;
    if (!current || document.visibilityState !== 'visible') return;
    if (current === manualPipElement && current.isConnected) return;
    const controller = controllers.get(current);
    if (controller) controller.bringBack();
    else forceLeavePictureInPicture(current, false);
  }, 700);
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
  const onStuck = options.onStuck || function () {};

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

  let leaving = false;
  function bringBack(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (manualPipElement === video) manualPipElement = null;
    if (!active()) {
      sync();
      onReturn();
      return;
    }
    if (leaving) return;
    leaving = true;
    const fromClick = !!(event && event.isTrusted);
    forceLeavePictureInPicture(video, fromClick).then(function (left) {
      leaving = false;
      sync();
      if (left) {
        onReturn();
        return;
      }
      console.warn('Jellio: the browser kept the video in picture in picture, reloading it here');
      onStuck();
    });
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

  // Where the browser opens the window itself through the media session,
  // asking again on tab leave only races with it.
  let browserOpensOnLeave = false;
  function markBrowserOpensOnLeave() {
    browserOpensOnLeave = true;
  }

  function onVisibility() {
    if (document.visibilityState === 'hidden') {
      if (!browserOpensOnLeave) enterForTabLeave();
      return;
    }
    closeStrayPictureInPicture();
    sync();
  }
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', sync);

  const controller = { bringBack: bringBack };
  controllers.set(video, controller);

  function destroy() {
    if (controllers.get(video) === controller) controllers.delete(video);
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

  return {
    button: button,
    placeholder: placeholder,
    enterForTabLeave: enterForTabLeave,
    markBrowserOpensOnLeave: markBrowserOpensOnLeave,
    sync: sync,
    destroy: destroy,
  };
}
