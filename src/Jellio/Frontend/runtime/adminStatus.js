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
