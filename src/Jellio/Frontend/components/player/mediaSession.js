// MediaSession metadata and actions (lock screen, media keys, headsets).
// Built by screens/player.js; live is its playerLive accessor object.

import { navigateTo } from '../../runtime/router.js';

export function wireMediaSession(deps, live) {
  const { attemptPlay, backButton, isEpisodeItem, performSeek, seriesAwareArtworkUrl, skipBackButton, video } = deps;

  // === MediaSession API: OS lock screen, media keys, Bluetooth headset controls ===
  live.syncMediaSession = function () {
    if (!('mediaSession' in navigator)) return;
    try {
      const artwork = [];
      const poster = seriesAwareArtworkUrl(800) || seriesAwareArtworkUrl(1600);
      if (poster) {
        artwork.push({ src: poster, sizes: '800x450', type: 'image/jpeg' });
      }
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: isEpisodeItem ? (live.item.Name || 'Episode') : (live.item.Name || 'Video'),
        artist: isEpisodeItem ? live.item.SeriesName : '',
        album: isEpisodeItem && typeof live.item.ParentIndexNumber === 'number' && typeof live.item.IndexNumber === 'number'
          ? ('Season ' + live.item.ParentIndexNumber + ' · Episode ' + live.item.IndexNumber)
          : '',
        artwork: artwork,
      });

      navigator.mediaSession.setActionHandler('play', function () {
        attemptPlay();
      });
      navigator.mediaSession.setActionHandler('pause', function () {
        video.pause();
      });
      navigator.mediaSession.setActionHandler('seekbackward', function (details) {
        const offset = (details && details.seekOffset) || 10;
        performSeek(Math.max(0, video.currentTime - offset));
      });
      navigator.mediaSession.setActionHandler('seekforward', function (details) {
        const offset = (details && details.seekOffset) || 10;
        performSeek(Math.min(live.durationSeconds || video.duration || 0, video.currentTime + offset));
      });
      navigator.mediaSession.setActionHandler('seekto', function (details) {
        if (details && typeof details.seekTime === 'number') {
          performSeek(details.seekTime);
        }
      });
      navigator.mediaSession.setActionHandler('stop', function () {
        backButton.click();
      });
      navigator.mediaSession.setActionHandler('previoustrack', function () {
        skipBackButton.click();
      });
      if (live.nextEpisode) {
        navigator.mediaSession.setActionHandler('nexttrack', function () {
          navigateTo('#/item?id=' + live.nextEpisode.Id);
        });
      }
    } catch (e) {
      console.warn('Jellio: could not initialize MediaSession', e);
    }
  };

  live.syncMediaPosition = function () {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    if (live.durationSeconds > 0 && !isNaN(video.currentTime)) {
      try {
        navigator.mediaSession.setPositionState({
          duration: live.durationSeconds,
          playbackRate: video.playbackRate || 1,
          position: Math.min(live.durationSeconds, Math.max(0, video.currentTime)),
        });
      } catch (e) {}
    }
  };
}
