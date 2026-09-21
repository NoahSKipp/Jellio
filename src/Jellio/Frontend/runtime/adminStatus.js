// Whether the signed in reader is a real Jellyfin admin
// (UserDto.Policy.IsAdministrator), loaded once in the background at
// boot, same real reason runtime/grouplistSettings.js's own
// isGrouplistEnabled() is a synchronous read off already-fetched state
// rather than every caller awaiting its own real round trip:
// components/cardOptionsMenu.js checks this on every single card's own
// right click, far too often for that.
import { getCurrentUser } from './api.js';

let isAdmin = false;
let loaded = false;

export function isAdminSync() {
  return isAdmin;
}

export function loadAdminStatus() {
  if (loaded) return Promise.resolve(isAdmin);
  return getCurrentUser()
    .then(function (user) {
      isAdmin = !!(user && user.Policy && user.Policy.IsAdministrator);
      loaded = true;
      return isAdmin;
    })
    .catch(function () {
      return isAdmin;
    });
}
