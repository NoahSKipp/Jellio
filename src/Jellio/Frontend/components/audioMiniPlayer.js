// Persistent audiobook session controller and mini-player dock component.
// Manages singleton audio playback, Jellyfin progress reporting, MediaSession API,
// and floating mini-player dock across navigation.
import {
  reportPlaybackStart,
  reportPlaybackProgress,
  reportPlaybackStopped,
  TICKS_PER_SECOND,
  reportReadingSession,
  buildAudioStreamUrl,
} from '../runtime/api.js';
import {
  findDownload,
  removeDownload,
  isAutoDeleteReadEnabled,
  setLocalProgress,
} from '../runtime/offline.js';
import { isDucking } from '../runtime/duck.js';
import { navigateTo, parseRoute } from '../runtime/router.js';
import { el } from '../runtime/dom.js';

const SKIP_SECONDS_BACK = 30;
const SKIP_SECONDS_FORWARD = 30;
const PROGRESS_REPORT_MS = 10000;
const RESTART_CHAPTER_THRESHOLD = 5;
const LISTEN_FLUSH_SECONDS = 5 * 60;
const DEFAULT_SPEED_KEY = 'jellio_audiobook_default_speed';
const AUDIOBOOK_VOLUME_KEY = 'jellio_audiobook_volume';
const AUDIOBOOK_MUTED_KEY = 'jellio_audiobook_muted';

export function getSavedAudiobookVolume() {
  try {
    const val = window.localStorage.getItem(AUDIOBOOK_VOLUME_KEY);
    return val !== null ? Math.min(1, Math.max(0, Number(val))) : 1;
  } catch (err) {
    return 1;
  }
}

export function saveAudiobookVolume(volume, muted) {
  try {
    window.localStorage.setItem(AUDIOBOOK_VOLUME_KEY, String(volume));
    window.localStorage.setItem(AUDIOBOOK_MUTED_KEY, muted ? '1' : '0');
  } catch (err) {}
}

// Spotify style: hovering a progress bar shows the time (and chapter) a
// click there jumps to, and lights the bar up to that point when a
// hoverFill is given. The readout sits on the page itself, so a player
// that clips its own edges doesn't cut it off.
export function attachScrubPreview(track, hoverFill) {
  let tip = null;
  function hide() {
    if (hoverFill) hoverFill.style.width = '0';
    if (tip) {
      tip.remove();
      tip = null;
    }
  }
  track.addEventListener('mousemove', function (e) {
    if (!activeSession || !activeSession.timeline || !activeSession.timeline.durationSec) return;
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const seconds = ratio * activeSession.timeline.durationSec;
    if (hoverFill) hoverFill.style.width = ratio * 100 + '%';
    if (!tip) {
      tip = el('div', 'jellio-mini-player-scrub-tip');
      document.body.appendChild(tip);
    }
    const chapter = activeSession.timeline.chapters && activeSession.timeline.chapters[chapterIndexAt(seconds)];
    tip.textContent = formatClock(seconds) + (chapter && chapter.title ? ' · ' + chapter.title : '');
    const width = tip.offsetWidth;
    tip.style.left = Math.max(8, Math.min(window.innerWidth - width - 8, e.clientX - width / 2)) + 'px';
    tip.style.top = rect.top - tip.offsetHeight - 8 + 'px';
  });
  track.addEventListener('mouseleave', hide);
  track.addEventListener('click', hide);
}

// Volume: a mute button and a slider, for the mini player and the full
// player alike. Saved for next time, and every control on screen (and
// the keyboard shortcuts) stays in step through jellio:audiobook-volume.
export function setAudiobookVolume(volume, muted) {
  const v = Math.min(1, Math.max(0, volume));
  if (activeSession && activeSession.audio) {
    activeSession.audio.volume = v;
    activeSession.audio.muted = !!muted;
  }
  saveAudiobookVolume(v, !!muted);
  document.dispatchEvent(new CustomEvent('jellio:audiobook-volume', { detail: { volume: v, muted: !!muted } }));
}

export function buildVolumeControl(extraClass) {
  const wrap = el('div', 'jellio-volume-control' + (extraClass ? ' ' + extraClass : ''));
  wrap.addEventListener('click', function (e) {
    e.stopPropagation();
  });
  const muteButton = el('button', 'jellio-volume-button');
  muteButton.type = 'button';
  const icon = el('span', 'material-icons volume_up');
  muteButton.appendChild(icon);
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.step = '1';
  slider.className = 'jellio-volume-slider';
  slider.setAttribute('aria-label', 'Volume');
  wrap.appendChild(muteButton);
  wrap.appendChild(slider);

  function current() {
    const audio = activeSession && activeSession.audio;
    return audio ? { volume: audio.volume, muted: audio.muted } : { volume: getSavedAudiobookVolume(), muted: getSavedAudiobookMuted() };
  }
  function paint(state) {
    const shown = state.muted ? 0 : state.volume;
    slider.value = String(Math.round(shown * 100));
    slider.style.setProperty('--jellio-volume', Math.round(shown * 100) + '%');
    icon.className = 'material-icons ' + (state.muted || state.volume === 0 ? 'volume_off' : state.volume < 0.5 ? 'volume_down' : 'volume_up');
    muteButton.setAttribute('aria-label', state.muted ? 'Unmute' : 'Mute');
    muteButton.title = state.muted ? 'Unmute' : 'Mute';
  }
  muteButton.addEventListener('click', function () {
    const state = current();
    setAudiobookVolume(state.volume || 1, !state.muted);
  });
  slider.addEventListener('input', function () {
    setAudiobookVolume(Number(slider.value) / 100, false);
  });
  function onChange(event) {
    if (!wrap.isConnected) {
      document.removeEventListener('jellio:audiobook-volume', onChange);
      return;
    }
    paint(event.detail);
  }
  document.addEventListener('jellio:audiobook-volume', onChange);
  paint(current());
  return wrap;
}

export function getSavedAudiobookMuted() {
  try {
    return window.localStorage.getItem(AUDIOBOOK_MUTED_KEY) === '1';
  } catch (err) {
    return false;
  }
}

export function getDefaultAudiobookSpeed() {
  try {
    const val = Number(window.localStorage.getItem(DEFAULT_SPEED_KEY));
    return val > 0 ? val : 1;
  } catch (err) {
    return 1;
  }
}

export function setDefaultAudiobookSpeed(speed) {
  try {
    window.localStorage.setItem(DEFAULT_SPEED_KEY, String(speed));
  } catch (err) {
    // Storage unavailable
  }
}

export function formatClock(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
}

let activeSession = null;
let uiListeners = null;
let miniPlayerEl = null;

export function getActiveAudioSession() {
  return activeSession;
}

export function setAudioSessionListeners(listeners) {
  uiListeners = listeners;
}

function notifyPosition() {
  if (!activeSession) return;
  const now = getBookTime();
  const dur = activeSession.timeline ? activeSession.timeline.durationSec : 0;
  const ch = currentChapter();
  if (uiListeners && uiListeners.onPosition) {
    uiListeners.onPosition(now, dur, ch);
  }
  updateMiniPlayerUI();
}

function notifyPlayState() {
  if (!activeSession) return;
  const playing = !activeSession.audio.paused;
  if (uiListeners && uiListeners.onPlayState) {
    uiListeners.onPlayState(playing);
  }
  updateMiniPlayerUI();
}

function notifySpeed() {
  if (!activeSession) return;
  if (uiListeners && uiListeners.onSpeed) {
    uiListeners.onSpeed(activeSession.speed);
  }
}

function notifySleep() {
  if (!activeSession) return;
  if (uiListeners && uiListeners.onSleep) {
    uiListeners.onSleep({
      deadline: activeSession.sleepDeadline,
      endOfChapter: activeSession.sleepEndOfChapter,
      minutes: activeSession.sleepMinutes,
    });
  }
}

export function currentTrack() {
  if (!activeSession || !activeSession.timeline) return null;
  return activeSession.timeline.tracks[activeSession.trackIndex];
}

export function getBookTime() {
  if (!activeSession) return 0;
  const entry = currentTrack();
  return entry ? entry.startSec + (activeSession.audio.currentTime || 0) : 0;
}

export function chapterIndexAt(seconds) {
  if (!activeSession || !activeSession.timeline) return 0;
  let found = 0;
  activeSession.timeline.chapters.forEach(function (chapter, index) {
    if (seconds + 0.25 >= chapter.startSec) found = index;
  });
  return found;
}

export function currentChapter() {
  if (!activeSession || !activeSession.timeline) return null;
  return activeSession.timeline.chapters[chapterIndexAt(getBookTime())];
}

function positionTicks() {
  if (!activeSession) return 0;
  return Math.floor((activeSession.audio.currentTime || 0) * TICKS_PER_SECOND);
}

function startReport() {
  if (!activeSession) return;
  const entry = currentTrack();
  if (!entry) return;
  activeSession.reportedTrackId = entry.item.Id;
  reportPlaybackStart(activeSession.reportedTrackId, activeSession.reportedTrackId, positionTicks());
}

function stopReport(finishedTrack) {
  if (!activeSession || !activeSession.reportedTrackId) return;
  const entry = currentTrack();
  const ticks = finishedTrack && entry ? Math.floor(entry.durationSec * TICKS_PER_SECOND) : positionTicks();
  reportPlaybackStopped(activeSession.reportedTrackId, activeSession.reportedTrackId, ticks);
  saveLocalPosition();
  activeSession.reportedTrackId = null;
}

function saveLocalPosition() {
  if (!activeSession || !activeSession.download) return;
  const entry = currentTrack();
  if (entry) {
    setLocalProgress(activeSession.download.Id, {
      TrackId: entry.item.Id,
      Offset: Math.max(0, getBookTime() - entry.startSec),
    });
  }
}

export function loadTrack(index, offset, autoplay) {
  if (!activeSession) return;
  const entry = activeSession.timeline.tracks[index];
  if (!entry) return;
  if (index !== activeSession.trackIndex) stopReport(false);
  activeSession.trackIndex = index;
  activeSession.pendingOffset = offset || 0;
  activeSession.pendingPlay = autoplay;
  activeSession.usingFallback = false;
  activeSession.audio.src = activeSession.localTracks[entry.item.Id] || buildAudioStreamUrl(entry.item.Id, false);
  activeSession.audio.load();
}

export function seekBook(seconds, autoplay) {
  if (!activeSession || !activeSession.timeline) return;
  const target = Math.min(Math.max(0, seconds), Math.max(0, activeSession.timeline.durationSec - 0.5));
  let index = activeSession.timeline.tracks.length - 1;
  for (let i = 0; i < activeSession.timeline.tracks.length; i += 1) {
    const entry = activeSession.timeline.tracks[i];
    if (target < entry.startSec + entry.durationSec) {
      index = i;
      break;
    }
  }
  const offset = target - activeSession.timeline.tracks[index].startSec;
  const play = autoplay === undefined ? !activeSession.audio.paused : autoplay;
  if (index === activeSession.trackIndex && activeSession.audio.readyState > 0) {
    activeSession.audio.currentTime = offset;
    notifyPosition();
  } else {
    loadTrack(index, offset, play);
  }
}

export function togglePlay() {
  if (!activeSession) return;
  if (activeSession.audio.paused) {
    activeSession.audio.play().catch(function (err) {
      console.warn('Jellio: audiobook playback did not start', err);
    });
  } else {
    activeSession.audio.pause();
  }
}

export function jumpChapter(delta) {
  if (!activeSession || !activeSession.timeline) return;
  const now = getBookTime();
  const current = chapterIndexAt(now);
  let target = current + delta;
  if (delta < 0 && now - activeSession.timeline.chapters[current].startSec > RESTART_CHAPTER_THRESHOLD) {
    target = current;
  }
  target = Math.min(activeSession.timeline.chapters.length - 1, Math.max(0, target));
  seekBook(activeSession.timeline.chapters[target].startSec);
}

export function setAudioSpeed(newSpeed) {
  if (!activeSession) return;
  activeSession.speed = newSpeed;
  activeSession.audio.playbackRate = newSpeed;
  try {
    window.localStorage.setItem(activeSession.speedKey, String(newSpeed));
  } catch (err) {
    // Storage unavailable
  }
  notifySpeed();
}

export function setAudioSleep(minutes) {
  if (!activeSession) return;
  if (activeSession.sleepTicker) {
    window.clearInterval(activeSession.sleepTicker);
    activeSession.sleepTicker = null;
  }
  if (activeSession.savedVolume != null && activeSession.audio) {
    activeSession.audio.volume = activeSession.savedVolume;
    activeSession.savedVolume = null;
  }
  activeSession.sleepMinutes = minutes;
  const FADE_WINDOW_MS = 15000;
  if (minutes === -1) {
    activeSession.sleepEndOfChapter = chapterIndexAt(getBookTime());
    activeSession.sleepDeadline = null;
  } else if (minutes > 0) {
    activeSession.sleepDeadline = Date.now() + minutes * 60 * 1000;
    activeSession.sleepEndOfChapter = null;
    activeSession.sleepTicker = window.setInterval(function () {
      if (!activeSession || !activeSession.sleepDeadline) return;
      const remainingMs = activeSession.sleepDeadline - Date.now();
      if (remainingMs <= 0) {
        const audio = activeSession.audio;
        const origVol = activeSession.savedVolume != null ? activeSession.savedVolume : (audio ? audio.volume : 1);
        setAudioSleep(0);
        if (audio) {
          audio.pause();
          audio.volume = origVol;
        }
      } else if (remainingMs <= FADE_WINDOW_MS && activeSession.audio) {
        if (activeSession.savedVolume == null) activeSession.savedVolume = activeSession.audio.volume;
        const factor = Math.max(0, remainingMs / FADE_WINDOW_MS);
        activeSession.audio.volume = activeSession.savedVolume * factor;
        notifySleep();
      } else {
        notifySleep();
      }
    }, 1000);
  } else {
    activeSession.sleepDeadline = null;
    activeSession.sleepEndOfChapter = null;
  }
  notifySleep();
}

function flushListening() {
  if (!activeSession) return;
  const finished =
    !activeSession.finishedReported &&
    activeSession.timeline &&
    activeSession.timeline.durationSec > 0 &&
    getBookTime() >= activeSession.timeline.durationSec * 0.98;
  if (activeSession.listenedSeconds < 60 && !finished) return;
  reportReadingSession({
    ItemId: activeSession.itemId,
    Kind: 'audiobook',
    PagesRead: 0,
    ListenedSeconds: Math.round(activeSession.listenedSeconds),
    Finished: finished,
  });
  activeSession.listenedSeconds = 0;
  if (finished) {
    activeSession.finishedReported = true;
    if (isAutoDeleteReadEnabled()) {
      findDownload(activeSession.itemId)
        .then((record) => (record ? removeDownload(record.Id) : null))
        .catch(() => null);
    }
  }
}

function setupMediaSession() {
  if (!('mediaSession' in navigator) || !activeSession) return;
  try {
    navigator.mediaSession.metadata = new window.MediaMetadata({
      title: activeSession.bookTitle,
      artist: activeSession.author,
      artwork: activeSession.cover ? [{ src: activeSession.cover, sizes: '600x600' }] : [],
    });
  } catch (err) {
    // Older browsers
  }
  const handlers = {
    play: function () {
      if (activeSession && activeSession.audio) activeSession.audio.play();
    },
    pause: function () {
      if (activeSession && activeSession.audio) activeSession.audio.pause();
    },
    seekbackward: function () {
      seekBook(getBookTime() - SKIP_SECONDS_BACK);
    },
    seekforward: function () {
      seekBook(getBookTime() + SKIP_SECONDS_FORWARD);
    },
    previoustrack: function () {
      jumpChapter(-1);
    },
    nexttrack: function () {
      jumpChapter(1);
    },
    seekto: function (details) {
      if (details && typeof details.seekTime === 'number') seekBook(details.seekTime);
    },
  };
  Object.keys(handlers).forEach(function (action) {
    try {
      navigator.mediaSession.setActionHandler(action, handlers[action]);
    } catch (err) {
      // Action unsupported
    }
  });
}

function updateMediaSessionState() {
  if (!('mediaSession' in navigator) || !activeSession) return;
  const playing = !activeSession.audio.paused;
  navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  if (navigator.mediaSession.setPositionState && activeSession.timeline && activeSession.timeline.durationSec > 0) {
    try {
      navigator.mediaSession.setPositionState({
        duration: activeSession.timeline.durationSec,
        playbackRate: activeSession.audio.playbackRate || 1,
        position: Math.min(getBookTime(), activeSession.timeline.durationSec),
      });
    } catch (err) {
      // Browser may reject mid-change
    }
  }
}

export function startAudioSession(config) {
  if (activeSession) {
    if (activeSession.itemId === config.itemId) {
      return activeSession;
    }
    stopAudioSession();
  }

  const audio = document.createElement('audio');
  audio.preload = 'auto';
  audio.id = 'jellioPersistentAudio';
  try {
    audio.preservesPitch = true;
    audio.webkitPreservesPitch = true;
    audio.mozPreservesPitch = true;
  } catch (err) {}
  audio.volume = getSavedAudiobookVolume();
  audio.muted = getSavedAudiobookMuted();
  audio.addEventListener('volumechange', function () {
    if (isDucking()) return;
    saveAudiobookVolume(audio.volume, audio.muted);
  });
  document.body.appendChild(audio);

  activeSession = {
    itemId: config.itemId,
    item: config.item,
    bookTitle: config.bookTitle || 'Audiobook',
    author: config.author || '',
    cover: config.cover || '',
    timeline: config.timeline,
    localTracks: config.localTracks || {},
    download: config.download,
    speed: config.speed || 1,
    speedKey: config.speedKey,
    trackIndex: -1,
    pendingOffset: 0,
    pendingPlay: false,
    usingFallback: false,
    reportedTrackId: null,
    progressTimer: null,
    sleepMinutes: 0,
    sleepDeadline: null,
    sleepEndOfChapter: null,
    sleepTicker: null,
    listenedSeconds: 0,
    lastListenTime: null,
    finishedReported: false,
    audio: audio,
  };

  audio.addEventListener('loadedmetadata', function () {
    if (!activeSession) return;
    if (activeSession.pendingOffset > 0) {
      try {
        audio.currentTime = activeSession.pendingOffset;
      } catch (err) {
        console.warn('Jellio: could not seek audiobook track', err);
      }
    }
    activeSession.pendingOffset = 0;
    audio.playbackRate = activeSession.speed;
    startReport();
    notifyPosition();
    if (activeSession.pendingPlay) {
      audio.play().catch(function (err) {
        console.warn('Jellio: audiobook autoplay was blocked', err);
      });
    }
  });

  audio.addEventListener('error', function () {
    if (!activeSession || activeSession.usingFallback) return;
    const entry = currentTrack();
    if (!entry) return;
    activeSession.usingFallback = true;
    const offset = audio.currentTime || activeSession.pendingOffset;
    activeSession.pendingOffset = offset;
    audio.src = buildAudioStreamUrl(entry.item.Id, true);
    audio.load();
  });

  audio.addEventListener('seeking', function () {
    if (activeSession) activeSession.lastListenTime = null;
  });

  audio.addEventListener('timeupdate', function () {
    if (!activeSession) return;
    if (!audio.paused && !audio.seeking) {
      const now = audio.currentTime;
      if (activeSession.lastListenTime !== null && now > activeSession.lastListenTime && now - activeSession.lastListenTime < 5) {
        activeSession.listenedSeconds += now - activeSession.lastListenTime;
      }
      activeSession.lastListenTime = now;
    } else {
      activeSession.lastListenTime = null;
    }
    notifyPosition();
    updateMediaSessionState();
    if (activeSession.sleepEndOfChapter !== null && activeSession.timeline && activeSession.timeline.chapters && activeSession.timeline.chapters[activeSession.sleepEndOfChapter]) {
      const endSec = activeSession.timeline.chapters[activeSession.sleepEndOfChapter].endSec;
      const timeLeft = endSec - getBookTime();
      if (timeLeft <= 0.3) {
        const origVol = activeSession.savedVolume != null ? activeSession.savedVolume : audio.volume;
        setAudioSleep(0);
        audio.pause();
        audio.volume = origVol;
      } else if (timeLeft <= 15) {
        if (activeSession.savedVolume == null) activeSession.savedVolume = audio.volume;
        const factor = Math.max(0, timeLeft / 15);
        audio.volume = activeSession.savedVolume * factor;
      }
    }
  });

  audio.addEventListener('play', function () {
    notifyPlayState();
    updateMediaSessionState();
  });

  audio.addEventListener('pause', function () {
    notifyPlayState();
    updateMediaSessionState();
    flushListening();
    if (activeSession && activeSession.reportedTrackId) {
      reportPlaybackProgress(activeSession.reportedTrackId, activeSession.reportedTrackId, positionTicks(), true);
    }
  });

  audio.addEventListener('ended', function () {
    if (!activeSession) return;
    activeSession.lastListenTime = null;
    stopReport(true);
    if (activeSession.trackIndex >= activeSession.timeline.tracks.length - 1) {
      flushListening();
    }
    if (activeSession.trackIndex < activeSession.timeline.tracks.length - 1) {
      loadTrack(activeSession.trackIndex + 1, 0, true);
    } else {
      notifyPlayState();
    }
  });

  activeSession.progressTimer = window.setInterval(function () {
    if (activeSession && activeSession.reportedTrackId && !audio.paused) {
      reportPlaybackProgress(activeSession.reportedTrackId, activeSession.reportedTrackId, positionTicks(), false);
      saveLocalPosition();
    }
    // Listening time goes to the server every few minutes too, so a
    // phone that never fires an unload event still counts it.
    if (activeSession && activeSession.listenedSeconds >= LISTEN_FLUSH_SECONDS) flushListening();
  }, PROGRESS_REPORT_MS);

  setupMediaSession();
  syncMiniPlayer();
  return activeSession;
}

export function stopAudioSession() {
  if (!activeSession) return;
  // Before the session is cleared: flushListening reads it, and used to
  // find nothing, so closing the player dropped every minute listened.
  flushListening();
  const session = activeSession;
  activeSession = null;
  uiListeners = null;

  stopReport(false);
  window.clearInterval(session.progressTimer);
  if (session.sleepTicker) window.clearInterval(session.sleepTicker);
  Object.keys(session.localTracks).forEach((id) => URL.revokeObjectURL(session.localTracks[id]));

  if ('mediaSession' in navigator) {
    ['play', 'pause', 'seekbackward', 'seekforward', 'previoustrack', 'nexttrack', 'seekto'].forEach(function (action) {
      try {
        navigator.mediaSession.setActionHandler(action, null);
      } catch (err) {
        // Ignored
      }
    });
    navigator.mediaSession.playbackState = 'none';
  }

  session.audio.pause();
  session.audio.removeAttribute('src');
  session.audio.load();
  if (session.audio.parentNode) session.audio.parentNode.removeChild(session.audio);

  if (miniPlayerEl && miniPlayerEl.parentNode) {
    miniPlayerEl.parentNode.removeChild(miniPlayerEl);
    miniPlayerEl = null;
  }
}

export function pauseAudioIfPlaying() {
  if (activeSession && activeSession.audio && !activeSession.audio.paused) {
    activeSession.audio.pause();
  }
}

function updateMiniPlayerUI() {
  if (!miniPlayerEl || !activeSession) return;
  const bar = miniPlayerEl.querySelector('.jellio-mini-player-progress-fill');
  const playIcon = miniPlayerEl.querySelector('.jellio-mini-player-play-btn .material-icons');
  const timeSpan = miniPlayerEl.querySelector('.jellio-mini-player-time');
  const subSpan = miniPlayerEl.querySelector('.jellio-mini-player-subtitle');

  const now = getBookTime();
  const dur = activeSession.timeline ? activeSession.timeline.durationSec : 0;
  if (bar && dur > 0) {
    bar.style.width = Math.min(100, Math.max(0, (now / dur) * 100)) + '%';
  }
  if (playIcon) {
    playIcon.className = 'material-icons ' + (activeSession.audio.paused ? 'play_arrow' : 'pause');
  }
  if (timeSpan) {
    timeSpan.textContent = formatClock(now) + ' / ' + formatClock(dur);
  }
  if (subSpan) {
    const ch = currentChapter();
    subSpan.textContent = ch ? ch.title : activeSession.author || '';
  }
}

export function syncMiniPlayer() {
  const route = parseRoute();
  const isListenScreen = route.path === 'listen';
  const isVideoScreen = route.path === 'play';

  if (!activeSession) {
    if (miniPlayerEl) miniPlayerEl.style.display = 'none';
    return;
  }

  if (isVideoScreen) {
    pauseAudioIfPlaying();
    if (miniPlayerEl) miniPlayerEl.style.display = 'none';
    return;
  }

  if (isListenScreen) {
    if (miniPlayerEl) miniPlayerEl.style.display = 'none';
    return;
  }

  let root = document.getElementById('jellioRoot');
  if (!root) return;

  if (!miniPlayerEl) {
    miniPlayerEl = el('div', 'jellio-audio-mini-player');
    const progressBar = el('div', 'jellio-mini-player-progress-bar');
    progressBar.style.cursor = 'pointer';
    const hoverFill = el('div', 'jellio-mini-player-progress-hover');
    progressBar.appendChild(hoverFill);
    attachScrubPreview(progressBar, hoverFill);
    progressBar.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!activeSession || !activeSession.timeline || !activeSession.timeline.durationSec) return;
      const rect = progressBar.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      seekBook(ratio * activeSession.timeline.durationSec);
    });
    const progressFill = el('div', 'jellio-mini-player-progress-fill');
    progressBar.appendChild(progressFill);
    miniPlayerEl.appendChild(progressBar);

    const content = el('div', 'jellio-mini-player-content');

    const info = el('div', 'jellio-mini-player-info');
    const coverBox = el('div', 'jellio-mini-player-cover');
    info.appendChild(coverBox);

    const text = el('div', 'jellio-mini-player-text');
    text.appendChild(el('span', 'jellio-mini-player-title'));
    text.appendChild(el('span', 'jellio-mini-player-subtitle'));
    info.appendChild(text);
    content.appendChild(info);

    const controls = el('div', 'jellio-mini-player-controls');
    const backBtn = el('button', 'jellio-mini-player-btn');
    backBtn.type = 'button';
    backBtn.setAttribute('aria-label', 'Back ' + SKIP_SECONDS_BACK + ' seconds');
    backBtn.title = 'Back ' + SKIP_SECONDS_BACK + 's';
    backBtn.appendChild(el('span', 'material-icons replay_30'));
    backBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      seekBook(getBookTime() - SKIP_SECONDS_BACK);
    });

    const playBtn = el('button', 'jellio-mini-player-btn jellio-mini-player-play-btn');
    playBtn.type = 'button';
    playBtn.setAttribute('aria-label', 'Play/Pause');
    playBtn.title = 'Play/Pause';
    playBtn.appendChild(el('span', 'material-icons play_arrow'));
    playBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      togglePlay();
    });

    const forwardBtn = el('button', 'jellio-mini-player-btn');
    forwardBtn.type = 'button';
    forwardBtn.setAttribute('aria-label', 'Forward ' + SKIP_SECONDS_FORWARD + ' seconds');
    forwardBtn.title = 'Forward ' + SKIP_SECONDS_FORWARD + 's';
    forwardBtn.appendChild(el('span', 'material-icons forward_30'));
    forwardBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      seekBook(getBookTime() + SKIP_SECONDS_FORWARD);
    });

    controls.appendChild(backBtn);
    controls.appendChild(playBtn);
    controls.appendChild(forwardBtn);
    content.appendChild(controls);

    const actions = el('div', 'jellio-mini-player-actions');
    actions.appendChild(buildVolumeControl('jellio-volume-control-compact'));
    const timeLabel = el('span', 'jellio-mini-player-time', '0:00 / 0:00');
    actions.appendChild(timeLabel);

    const closeBtn = el('button', 'jellio-mini-player-btn jellio-mini-player-close-btn');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close player');
    closeBtn.title = 'Close player';
    closeBtn.appendChild(el('span', 'material-icons close'));
    closeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      stopAudioSession();
    });
    actions.appendChild(closeBtn);
    content.appendChild(actions);

    miniPlayerEl.appendChild(content);

    miniPlayerEl.addEventListener('click', function () {
      if (activeSession) {
        navigateTo('#/listen?id=' + activeSession.itemId);
      }
    });

    root.appendChild(miniPlayerEl);
  }

  miniPlayerEl.style.display = 'flex';

  const titleSpan = miniPlayerEl.querySelector('.jellio-mini-player-title');
  const coverBox = miniPlayerEl.querySelector('.jellio-mini-player-cover');
  if (titleSpan) titleSpan.textContent = activeSession.bookTitle;

  if (coverBox) {
    coverBox.textContent = '';
    if (activeSession.cover) {
      const img = document.createElement('img');
      img.src = activeSession.cover;
      img.alt = '';
      coverBox.appendChild(img);
    } else {
      coverBox.appendChild(el('span', 'material-icons headphones'));
    }
  }

  updateMiniPlayerUI();
}

window.addEventListener('beforeunload', function () {
  flushListening();
  stopReport(false);
});

// Phones rarely fire beforeunload; leaving the tab or app is the last
// reliable moment to send what was listened.
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'hidden') flushListening();
});
window.addEventListener('pagehide', function () {
  flushListening();
});
