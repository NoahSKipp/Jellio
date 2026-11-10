// Cast popover (Google Cast, AirPlay, Jellyfin sessions) and the in-player cast banner.
// Built by screens/player.js; live is its playerLive accessor object.

import { TICKS_PER_SECOND, buildCastStreamUrl, getImageUrl } from '../../runtime/api.js';
import {
  addCastListener,
  castToGoogleCast,
  castToJellyfinSession,
  disconnectCast,
  getActiveCast,
  getAvailableCastTargets,
  isAirPlaySupported,
  isGoogleCastSupported,
  promptAirPlay,
  promptRemotePlayback,
} from '../../runtime/cast.js';
import { el } from '../../runtime/dom.js';
import { formatClock } from '../../runtime/format.js';
import { t } from '../../runtime/i18n.js';

export function buildCastControls(deps, live) {
  const {
    castButton, currentTimeLabel, itemId, playPauseButton, playPauseIcon, positionPopover, registerPopover,
    seekBar, seekToAbsoluteSeconds, showPlayerToast, skipBackButton, skipForwardButton, video,
  } = deps;

  // === Cast to Smart TV popover ===
  const castMenu = el('div', 'jellio-player-popover jellio-player-popover-hidden jellio-player-cast-popover');
  const castHeader = el('div', 'jellio-player-cast-header');
  const castTitle = el('div', 'jellio-player-cast-title');
  const castTitleIcon = el('span', 'material-icons cast');
  castTitleIcon.setAttribute('aria-hidden', 'true');
  castTitle.appendChild(castTitleIcon);
  castTitle.appendChild(el('span', null, t('player_cast_to_device')));
  castHeader.appendChild(castTitle);

  const castRefreshBtn = el('button', 'jellio-player-cast-refresh');
  castRefreshBtn.type = 'button';
  castRefreshBtn.setAttribute('aria-label', t('player_refresh_devices'));
  const castRefreshIcon = el('span', 'material-icons refresh');
  castRefreshIcon.setAttribute('aria-hidden', 'true');
  castRefreshBtn.appendChild(castRefreshIcon);
  castHeader.appendChild(castRefreshBtn);
  castMenu.appendChild(castHeader);

  const castBody = el('div', 'jellio-player-cast-body');
  castMenu.appendChild(castBody);

  let isScanningCast = false;
  async function refreshCastMenu() {
    if (isScanningCast) return;
    isScanningCast = true;
    castRefreshBtn.classList.add('spinning');
    castBody.innerHTML = '';

    const currentCast = getActiveCast();
    if (currentCast) {
      const activeBox = el('div', 'jellio-player-cast-active-box');
      const activeRow = el('div', 'jellio-player-cast-active-row');
      const info = el('div', 'jellio-player-cast-device-info');
      info.appendChild(el('div', 'jellio-player-cast-device-name', currentCast.name || 'Connected TV'));
      info.appendChild(el('div', 'jellio-player-cast-device-sub', currentCast.type === 'jellyfin' ? (currentCast.client || 'Jellyfin Client') : 'Wireless Stream'));
      activeRow.appendChild(info);

      const disconnectBtn = el('button', 'jellio-player-cast-disconnect-btn');
      disconnectBtn.type = 'button';
      const disIcon = el('span', 'material-icons cast_connected');
      disIcon.setAttribute('aria-hidden', 'true');
      disconnectBtn.appendChild(disIcon);
      disconnectBtn.appendChild(el('span', null, t('player_disconnect')));
      disconnectBtn.addEventListener('click', async function (e) {
        e.stopPropagation();
        const res = await disconnectCast();
        if (res && res.resumePositionTicks != null) {
          seekToAbsoluteSeconds(res.resumePositionTicks / TICKS_PER_SECOND);
          video.play().catch(function () {});
        }
        refreshCastMenu();
      });
      activeRow.appendChild(disconnectBtn);
      activeBox.appendChild(activeRow);
      castBody.appendChild(activeBox);
    }

    const loadingBox = el('div', 'jellio-player-cast-loading');
    const loadingSpinner = el('div', 'jellio-player-cast-loading-spinner');
    const spinIcon = el('span', 'material-icons', 'sync');
    spinIcon.setAttribute('aria-hidden', 'true');
    loadingSpinner.appendChild(spinIcon);
    loadingBox.appendChild(loadingSpinner);

    const loadingText = el('div', 'jellio-player-cast-loading-text');
    loadingText.appendChild(el('div', 'jellio-player-cast-loading-title', t('player_looking_devices')));
    loadingText.appendChild(el('div', 'jellio-player-cast-loading-sub', t('player_scanning_network')));
    loadingBox.appendChild(loadingText);
    castBody.appendChild(loadingBox);

    if (!castMenu.classList.contains('jellio-player-popover-hidden')) {
      positionPopover(castButton, castMenu);
    }

    try {
      const [targets] = await Promise.all([
        getAvailableCastTargets(),
        new Promise(function (resolve) { setTimeout(resolve, 350); }),
      ]);
      loadingBox.remove();

      const tvTargets = targets.filter(function (t) { return t.isTv; });
      const otherTargets = targets.filter(function (t) { return !t.isTv; });

      if (tvTargets.length > 0) {
        castBody.appendChild(el('div', 'jellio-player-cast-section-title', t('player_smart_tvs')));
        tvTargets.forEach(function (target) {
          castBody.appendChild(buildCastDeviceButton(target, 'tv'));
        });
      }

      if (otherTargets.length > 0) {
        castBody.appendChild(el('div', 'jellio-player-cast-section-title', t('player_other_clients')));
        otherTargets.forEach(function (target) {
          castBody.appendChild(buildCastDeviceButton(target, 'devices'));
        });
      }

      const googleCastAvailable = isGoogleCastSupported();
      const airplayAvailable = isAirPlaySupported(video);
      const hasWireless = googleCastAvailable || airplayAvailable;

      if (targets.length === 0) {
        const emptyBox = el('div', 'jellio-player-cast-empty');
        const emptyIconWrap = el('div', 'jellio-player-cast-empty-icon');
        const emptyIcon = el('span', 'material-icons', 'tv_off');
        emptyIcon.setAttribute('aria-hidden', 'true');
        emptyIconWrap.appendChild(emptyIcon);
        emptyBox.appendChild(emptyIconWrap);

        const emptyTitle = el('div', 'jellio-player-cast-empty-title', t('player_no_devices'));
        emptyBox.appendChild(emptyTitle);

        const emptySub = el('div', 'jellio-player-cast-empty-sub', hasWireless
          ? 'No Smart TVs or Jellyfin apps were detected on your local network. You can still stream via the wireless options below.'
          : 'Make sure your Smart TV or Chromecast is turned on and connected to the same Wi-Fi network.');
        emptyBox.appendChild(emptySub);
        castBody.appendChild(emptyBox);
      }

      function useDirectSourceForRemote(url, asHls) {
        const positionSec = (live.streamOffsetTicks / TICKS_PER_SECOND) + (video.currentTime || 0);
        let next = url;
        if (asHls) {
          next = url.replace('/stream.mp4?', '/master.m3u8?').replace(/&?StartTimeTicks=\d+/, '');
        }
        if (video.currentSrc === next) return;
        live.streamOffsetTicks = asHls ? 0 : Math.round(positionSec * TICKS_PER_SECOND);
        video.src = next;
        if (asHls) {
          video.addEventListener('loadedmetadata', function () {
            try { video.currentTime = positionSec; } catch (_) {}
          }, { once: true });
        }
        video.load();
        video.play().catch(function () {});
      }

      if (hasWireless) {
        const wirelessTitle = el('div', 'jellio-player-cast-section-title', t('player_wireless_display'));
        castBody.appendChild(wirelessTitle);

        if (googleCastAvailable) {
          const gcastBtn = el('button', 'jellio-player-cast-device-btn');
          gcastBtn.type = 'button';
          const iconWrap = el('div', 'jellio-player-cast-device-icon');
          const icon = el('span', 'material-icons cast');
          icon.setAttribute('aria-hidden', 'true');
          iconWrap.appendChild(icon);
          gcastBtn.appendChild(iconWrap);

          const info = el('div', 'jellio-player-cast-device-info');
          info.appendChild(el('div', 'jellio-player-cast-device-name', 'Google Cast / Chromecast'));
          info.appendChild(el('div', 'jellio-player-cast-device-sub', t('player_cast_browser_desc')));
          gcastBtn.appendChild(info);

          gcastBtn.addEventListener('click', async function () {
            try {
              castMenu.classList.add('jellio-player-popover-hidden');
              const currentSec = (live.streamOffsetTicks / TICKS_PER_SECOND) + (video.currentTime || 0);
              const currentTicks = Math.round(currentSec * TICKS_PER_SECOND);
              const castStreamUrl = buildCastStreamUrl(itemId, live.mediaSource, currentTicks, {
                audioStreamIndex: live.currentAudioStreamIndex,
                subtitleStreamIndex: live.activeSubtitleStreamIndex,
              });

              const preferRemotePlayback = /Android/i.test(navigator.userAgent) &&
                typeof video.remote !== 'undefined' && typeof video.remote.prompt === 'function';
              if (window.cast && window.cast.framework && !preferRemotePlayback) {
                await castToGoogleCast(castStreamUrl, live.item, currentSec, {
                  mediaSource: live.mediaSource,
                  startOffsetTicks: currentTicks,
                  posterUrl: getImageUrl(itemId, 'Primary', { maxWidth: 800 }),
                });
                video.pause();
                showPlayerToast(t('player_cast_google'));
              } else if (typeof video.remote !== 'undefined' && typeof video.remote.prompt === 'function') {
                // A Media Source stream cannot be handed to a cast device, so the
                // picker would list nothing; route a plain stream URL instead.
                useDirectSourceForRemote(castStreamUrl, false);
                await promptRemotePlayback(video);
                showPlayerToast(t('player_cast_wireless'));
              } else {
                await castToGoogleCast(castStreamUrl, live.item, currentSec, {
                  mediaSource: live.mediaSource,
                  startOffsetTicks: currentTicks,
                  posterUrl: getImageUrl(itemId, 'Primary', { maxWidth: 800 }),
                });
                video.pause();
                showPlayerToast(t('player_cast_google'));
              }
            } catch (err) {
              if (
                err &&
                (err.name === 'AbortError' ||
                 err.name === 'NotAllowedError' ||
                 err.name === 'NotFoundError' ||
                 (err.message && (err.message.includes('dismissed') || err.message.includes('cancel') || err.message.includes('not selected'))))
              ) {
                // User simply dismissed or closed the browser's native Cast dialog
                return;
              }
              console.warn('Jellio: Google Cast failed', err);
              showPlayerToast(t('player_cast_connect_failed', { error: err && err.message ? err.message : t('player_cast_no_device') }));
            }
          });
          castBody.appendChild(gcastBtn);
        }

        if (airplayAvailable) {
          const airplayBtn = el('button', 'jellio-player-cast-device-btn');
          airplayBtn.type = 'button';
          const iconWrap = el('div', 'jellio-player-cast-device-icon');
          const icon = el('span', 'material-icons airplay');
          icon.setAttribute('aria-hidden', 'true');
          iconWrap.appendChild(icon);
          airplayBtn.appendChild(iconWrap);

          const info = el('div', 'jellio-player-cast-device-info');
          info.appendChild(el('div', 'jellio-player-cast-device-name', t('player_airplay')));
          info.appendChild(el('div', 'jellio-player-cast-device-sub', t('player_airplay_desc')));
          airplayBtn.appendChild(info);

          airplayBtn.addEventListener('click', function () {
            castMenu.classList.add('jellio-player-popover-hidden');
            try {
              useDirectSourceForRemote(buildCastStreamUrl(itemId, live.mediaSource, 0, {
                audioStreamIndex: live.currentAudioStreamIndex,
                subtitleStreamIndex: live.activeSubtitleStreamIndex,
              }), true);
              promptAirPlay(video);
            } catch (err) {
              showPlayerToast(t('player_airplay_unavailable'));
            }
          });
          castBody.appendChild(airplayBtn);
        }
      }
    } catch (err) {
      console.warn('Jellio: error populating cast menu', err);
      loadingBox.remove();
      const errBox = el('div', 'jellio-player-cast-empty');
      const errIconWrap = el('div', 'jellio-player-cast-empty-icon');
      const errIcon = el('span', 'material-icons', 'error_outline');
      errIcon.setAttribute('aria-hidden', 'true');
      errIconWrap.appendChild(errIcon);
      errBox.appendChild(errIconWrap);
      errBox.appendChild(el('div', 'jellio-player-cast-empty-title', t('player_search_devices_error')));
      errBox.appendChild(el('div', 'jellio-player-cast-empty-sub', t('player_check_connection_retry')));
      castBody.appendChild(errBox);
    } finally {
      isScanningCast = false;
      castRefreshBtn.classList.remove('spinning');
      if (!castMenu.classList.contains('jellio-player-popover-hidden')) {
        positionPopover(castButton, castMenu);
      }
    }
  }

  function buildCastDeviceButton(target, defaultIconName) {
    const btn = el('button', 'jellio-player-cast-device-btn');
    btn.type = 'button';

    const iconWrap = el('div', 'jellio-player-cast-device-icon');
    const icon = el('span', 'material-icons ' + defaultIconName);
    icon.setAttribute('aria-hidden', 'true');
    iconWrap.appendChild(icon);
    btn.appendChild(iconWrap);

    const info = el('div', 'jellio-player-cast-device-info');
    info.appendChild(el('div', 'jellio-player-cast-device-name', target.name));
    const subText = target.nowPlaying ? ('Playing: ' + target.nowPlaying) : (target.client || 'Ready to stream');
    info.appendChild(el('div', 'jellio-player-cast-device-sub', subText));
    btn.appendChild(info);

    if (target.isTv) {
      btn.appendChild(el('span', 'jellio-player-cast-device-badge', t('player_smart_tv_label')));
    }

    btn.addEventListener('click', async function () {
      try {
        const currentTicks = Math.round((live.streamOffsetTicks / TICKS_PER_SECOND + (video.currentTime || 0)) * TICKS_PER_SECOND);
        video.pause();
        castMenu.classList.add('jellio-player-popover-hidden');
        showPlayerToast(t('player_cast_streaming_to', { name: target.name }));
        await castToJellyfinSession(target, itemId, currentTicks, live.mediaSource, live.currentAudioStreamIndex, live.activeSubtitleStreamIndex);
        showPlayerToast(t('player_cast_casting_on', { name: target.name }));
      } catch (err) {
        console.warn('Jellio: failed to cast to ' + target.name, err);
        showPlayerToast(t('player_cast_failed', { name: target.name }));
      }
    });

    return btn;
  }

  registerPopover(castButton, castMenu);
  castButton.addEventListener('click', function () {
    if (!castMenu.classList.contains('jellio-player-popover-hidden')) {
      refreshCastMenu();
    }
  });
  castRefreshBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    refreshCastMenu();
  });

  live.toggleCastMenu = function () {
    castButton.click();
  };

  // === In-player floating Cast Banner ===
  const castBanner = el('div', 'jellio-player-cast-banner');
  castBanner.style.display = 'none';

  const castBannerIcon = el('span', 'material-icons cast_connected jellio-player-cast-banner-icon');
  castBannerIcon.setAttribute('aria-hidden', 'true');
  const castBannerText = el('span', 'jellio-player-cast-banner-text', t('player_streaming_to_smart_tv'));

  const castBannerControls = el('div', 'jellio-player-cast-banner-controls');
  const bannerSkipBack = el('button', 'jellio-player-cast-banner-btn');
  bannerSkipBack.type = 'button';
  bannerSkipBack.setAttribute('aria-label', t('player_skip_back_10s'));
  bannerSkipBack.appendChild(el('span', 'material-icons replay_10'));
  bannerSkipBack.addEventListener('click', function () {
    skipBackButton.click();
  });

  const bannerPlayPause = el('button', 'jellio-player-cast-banner-btn');
  bannerPlayPause.type = 'button';
  bannerPlayPause.setAttribute('aria-label', t('player_play_pause_tv'));
  const bannerPlayPauseIcon = el('span', 'material-icons pause');
  bannerPlayPause.appendChild(bannerPlayPauseIcon);
  bannerPlayPause.addEventListener('click', function () {
    playPauseButton.click();
  });

  const bannerSkipForward = el('button', 'jellio-player-cast-banner-btn');
  bannerSkipForward.type = 'button';
  bannerSkipForward.setAttribute('aria-label', t('player_skip_fwd_30s'));
  bannerSkipForward.appendChild(el('span', 'material-icons forward_30'));
  bannerSkipForward.addEventListener('click', function () {
    skipForwardButton.click();
  });

  const bannerDisconnect = el('button', 'jellio-player-cast-banner-disconnect', t('player_resume_here'));
  bannerDisconnect.type = 'button';
  bannerDisconnect.setAttribute('aria-label', t('player_stop_casting'));
  bannerDisconnect.addEventListener('click', async function () {
    const res = await disconnectCast();
    if (res && res.resumePositionTicks != null) {
      seekToAbsoluteSeconds(res.resumePositionTicks / TICKS_PER_SECOND);
      video.play().catch(function () {});
    }
  });

  castBannerControls.appendChild(bannerSkipBack);
  castBannerControls.appendChild(bannerPlayPause);
  castBannerControls.appendChild(bannerSkipForward);
  castBannerControls.appendChild(bannerDisconnect);

  castBanner.appendChild(castBannerIcon);
  castBanner.appendChild(castBannerText);
  castBanner.appendChild(castBannerControls);

  const unsubscribeCast = addCastListener(function (castState) {
    const isCasting = Boolean(castState);
    castButton.classList.toggle('jellio-player-pill-btn-active', isCasting);
    const iconName = isCasting ? 'cast_connected' : 'cast';
    const pillIcon = castButton.querySelector('.material-icons');
    if (pillIcon) pillIcon.className = 'material-icons ' + iconName;

    if (isCasting) {
      castBanner.style.display = 'flex';
      castBannerText.textContent = t('player_streaming_to', { name: castState.name || t('player_smart_tvs') });
      bannerPlayPauseIcon.className = 'material-icons ' + (castState.isPaused ? 'play_arrow' : 'pause');
      playPauseIcon.className = 'material-icons ' + (castState.isPaused ? 'play_arrow' : 'pause');
      playPauseButton.setAttribute('aria-label', castState.isPaused ? 'Play' : 'Pause');

      if (castState.positionTicks != null && !live.seeking) {
        const sec = castState.positionTicks / TICKS_PER_SECOND;
        currentTimeLabel.textContent = formatClock(sec);
        if (live.durationSeconds > 0) {
          seekBar.value = String(Math.min(100, Math.max(0, (sec / live.durationSeconds) * 100)));
        }
      }
    } else {
      castBanner.style.display = 'none';
      playPauseIcon.className = 'material-icons ' + (video.paused ? 'play_arrow' : 'pause');
      playPauseButton.setAttribute('aria-label', video.paused ? 'Play' : 'Pause');
    }
  });
  return { castMenu, castBanner, unsubscribeCast };
}
