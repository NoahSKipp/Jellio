// Whether Grouplist and everything that depends on it (screens/home.js's
// own Grouplist tab, the watchlist button's own list picker popover,
// Group Watch chat's own ranking session trigger) should render at all.
// Loaded once in the background at boot, same real reason runtime/
// auth.js's own getCurrentUserId() is a synchronous read off
// already-fetched state rather than every caller awaiting its own real
// round trip: this gets checked on every single card paint, far too
// often for that.
import { getProfileSettings } from './api.js';

let enabled = false;
let loaded = false;

export function isGrouplistEnabled() {
  return enabled;
}

export function loadGrouplistSetting() {
  if (loaded) return Promise.resolve(enabled);
  return getProfileSettings()
    .then(function (settings) {
      enabled = !!(settings && settings.GrouplistEnabled);
      loaded = true;
      return enabled;
    })
    .catch(function () {
      return enabled;
    });
}

// Called from screens/settings.js's own toggle handler, right alongside
// the real POST: every already-mounted screen's own next real render
// reads isGrouplistEnabled() fresh, this just keeps that read correct
// without needing a full reload to see it.
export function setGrouplistEnabledLocal(value) {
  enabled = !!value;
  loaded = true;
}
