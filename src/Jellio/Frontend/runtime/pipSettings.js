// Whether playback moves into picture in picture by itself when the tab
// is left. On unless turned off; client only, like the other playback
// display preferences.
const KEY = 'jellioAutoPictureInPicture';

export function isAutoPipEnabled() {
  try {
    return window.localStorage.getItem(KEY) !== 'off';
  } catch (err) {
    return true;
  }
}

export function setAutoPipEnabled(on) {
  try {
    window.localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch (err) {
    // Not persisted, this tab still uses the chosen value until reload.
  }
}
