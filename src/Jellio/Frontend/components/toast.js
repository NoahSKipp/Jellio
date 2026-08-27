// App wide toast, one real instance for the whole page: screens/player.js's
// own showPlayerToast already does the identical job scoped to that one
// screen's own root, this is the same real idea for anything that can
// fire from outside a screen entirely (components/notifications.js's own
// "new release" message, the one real caller today). Self starting,
// module level singleton, same real reason components/nowPlaying.js's
// own panel exists for the life of the page rather than being rebuilt.
const HIDE_MS = 6000;

let toast = null;
let hideTimer = null;

function ensureToast() {
  if (toast) return toast;
  toast = document.createElement('div');
  toast.id = 'jellioToast';
  toast.className = 'jellio-toast';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  document.body.appendChild(toast);
  return toast;
}

// onClick, when given, makes the toast itself a real shortcut to
// whatever it is telling the reader about (components/notifications.js's
// own release toast, straight to the title) rather than just an
// announcement with no way to act on it before it fades.
export function showToast(message, onClick) {
  const node = ensureToast();
  node.textContent = message;
  node.onclick = onClick || null;
  node.classList.toggle('jellio-toast-clickable', !!onClick);
  node.classList.add('jellio-toast-visible');
  if (hideTimer) window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(function () {
    node.classList.remove('jellio-toast-visible');
  }, HIDE_MS);
}
