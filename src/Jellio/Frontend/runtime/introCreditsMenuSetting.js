// Whether components/cardOptionsMenu.js's own admin-only "Find Skip
// Intro/Credits" right-click entry should show at all
// (Controllers/ConfigController.cs's own real SkipIntroCreditsAdminMenuEnabled,
// off by default). Loaded once in the background at boot, same real
// reason runtime/grouplistSettings.js's own isGrouplistEnabled() is a
// synchronous read off already-fetched state rather than every caller
// awaiting its own real round trip: this gets checked on every single
// card's own right click, far too often for that.
import { getJellioConfig } from './api.js';

let enabled = false;
let loaded = false;

export function isSkipIntroCreditsMenuEnabled() {
  return enabled;
}

export function loadSkipIntroCreditsMenuSetting() {
  if (loaded) return Promise.resolve(enabled);
  return getJellioConfig()
    .then(function (config) {
      enabled = !!(config && config.SkipIntroCreditsAdminMenuEnabled);
      loaded = true;
      return enabled;
    })
    .catch(function () {
      return enabled;
    });
}
