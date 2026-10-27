// The live channel player. Unlike screens/player.js it has no resume
// point, watch history, stream picker, intro skip or next episode: it
// opens the channel (which holds a tuner slot), plays the HLS that
// Jellyfin remuxes from the source's MPEG-TS, and always closes the live
// stream again when left. The source drops a few seconds of video now and
// then, so a short stall is waited out rather than treated as a failure.
import { t } from '../runtime/i18n.js';
import { el } from '../runtime/dom.js';
import { navigateTo } from '../runtime/router.js';
import { getAuthHeaders } from '../runtime/auth.js';
import { loadVendorScript } from '../runtime/vendorScript.js';
import { getLiveChannels, getLivePrograms, openLiveChannel, closeLiveStream } from '../runtime/api.js';
import {
  mapChannels,
  arrangeChannels,
  filterChannels,
  neighbourChannel,
  nowAndNext,
  createLiveLifecycle,
  describeOpenFailure,
} from '../runtime/liveTv.js';
import { openGuide, buildChannelLogo } from './liveTv.js';

const STALL_NOTICE_MS = 15000;
const STALL_RESTART_MS = 30000;
const MAX_RESTARTS = 2;
const INFO_VISIBLE_MS = 5000;
const CHANNEL_SWITCH_DELAY_MS = 600;
const STATE_KEY = 'jellio.livetv.state';

function formatTime(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function rememberedFilter() {
  try {
    return (JSON.parse(window.sessionStorage.getItem(STATE_KEY) || '{}') || {}).filter || '';
  } catch (err) {
    return '';
  }
}

async function loadHls() {
  if (window.Hls) return window.Hls;
  await loadVendorScript('hls.light.min.js');
  return window.Hls;
}

function canPlayHlsNatively(video) {
  return !!video.canPlayType && video.canPlayType('application/vnd.apple.mpegurl') !== '';
}

export async function renderLivePlayer(root, params) {
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-live-player';

  const stage = el('div', 'jellio-live-stage');
  const video = document.createElement('video');
  video.className = 'jellio-live-video';
  video.autoplay = true;
  video.playsInline = true;
  video.controls = false;
  stage.appendChild(video);

  const status = el('div', 'jellio-live-status');
  const spinner = el('div', 'jellio-screen-spinner');
  const statusText = el('div', 'jellio-live-status-text', '');
  status.appendChild(spinner);
  status.appendChild(statusText);
  stage.appendChild(status);

  const info = el('div', 'jellio-live-info');
  stage.appendChild(info);

  const errorBox = el('div', 'jellio-live-error');
  errorBox.hidden = true;
  stage.appendChild(errorBox);

  const topBar = el('div', 'jellio-live-topbar');
  const back = el('button', 'jellio-live-icon-button');
  back.type = 'button';
  back.setAttribute('aria-label', 'Back');
  back.appendChild(el('span', 'material-icons', 'arrow_back'));
  back.addEventListener('click', leave);
  topBar.appendChild(back);
  const guideButton = el('button', 'jellio-live-icon-button');
  guideButton.type = 'button';
  guideButton.setAttribute('aria-label', t('live_guide'));
  guideButton.appendChild(el('span', 'material-icons', 'view_list'));
  guideButton.addEventListener('click', function () {
    showGuide();
  });
  topBar.appendChild(guideButton);
  const fullscreen = el('button', 'jellio-live-icon-button');
  fullscreen.type = 'button';
  fullscreen.setAttribute('aria-label', 'Fullscreen');
  fullscreen.appendChild(el('span', 'material-icons', 'fullscreen'));
  fullscreen.addEventListener('click', toggleFullscreen);
  topBar.appendChild(fullscreen);
  topBar.appendChild(el('div', 'jellio-live-hint', t('live_keys_hint')));
  stage.appendChild(topBar);

  root.appendChild(stage);

  let channels = [];
  let channel = null;
  let hls = null;
  let left = false;
  let restarts = 0;
  let lastProgressAt = 0;
  let lastTime = -1;
  let stallTimer = null;
  let infoTimer = null;
  let switchTimer = null;
  let chromeTimer = null;
  let attempt = 0;
  let playingSince = 0;

  const lifecycle = createLiveLifecycle(openLiveChannel, closeLiveStream);

  function setStatus(text) {
    status.hidden = !text;
    statusText.textContent = text || '';
  }

  function showError(message) {
    setStatus('');
    errorBox.hidden = false;
    errorBox.textContent = '';
    errorBox.appendChild(el('p', 'jellio-live-error-text', message));
    const retry = el('button', 'jellio-settings-button', t('action_retry'));
    retry.type = 'button';
    retry.addEventListener('click', function () {
      restarts = 0;
      play(channel);
    });
    errorBox.appendChild(retry);
    const backButton = el('button', 'jellio-settings-button', t('nav_live_tv'));
    backButton.type = 'button';
    backButton.addEventListener('click', leave);
    errorBox.appendChild(backButton);
    retry.focus();
  }

  function destroyEngine() {
    if (hls) {
      try {
        hls.destroy();
      } catch (err) {}
      hls = null;
    }
    video.removeAttribute('src');
    try {
      video.load();
    } catch (err) {}
  }

  async function renderInfo() {
    if (!channel) return;
    const shown = channel;
    info.textContent = '';
    info.appendChild(buildChannelLogo(shown, 120));
    const text = el('div', 'jellio-live-info-text');
    text.appendChild(el('div', 'jellio-live-info-channel', shown.name));
    const nowLine = el('div', 'jellio-live-info-now', shown.now ? t('live_on_now') + ': ' + shown.now.name : '');
    const nextLine = el('div', 'jellio-live-info-next', '');
    text.appendChild(nowLine);
    text.appendChild(nextLine);
    info.appendChild(text);
    showInfo();
    try {
      const nowMs = Date.now();
      const programs = await getLivePrograms([shown.id], nowMs, nowMs + 6 * 60 * 60 * 1000);
      if (shown !== channel) return;
      const pair = nowAndNext(programs, Date.now());
      if (pair.now) nowLine.textContent = t('live_on_now') + ': ' + pair.now.name + ' (' + formatTime(pair.now.start) + ' – ' + formatTime(pair.now.end) + ')';
      if (pair.next) nextLine.textContent = t('live_up_next') + ': ' + pair.next.name + ' (' + formatTime(pair.next.start) + ')';
    } catch (err) {}
  }

  function showInfo() {
    info.classList.add('jellio-live-info-visible');
    window.clearTimeout(infoTimer);
    infoTimer = window.setTimeout(function () {
      info.classList.remove('jellio-live-info-visible');
    }, INFO_VISIBLE_MS);
  }

  function showChrome() {
    topBar.classList.add('jellio-live-topbar-visible');
    window.clearTimeout(chromeTimer);
    chromeTimer = window.setTimeout(function () {
      topBar.classList.remove('jellio-live-topbar-visible');
    }, 3000);
  }

  async function attach(url) {
    const Hls = await loadHls().catch(function () {
      return null;
    });
    if (Hls && Hls.isSupported()) {
      hls = new Hls({
        // A live edge three segments back, and generous retries: the
        // source's CDN refuses some segments now and then.
        liveSyncDurationCount: 3,
        maxBufferLength: 30,
        manifestLoadingMaxRetry: 6,
        levelLoadingMaxRetry: 6,
        fragLoadingMaxRetry: 8,
        fragLoadingRetryDelay: 1000,
        xhrSetup: function (xhr) {
          xhr.setRequestHeader('Authorization', getAuthHeaders().Authorization);
        },
      });
      hls.on(Hls.Events.ERROR, function (event, data) {
        if (!data || !data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          hls.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
        } else {
          restart('engine error');
        }
      });
      hls.loadSource(url);
      hls.attachMedia(video);
      return;
    }
    if (canPlayHlsNatively(video)) {
      video.src = url;
      return;
    }
    throw new Error('This browser cannot play live streams');
  }

  async function play(target) {
    if (!target || left) return;
    const mine = ++attempt;
    channel = target;
    errorBox.hidden = true;
    // The watchdog waits while a channel opens (up to ~25 s the first time).
    lastProgressAt = 0;
    playingSince = 0;
    destroyEngine();
    setStatus(t('live_starting', { name: target.name }));
    renderInfo();
    try {
      window.history.replaceState(null, '', '#/live?id=' + encodeURIComponent(target.id));
    } catch (err) {}
    const started = performance.now();
    let stream;
    try {
      stream = await lifecycle.start(target.id);
    } catch (err) {
      if (mine !== attempt || left) return;
      if (err && err.liveStreamId) closeLiveStream(err.liveStreamId).catch(function () {});
      showError(describeOpenFailure(err));
      return;
    }
    if (!stream || mine !== attempt || left) return;
    const openedMs = Math.round(performance.now() - started);
    lastProgressAt = Date.now();
    lastTime = -1;
    try {
      await attach(stream.hlsUrl);
    } catch (err) {
      showError(err.message);
      return;
    }
    video.play().catch(function () {});
    const onFirstFrame = function () {
      video.removeEventListener('playing', onFirstFrame);
      if (mine !== attempt) return;
      setStatus('');
      playingSince = Date.now();
      const report = {
        Channel: target.name,
        OpenMs: openedMs,
        FirstFrameMs: Math.round(performance.now() - started),
        Engine: hls ? 'hls.js' : 'native',
        Restarts: restarts,
      };
      window.__jellioLiveStats = report;
      console.info('Jellio live start', report);
    };
    video.addEventListener('playing', onFirstFrame);
  }

  async function restart(reason) {
    if (left || !channel) return;
    if (restarts >= MAX_RESTARTS) {
      showError(describeOpenFailure({ message: reason }));
      return;
    }
    restarts++;
    console.warn('Jellio live: restarting stream (' + reason + '), attempt ' + restarts);
    play(channel);
  }

  // Progress watchdog: playback moving resets it; a stall shows
  // "Reconnecting" after 15 s and reopens the channel after 30 s.
  function watch() {
    if (left || !channel || !lastProgressAt) return;
    if (video.paused && !video.seeking && video.readyState >= 3) {
      lastProgressAt = Date.now();
      return;
    }
    if (video.currentTime !== lastTime) {
      lastTime = video.currentTime;
      lastProgressAt = Date.now();
      if (statusText.textContent === t('live_reconnecting')) setStatus('');
      // Two minutes of steady playback earns the restarts back.
      if (restarts && playingSince && Date.now() - playingSince > 120000) restarts = 0;
      return;
    }
    if (!lastProgressAt) return;
    const stalledFor = Date.now() - lastProgressAt;
    if (stalledFor >= STALL_RESTART_MS) {
      restart('no data for ' + Math.round(stalledFor / 1000) + ' s');
    } else if (stalledFor >= STALL_NOTICE_MS && errorBox.hidden) {
      setStatus(t('live_reconnecting'));
    }
  }
  stallTimer = window.setInterval(watch, 1000);

  function orderedChannels() {
    const groups = arrangeChannels(filterChannels(channels, rememberedFilter()));
    return groups.favorites.concat(groups.others);
  }

  function zap(delta) {
    if (!channel) return;
    const next = neighbourChannel(orderedChannels(), channel.id, delta);
    if (!next || next.id === channel.id) return;
    // Rapid presses settle on the last channel before anything opens.
    channel = next;
    restarts = 0;
    lastProgressAt = 0;
    renderInfo();
    setStatus(t('live_starting', { name: next.name }));
    window.clearTimeout(switchTimer);
    switchTimer = window.setTimeout(function () {
      play(next);
    }, CHANNEL_SWITCH_DELAY_MS);
  }

  let guideClose = null;
  async function showGuide() {
    if (!channel || guideClose) return;
    guideClose = await openGuide(channel, null);
    guideClose = null;
  }

  function toggleFullscreen() {
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      else stage.requestFullscreen();
    } catch (err) {}
  }

  async function leave() {
    if (left) return;
    navigateTo('#/livetv');
  }

  function onKey(event) {
    if (event.defaultPrevented || document.querySelector('.jellio-live-guide-overlay')) return;
    const key = event.key;
    // Enter and Space on a focused button press that button.
    const onControl = event.target && /^(BUTTON|INPUT|A)$/.test(event.target.tagName);
    if (onControl && (key === 'Enter' || key === ' ')) {
      showChrome();
      return;
    }
    if (key === 'ArrowUp' || key === 'PageUp' || key === 'ChannelUp') {
      event.preventDefault();
      zap(-1);
    } else if (key === 'ArrowDown' || key === 'PageDown' || key === 'ChannelDown') {
      event.preventDefault();
      zap(1);
    } else if (key === 'g' || key === 'G' || key === 'Guide') {
      event.preventDefault();
      showGuide();
    } else if (key === 'i' || key === 'I' || key === 'Info' || key === 'Enter') {
      event.preventDefault();
      renderInfo();
    } else if (key === 'f' || key === 'F') {
      event.preventDefault();
      toggleFullscreen();
    } else if (key === ' ' || key === 'k') {
      event.preventDefault();
      if (video.paused) video.play().catch(function () {});
      else video.pause();
    } else if (key === 'Escape' || key === 'Backspace' || key === 'BrowserBack') {
      if (document.fullscreenElement) return;
      event.preventDefault();
      leave();
    }
    showChrome();
  }
  document.addEventListener('keydown', onKey);
  stage.addEventListener('mousemove', showChrome);

  // The tab closing still releases the tuner slot.
  function onPageHide() {
    const stream = lifecycle.current();
    if (stream && stream.liveStreamId) closeLiveStream(stream.liveStreamId).catch(function () {});
  }
  window.addEventListener('pagehide', onPageHide);

  setStatus(t('live_starting', { name: '' }));
  try {
    channels = mapChannels(await getLiveChannels(), Date.now());
  } catch (err) {
    showError(describeOpenFailure(err));
  }
  const id = params && params.id;
  const target = channels.find(function (c) {
    return c.id === id;
  }) || (id ? { id: id, name: '', imageTag: null, now: null } : null);
  if (target) {
    play(target);
  } else if (channels.length) {
    play(orderedChannels()[0]);
  } else {
    showError(t('live_no_channels'));
  }
  showChrome();

  return async function cleanup() {
    left = true;
    attempt++;
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('pagehide', onPageHide);
    window.clearInterval(stallTimer);
    window.clearTimeout(infoTimer);
    window.clearTimeout(switchTimer);
    window.clearTimeout(chromeTimer);
    destroyEngine();
    await lifecycle.stop();
  };
}
