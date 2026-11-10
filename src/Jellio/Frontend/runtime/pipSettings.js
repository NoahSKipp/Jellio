import { readString, writeString } from './storage.js';

const KEY = 'jellioAutoPictureInPicture';

export function isAutoPipEnabled() {
  try {
    return readString(KEY) !== 'off';
  } catch (err) {
    return true;
  }
}

export function setAutoPipEnabled(on) {
  writeString(KEY, on ? 'on' : 'off');
}
