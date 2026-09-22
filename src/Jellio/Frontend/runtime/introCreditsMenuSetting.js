// Whether components/cardOptionsMenu.js's own admin-only "Find Skip
// Intro/Credits" right-click entry should show at all
// (Controllers/ConfigController.cs's own real SkipIntroCreditsAdminMenuEnabled,
// off by default). A synchronous read off already-fetched state, same
// real reason runtime/grouplistSettings.js's own isGrouplistEnabled()
// is: this gets checked on every single card's own right click, far too
// often for every caller to await its own real round trip.
//
// Deliberately NOT cached forever the way runtime/adminStatus.js's own
// isAdminSync() is: real feedback was explicit this toggle gets flipped
// on right before a real sweep and back off again right after, in the
// same already-open tab, not just once at boot. app.js's own real route
// transition handler calls loadSkipIntroCreditsMenuSetting() again on
// every single navigation, so this re-reads getJellioConfig() every
// time too - cheap, that call already carries its own real short lived
// cache (runtime/api.js's own SHORT_CACHE_TTL_MS, a few seconds), so a
// setting an admin just changed shows up on this tab's own very next
// navigation rather than needing a hard reload to notice it at all.
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
