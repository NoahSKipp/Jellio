// Screen overlays an admin sends from the dashboard
// (Controllers/OverlaysController.cs): a picture or a line of text in the
// middle of the screen at the chosen opacity for the chosen seconds,
// over everything and never in the way of a click.
import { isAuthenticated, getServerAddress, getAccessToken } from '../runtime/auth.js';
import { getPendingOverlays } from '../runtime/api.js';

const POLL_MS = 5000;
const FADE_MS = 400;

let started = false;
let after = -1;
let queue = [];
let showing = false;

function imageUrl(id) {
  return getServerAddress() + '/Jellio/overlays/image/' + encodeURIComponent(id) + '?ApiKey=' + encodeURIComponent(getAccessToken() || '');
}

function showNext() {
  if (showing || !queue.length) return;
  const overlay = queue.shift();
  showing = true;
  const layer = document.createElement('div');
  layer.className = 'jellio-screen-overlay';
  const opacity = Math.min(1, Math.max(0.05, (overlay.Opacity || 80) / 100));
  if (overlay.ImageId) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = imageUrl(overlay.ImageId);
    layer.appendChild(img);
  }
  if (overlay.Text) {
    const text = document.createElement('div');
    text.className = 'jellio-screen-overlay-text';
    text.textContent = overlay.Text;
    layer.appendChild(text);
  }
  document.body.appendChild(layer);
  window.requestAnimationFrame(function () {
    layer.style.opacity = String(opacity);
  });
  window.setTimeout(function () {
    layer.style.opacity = '0';
    window.setTimeout(function () {
      layer.remove();
      showing = false;
      showNext();
    }, FADE_MS);
  }, Math.max(1, overlay.Seconds || 5) * 1000);
}

function poll() {
  if (!isAuthenticated() || document.hidden) {
    window.setTimeout(poll, POLL_MS);
    return;
  }
  getPendingOverlays(after)
    .then(function (data) {
      const first = after < 0;
      if (data && typeof data.Latest === 'number') after = data.Latest;
      if (!first && data && data.Overlays && data.Overlays.length) {
        queue = queue.concat(data.Overlays);
        showNext();
      }
    })
    .catch(function () {})
    .then(function () {
      window.setTimeout(poll, POLL_MS);
    });
}

export function startOverlays() {
  if (started || !isAuthenticated()) return;
  started = true;
  poll();
}
