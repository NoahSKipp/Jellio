import { deleteJson, getJson, postJson } from './core.js';

export function getNotifications() {
  return getJson('/Jellio/notifications');
}

export function getPendingOverlays(after) {
  return getJson('/Jellio/overlays/pending?after=' + encodeURIComponent(after), 8000);
}

export function getPendingSounds(after) {
  return getJson('/Jellio/sounds/pending?after=' + encodeURIComponent(after), 8000);
}

export function markNotificationsRead() {
  return postJson('/Jellio/notifications/read', {});
}

export function deleteNotification(id) {
  return deleteJson('/Jellio/notifications/' + encodeURIComponent(id));
}

export function clearAllNotifications() {
  return deleteJson('/Jellio/notifications');
}

export function getNowPlayingSessions() {
  return getJson('/Jellio/now-playing');
}

export function getOnlineUserIds() {
  return getJson('/Jellio/online-users');
}
