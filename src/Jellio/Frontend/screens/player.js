// Real playback: PlaybackInfo negotiation, a bare <video> element, and
// real session reporting, the same mechanism JMSFusion's own player uses
// (confirmed against its real source before writing any of this), not
// jellyfin-web's own playbackManager, which this runtime cannot reach.
import {
  getItemDetails,
  getPlaybackInfo,
  buildStreamUrl,
  reportPlaybackStart,
  reportPlaybackProgress,
  reportPlaybackStopped,
  startSleepTimer,
  cancelSleepTimer,
  getSleepTimerStatus,
  TICKS_PER_SECOND,
} from '../runtime/api.js';
import { navigateTo } from '../runtime/router.js';

const PROGRESS_REPORT_MS = 5000;
const SLEEP_TIMER_OPTIONS = [15, 30, 45, 60, 90];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = function (n) {
    return n < 10 ? '0' + n : String(n);
  };
  return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
}

export async function renderPlayer(root, params) {
  root.textContent = '';
  root.className = 'jellio-screen-player';

  const itemId = params.get('id');
  if (!itemId) return undefined;

  let item;
  try {
    item = await getItemDetails(itemId);
  } catch (err) {
    console.warn('Jellio: could not load item for playback', err);
    return undefined;
  }

  const startTicks = (item.UserData && item.UserData.PlaybackPositionTicks) || 0;

  let playbackInfo;
  try {
    playbackInfo = await getPlaybackInfo(itemId, startTicks);
  } catch (err) {
    console.warn('Jellio: could not negotiate playback', err);
    return undefined;
  }

  const mediaSource = playbackInfo && playbackInfo.MediaSources && playbackInfo.MediaSources[0];
  if (!mediaSource) {
    console.warn('Jellio: no playable media source for', itemId);
    return undefined;
  }

  const streamUrl = buildStreamUrl(itemId, mediaSource, startTicks);

  const video = document.createElement('video');
  video.className = 'jellio-player-video';
  video.src = streamUrl;
  video.autoplay = true;
  video.playsInline = true;

  const controls = el('div', 'jellio-player-controls');

  const backButton = el('button', 'jellio-player-back');
  backButton.type = 'button';
  backButton.setAttribute('aria-label', 'Back');
  const backIcon = el('span', 'material-icons arrow_back');
  backIcon.setAttribute('aria-hidden', 'true');
  backButton.appendChild(backIcon);
  backButton.addEventListener('click', function () {
    navigateTo('#/item?id=' + itemId);
  });

  const title = el('div', 'jellio-player-title', item.Name || '');

  const seekRow = el('div', 'jellio-player-seek-row');
  const currentTimeLabel = el('span', 'jellio-player-time', formatTime(startTicks / TICKS_PER_SECOND));
  const seekBar = document.createElement('input');
  seekBar.type = 'range';
  seekBar.className = 'jellio-player-seek';
  seekBar.min = '0';
  seekBar.max = '100';
  seekBar.value = '0';
  const durationLabel = el('span', 'jellio-player-time', '0:00');
  seekRow.appendChild(currentTimeLabel);
  seekRow.appendChild(seekBar);
  seekRow.appendChild(durationLabel);

  const playPauseButton = el('button', 'jellio-player-playpause');
  playPauseButton.type = 'button';
  const playPauseIcon = el('span', 'material-icons pause');
  playPauseIcon.setAttribute('aria-hidden', 'true');
  playPauseButton.appendChild(playPauseIcon);
  playPauseButton.addEventListener('click', function () {
    if (video.paused) video.play();
    else video.pause();
  });

  const sleepButton = el('button', 'jellio-player-sleep');
  sleepButton.type = 'button';
  sleepButton.setAttribute('aria-label', 'Sleep timer');
  const sleepIcon = el('span', 'material-icons bedtime');
  sleepIcon.setAttribute('aria-hidden', 'true');
  sleepButton.appendChild(sleepIcon);

  const sleepMenu = el('div', 'jellio-player-sleep-menu jellio-player-sleep-menu-hidden');
  const cancelOption = el('button', 'jellio-player-sleep-option', 'Cancel timer');
  cancelOption.type = 'button';
  cancelOption.addEventListener('click', function () {
    cancelSleepTimer().then(function () {
      sleepButton.classList.remove('jellio-player-sleep-active');
      sleepMenu.classList.add('jellio-player-sleep-menu-hidden');
    });
  });
  sleepMenu.appendChild(cancelOption);
  SLEEP_TIMER_OPTIONS.forEach(function (minutes) {
    const option = el('button', 'jellio-player-sleep-option', minutes + ' min');
    option.type = 'button';
    option.addEventListener('click', function () {
      startSleepTimer(minutes).then(function () {
        sleepButton.classList.add('jellio-player-sleep-active');
        sleepMenu.classList.add('jellio-player-sleep-menu-hidden');
      });
    });
    sleepMenu.appendChild(option);
  });

  sleepButton.addEventListener('click', function () {
    sleepMenu.classList.toggle('jellio-player-sleep-menu-hidden');
  });

  getSleepTimerStatus()
    .then(function (status) {
      if (status && status.Active) sleepButton.classList.add('jellio-player-sleep-active');
    })
    .catch(function () {
      // No status yet is not an error worth surfacing here.
    });

  controls.appendChild(backButton);
  controls.appendChild(title);
  controls.appendChild(seekRow);
  controls.appendChild(playPauseButton);
  controls.appendChild(sleepButton);
  controls.appendChild(sleepMenu);

  root.appendChild(video);
  root.appendChild(controls);

  let hasReportedStart = false;
  let seeking = false;
  let lastReportedTicks = startTicks;

  function currentPositionTicks() {
    return Math.round((video.currentTime || 0) * TICKS_PER_SECOND);
  }

  video.addEventListener('loadedmetadata', function () {
    if (startTicks > 0) {
      video.currentTime = startTicks / TICKS_PER_SECOND;
    }
    durationLabel.textContent = formatTime(video.duration);
  });

  video.addEventListener('timeupdate', function () {
    if (seeking) return;
    if (video.duration) {
      seekBar.value = String((video.currentTime / video.duration) * 100);
    }
    currentTimeLabel.textContent = formatTime(video.currentTime);

    if (!hasReportedStart) {
      hasReportedStart = true;
      reportPlaybackStart(itemId, mediaSource.Id, currentPositionTicks());
    }
  });

  seekBar.addEventListener('input', function () {
    seeking = true;
    if (video.duration) {
      const target = (Number(seekBar.value) / 100) * video.duration;
      currentTimeLabel.textContent = formatTime(target);
    }
  });
  seekBar.addEventListener('change', function () {
    if (video.duration) {
      video.currentTime = (Number(seekBar.value) / 100) * video.duration;
    }
    seeking = false;
  });

  video.addEventListener('play', function () {
    playPauseIcon.className = 'material-icons pause';
  });
  video.addEventListener('pause', function () {
    playPauseIcon.className = 'material-icons play_arrow';
  });

  const progressInterval = window.setInterval(function () {
    if (!hasReportedStart) return;
    lastReportedTicks = currentPositionTicks();
    reportPlaybackProgress(itemId, mediaSource.Id, lastReportedTicks, video.paused);
  }, PROGRESS_REPORT_MS);

  return function cleanup() {
    window.clearInterval(progressInterval);
    if (hasReportedStart) {
      reportPlaybackStopped(itemId, mediaSource.Id, currentPositionTicks());
    }
    video.pause();
    video.removeAttribute('src');
    video.load();
  };
}
