import { transitionsAllowed } from './motionSettings.js';
import { cssUrl } from './safeUrl.js';

// Shared DOM element builder, previously copy pasted byte for byte at the
// top of every screen and component file in this bundle.
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function fadeInBackdrop(target, url) {
  if (!url) return;
  const css = cssUrl(url);
  const probe = new Image();
  probe.src = url;
  if (!transitionsAllowed() || probe.complete) {
    target.style.backgroundImage = css;
    return;
  }
  const layer = el('div', 'jellio-backdrop-fade');
  layer.style.backgroundImage = css;
  target.style.isolation = 'isolate';
  target.insertBefore(layer, target.firstChild);
  const reveal = function () {
    layer.classList.add('jellio-backdrop-fade-visible');
    window.setTimeout(function () {
      target.style.backgroundImage = css;
      layer.remove();
    }, 450);
  };
  probe.onload = reveal;
  probe.onerror = function () {
    layer.remove();
  };
}
