import { getProfileSettings } from './apiSocial.js';

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

export function setGrouplistEnabledLocal(value) {
  enabled = !!value;
  loaded = true;
}
