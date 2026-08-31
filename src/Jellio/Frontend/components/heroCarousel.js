// Home hero carousel: backdrop, logo art, metadata line, action row, auto
// advance. Ported from the original Jellio codebase's own heroCarousel.js,
// itself a jellyfin-featured/NuvioWeb reference implementation (NuvioWeb's
// own heroCarousel.js is a nine line stub, nothing to port from there),
// adapted to this runtime's own module system and real routing.
// Real feedback: a real Play button here skipped straight into playback
// with no chance to see anything about the title first, not the real
// Nuvio reference (checked directly against screenshots), which only
// ever offers View Details from its own hero. screens/detail.js's own
// Play button is one tap further in, not gone.
import { getHeroCandidates, getImageUrl } from '../runtime/api.js';
import { navigateTo } from '../runtime/router.js';
import { formatRuntime } from '../runtime/format.js';
import { el } from '../runtime/dom.js';

const ROTATE_MS = 9000;
const CANDIDATE_LIMIT = 8;

function metaLine(item) {
  const parts = [];
  if (item.ProductionYear) parts.push(String(item.ProductionYear));
  const runtime = formatRuntime(item.RunTimeTicks);
  if (runtime) parts.push(runtime);
  if (item.OfficialRating) parts.push(item.OfficialRating);
  if (item.Genres && item.Genres.length) parts.push(item.Genres.slice(0, 3).join(', '));
  return parts.join(' • ');
}

// A browser has nothing to interpolate between two url() values, so
// swapping background-image on one element cannot animate: a new layer
// crossfades in over whatever is already there instead, removed once the
// CSS transition finishes.
function crossfadeBackdrop(container, url) {
  const layer = el('div', 'jellio-hero-backdrop-layer');
  layer.style.backgroundImage = 'url(' + url + ')';
  container.appendChild(layer);

  void layer.offsetWidth;
  layer.classList.add('jellio-hero-backdrop-layer-visible');

  const previousLayers = container.querySelectorAll('.jellio-hero-backdrop-layer');
  previousLayers.forEach(function (previous) {
    if (previous === layer) return;
    previous.classList.remove('jellio-hero-backdrop-layer-visible');
    window.setTimeout(function () {
      if (previous.parentNode) previous.parentNode.removeChild(previous);
    }, 900);
  });
}

export function buildHeroCarousel(options) {
  const root = el('div', 'jellio-hero jellio-hero-loading');
  const backdrop = el('div', 'jellio-hero-backdrop');
  const scrim = el('div', 'jellio-hero-scrim');
  const content = el('div', 'jellio-hero-content');

  const logo = document.createElement('img');
  logo.className = 'jellio-hero-logo';
  logo.alt = '';

  const title = el('h1', 'jellio-hero-title');
  const meta = el('div', 'jellio-hero-meta');
  const overview = el('p', 'jellio-hero-overview');
  const actions = el('div', 'jellio-hero-actions');

  const infoButton = el('button', 'jellio-hero-action', 'View Details');
  infoButton.type = 'button';
  actions.appendChild(infoButton);

  content.appendChild(logo);
  content.appendChild(title);
  content.appendChild(meta);
  content.appendChild(overview);
  content.appendChild(actions);

  const dots = el('div', 'jellio-hero-dots');

  const prevButton = el('button', 'jellio-hero-nav jellio-hero-nav-prev');
  prevButton.type = 'button';
  prevButton.setAttribute('aria-label', 'Previous');
  const prevIcon = el('span', 'material-icons chevron_left');
  prevIcon.setAttribute('aria-hidden', 'true');
  prevButton.appendChild(prevIcon);

  const nextButton = el('button', 'jellio-hero-nav jellio-hero-nav-next');
  nextButton.type = 'button';
  nextButton.setAttribute('aria-label', 'Next');
  const nextIcon = el('span', 'material-icons chevron_right');
  nextIcon.setAttribute('aria-hidden', 'true');
  nextButton.appendChild(nextIcon);

  root.appendChild(backdrop);
  root.appendChild(scrim);
  root.appendChild(content);
  root.appendChild(prevButton);
  root.appendChild(nextButton);
  root.appendChild(dots);

  let items = [];
  let index = 0;
  let timer = null;
  let hovered = false;

  function render() {
    if (!items.length) return;
    const item = items[index];

    root.classList.remove('jellio-hero-loading');
    crossfadeBackdrop(backdrop, getImageUrl(item.Id, 'Backdrop', { maxWidth: 1920 }));

    logo.classList.remove('jellio-hero-logo-hidden');
    logo.onerror = function () {
      logo.classList.add('jellio-hero-logo-hidden');
    };
    // css/app.css's own .jellio-hero-logo caps this at 5.5em tall,
    // never more than a few hundred real pixels wide on any real
    // screen; no maxWidth here meant every request served the source
    // logo at its own real original resolution instead, some of them
    // several MB, real cost paid in full for a source-quality asset
    // rendered no bigger than a real button icon.
    logo.src = getImageUrl(item.Id, 'Logo', { maxWidth: 800 });

    title.textContent = item.Name || '';
    meta.textContent = metaLine(item);
    overview.textContent = item.Overview || '';

    dots.textContent = '';
    items.forEach(function (candidate, i) {
      const dot = el('span', 'jellio-hero-dot' + (i === index ? ' jellio-hero-dot-active' : ''));
      dot.addEventListener('click', function () {
        index = i;
        render();
      });
      dots.appendChild(dot);
    });
  }

  infoButton.addEventListener('click', function () {
    if (!items.length) return;
    navigateTo('#/item?id=' + items[index].Id);
  });
  prevButton.addEventListener('click', function () {
    if (!items.length) return;
    index = (index - 1 + items.length) % items.length;
    render();
  });
  nextButton.addEventListener('click', function () {
    if (!items.length) return;
    index = (index + 1) % items.length;
    render();
  });
  root.addEventListener('mouseenter', function () {
    hovered = true;
  });
  root.addEventListener('mouseleave', function () {
    hovered = false;
  });

  getHeroCandidates(CANDIDATE_LIMIT, options)
    .then(function (result) {
      if (!result.length) {
        root.classList.remove('jellio-hero-loading');
        return;
      }
      items = result;
      index = 0;
      render();

      const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduceMotion) return;

      timer = window.setInterval(function () {
        if (hovered || !items.length) return;
        index = (index + 1) % items.length;
        render();
      }, ROTATE_MS);
    })
    .catch(function (err) {
      console.warn('Jellio: hero carousel could not load candidates', err);
      root.classList.remove('jellio-hero-loading');
    });

  return {
    element: root,
    destroy: function () {
      if (timer) window.clearInterval(timer);
    },
  };
}
