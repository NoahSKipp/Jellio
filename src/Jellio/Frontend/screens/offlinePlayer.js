// Plays a downloaded film or episode from this device (components/
// downloads.js saved it): the browser's own video controls, the
// downloaded subtitles, and the position kept locally and sent to the
// server as the item's user data, now or once it's reachable again.
// screens/player.js hands over here when offline, or for #/play?local=1.
import { findDownload, getOfflineObjectUrl, getLocalProgress, setLocalProgress } from '../runtime/offline.js';
import { saveUserItemPosition } from '../runtime/api.js';
import { navigateTo, setTitle } from '../runtime/router.js';
import { el } from '../runtime/dom.js';

const TICKS_PER_SECOND = 10000000;
const WATCHED_AT = 0.9;
const SAVE_EVERY_MS = 10000;

function message(root, text) {
  root.textContent = '';
  const box = el('div', 'jellio-offline-player-message');
  box.appendChild(el('span', 'material-icons cloud_off'));
  box.appendChild(el('p', null, text));
  const back = el('button', 'jellio-downloads-retry', 'Go to Downloads');
  back.type = 'button';
  back.addEventListener('click', () => navigateTo('#/downloads'));
  box.appendChild(back);
  root.appendChild(box);
}

export async function renderOfflinePlayer(root, params) {
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-player jellio-screen-offline-player';
  const itemId = params.get('id');
  const record = itemId ? await findDownload(itemId) : null;
  if (!record || record.Kind !== 'video') {
    message(root, 'This isn’t downloaded, and the server can’t be reached right now.');
    return undefined;
  }
  const item = record.Item;
  setTitle(record.Title + ' - Jellio');

  const urls = [];
  const videoUrl = await getOfflineObjectUrl(record.Id, 'video');
  if (!videoUrl) {
    message(root, 'The downloaded file is missing. Remove it under Downloads and download it again.');
    return undefined;
  }
  urls.push(videoUrl);

  const stage = el('div', 'jellio-offline-player');
  const video = document.createElement('video');
  video.className = 'jellio-offline-player-video';
  video.controls = true;
  video.autoplay = true;
  video.playsInline = true;
  video.src = videoUrl;

  for (const subtitle of record.Subtitles || []) {
    const url = await getOfflineObjectUrl(record.Id, subtitle.Name);
    if (!url) continue;
    urls.push(url);
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = subtitle.Label;
    if (subtitle.Language) track.srclang = subtitle.Language.slice(0, 2);
    track.src = url;
    if (subtitle.IsDefault) track.default = true;
    video.appendChild(track);
  }
  stage.appendChild(video);

  const top = el('div', 'jellio-offline-player-top');
  const back = el('button', 'jellio-offline-player-back');
  back.type = 'button';
  back.setAttribute('aria-label', 'Back');
  back.appendChild(el('span', 'material-icons arrow_back'));
  back.addEventListener('click', function () {
    if (window.history.length > 1) window.history.back();
    else navigateTo('#/downloads');
  });
  top.appendChild(back);
  const titles = el('div', 'jellio-offline-player-titles');
  titles.appendChild(el('span', 'jellio-offline-player-title', record.Title));
  if (record.Subtitle) titles.appendChild(el('span', 'jellio-offline-player-subtitle', record.Subtitle));
  top.appendChild(titles);
  stage.appendChild(top);
  root.appendChild(stage);

  // Resume: this device's position, else the one the server had when it
  // was downloaded.
  const local = await getLocalProgress(record.Id);
  const startTicks =
    (local && local.PositionTicks) || (item.UserData && !item.UserData.Played && item.UserData.PlaybackPositionTicks) || 0;
  video.addEventListener(
    'loadedmetadata',
    function () {
      const start = startTicks / TICKS_PER_SECOND;
      if (start > 5 && (!video.duration || start < video.duration - 10)) video.currentTime = start;
    },
    { once: true },
  );

  let lastSaved = 0;
  let finished = false;
  function save(force) {
    if (!video.duration) return;
    const now = Date.now();
    if (!force && now - lastSaved < SAVE_EVERY_MS) return;
    lastSaved = now;
    const ticks = Math.round(video.currentTime * TICKS_PER_SECOND);
    const watched = video.currentTime / video.duration >= WATCHED_AT;
    setLocalProgress(record.Id, { PositionTicks: watched ? 0 : ticks });
    if (force || (watched && !finished)) {
      finished = finished || watched;
      saveUserItemPosition(item.Id, ticks, watched);
    }
  }
  video.addEventListener('timeupdate', () => save(false));
  video.addEventListener('pause', () => save(true));
  video.addEventListener('ended', () => save(true));

  function onKey(event) {
    if (event.target && /input|textarea/i.test(event.target.tagName)) return;
    if (event.key === ' ' || event.key === 'k') {
      event.preventDefault();
      if (video.paused) video.play();
      else video.pause();
    } else if (event.key === 'ArrowLeft') {
      video.currentTime = Math.max(0, video.currentTime - 10);
    } else if (event.key === 'ArrowRight') {
      video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 10);
    } else if (event.key === 'f') {
      if (document.fullscreenElement) document.exitFullscreen();
      else stage.requestFullscreen && stage.requestFullscreen();
    }
  }
  document.addEventListener('keydown', onKey);

  video.play().catch(() => {
    // Autoplay blocked: the controls are there to start it.
  });

  return function cleanup() {
    save(true);
    document.removeEventListener('keydown', onKey);
    video.pause();
    video.removeAttribute('src');
    video.load();
    urls.forEach((url) => URL.revokeObjectURL(url));
  };
}
