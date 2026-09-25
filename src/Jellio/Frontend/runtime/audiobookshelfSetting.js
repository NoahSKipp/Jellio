// Whether components/sidebar.js's own Books entry should show at all,
// and where it points (Configuration/PluginConfiguration.cs's own real
// AudiobookshelfUrl, blank by default). Same synchronous-read-off-
// already-fetched-state shape as runtime/introCreditsMenuSetting.js:
// sidebar.js builds its rail once and does not want to await a real
// round trip just to decide whether one more button belongs on it.
import { getJellioConfig } from './api.js';

let url = '';

export function getAudiobookshelfUrl() {
  return url;
}

export function loadAudiobookshelfSetting() {
  return getJellioConfig()
    .then(function (config) {
      url = (config && config.AudiobookshelfUrl) || '';
      return url;
    })
    .catch(function () {
      return url;
    });
}
