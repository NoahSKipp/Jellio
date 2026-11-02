import { getJellioConfig } from './api.js';

let enabled = false;

export function isSkipIntroCreditsMenuEnabled() {
  return enabled;
}

export function loadSkipIntroCreditsMenuSetting() {
  return getJellioConfig()
    .then(function (config) {
      enabled = !!(config && config.SkipIntroCreditsAdminMenuEnabled);
      return enabled;
    })
    .catch(function () {
      return enabled;
    });
}
