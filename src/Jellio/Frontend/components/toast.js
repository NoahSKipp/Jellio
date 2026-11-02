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

export function showToast(message, onClick, options) {
  const opts = options || {};
  const node = ensureToast();
  node.textContent = '';
  node.classList.toggle('jellio-toast-with-image', !!opts.imageUrl);
  if (opts.imageUrl) {
    const img = document.createElement('img');
    img.className = 'jellio-toast-image';
    img.alt = '';
    img.src = opts.imageUrl;
    img.addEventListener('error', () => img.remove());
    node.appendChild(img);
  }
  if (message) {
    const text = document.createElement('span');
    text.className = 'jellio-toast-text';
    text.textContent = message;
    node.appendChild(text);
  }
  node.onclick = onClick || null;
  node.classList.toggle('jellio-toast-clickable', !!onClick);
  node.classList.add('jellio-toast-visible');
  if (hideTimer) window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(function () {
    node.classList.remove('jellio-toast-visible');
  }, opts.imageUrl ? HIDE_MS + 4000 : HIDE_MS);
}
