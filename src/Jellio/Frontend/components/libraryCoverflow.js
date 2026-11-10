import { translateGenre } from '../runtime/i18n.js';
import { t } from '../runtime/i18n.js';
import { getHeroCandidates, getImageUrl } from '../runtime/api.js';
import { navigateTo } from '../runtime/router.js';
import { rotationSeed, seededShuffle } from '../runtime/editorial.js';
import { el } from '../runtime/dom.js';

const CANDIDATE_LIMIT = 8;

const MIN_SLIDES = 3;
const ADVANCE_MS = 7000;

function metaLine(item) {
  if (!item) return '';
  const parts = [];
  if (item.ProductionYear) parts.push(String(item.ProductionYear));
  if (item.Genres) {
    const list = Array.isArray(item.Genres)
      ? item.Genres
      : typeof item.Genres === 'string'
      ? item.Genres.split(',').map(function (s) { return s.trim(); }).filter(Boolean)
      : [];
    if (list.length) {
      parts.push.apply(
        parts,
        list.slice(0, 2).map(function (genre) {
          try {
            return translateGenre(genre);
          } catch (_) {
            return genre;
          }
        })
      );
    }
  }
  return parts.join(' · ');
}

function buildButton(label, className, item) {
  const button = el('button', className, label);
  button.type = 'button';
  button.addEventListener('click', function (event) {
    event.stopPropagation();
    navigateTo('#/item?id=' + item.Id);
  });
  return button;
}

function buildSlide(item) {
  const slide = el('div', 'jellio-coverflow-slide');

  const backdropTag = item.BackdropImageTags && item.BackdropImageTags[0];
  const art = document.createElement('img');
  art.className = 'jellio-coverflow-art';
  art.alt = '';
  art.loading = 'lazy';
  if (backdropTag) {
    art.src = getImageUrl(item.Id, 'Backdrop', { tag: backdropTag, maxWidth: 960, quality: 85 });
  } else if (item.ParentBackdropItemId && item.ParentBackdropImageTags && item.ParentBackdropImageTags[0]) {
    art.src = getImageUrl(item.ParentBackdropItemId, 'Backdrop', { tag: item.ParentBackdropImageTags[0], maxWidth: 960, quality: 85 });
  } else if (item.ImageTags && item.ImageTags.Primary) {
    art.src = getImageUrl(item.Id, 'Primary', { tag: item.ImageTags.Primary, maxWidth: 960, quality: 85 });
  }
  slide.appendChild(art);

  slide.appendChild(el('div', 'jellio-coverflow-scrim'));

  const info = el('div', 'jellio-coverflow-info');

  const logoTag = item.ImageTags && item.ImageTags.Logo;
  if (logoTag) {
    const logo = document.createElement('img');
    logo.className = 'jellio-coverflow-logo';
    logo.alt = item.Name || '';
    logo.src = getImageUrl(item.Id, 'Logo', { tag: logoTag, maxWidth: 480 });
    logo.onerror = function () {
      logo.remove();
      info.insertBefore(el('h2', 'jellio-coverflow-title', item.Name || ''), info.firstChild);
    };
    info.appendChild(logo);
  } else {
    info.appendChild(el('h2', 'jellio-coverflow-title', item.Name || ''));
  }

  info.appendChild(el('div', 'jellio-coverflow-meta', metaLine(item)));

  const actions = el('div', 'jellio-coverflow-actions');
  actions.appendChild(buildButton('View Details', 'jellio-coverflow-button', item));
  info.appendChild(actions);

  slide.appendChild(info);
  return slide;
}

function buildEditorial(editorial) {
  const wrap = el('div', 'jellio-coverflow-editorial');
  const eyebrow = el('div', 'jellio-coverflow-editorial-eyebrow');
  const icon = el('span', 'material-icons ' + (editorial.icon || 'schedule'));
  icon.setAttribute('aria-hidden', 'true');
  eyebrow.appendChild(icon);
  eyebrow.appendChild(el('span', 'jellio-coverflow-editorial-label', editorial.label));
  wrap.appendChild(eyebrow);
  wrap.appendChild(el('h2', 'jellio-coverflow-editorial-tagline', editorial.tagline));
  wrap.appendChild(el('p', 'jellio-coverflow-editorial-description', editorial.description));
  return wrap;
}

function buildCoverflowBadge(badge) {
  const wrap = el('div', 'jellio-coverflow-badge');
  const icon = el('span', 'material-icons ' + badge.icon);
  icon.setAttribute('aria-hidden', 'true');
  wrap.appendChild(icon);
  wrap.appendChild(el('span', null, badge.text));
  return wrap;
}

export function buildLibraryCoverflow(options) {
  const root = el('div', 'jellio-coverflow');
  if (options && options.editorial) {
    root.appendChild(buildEditorial(options.editorial));
  } else if (options && options.badge) {
    root.appendChild(buildCoverflowBadge(options.badge));
  }
  const stage = el('div', 'jellio-coverflow-stage');
  const dotsEl = el('div', 'jellio-coverflow-dots');
  root.appendChild(stage);
  root.appendChild(dotsEl);

  let items = [];
  let slides = [];
  let dots = [];
  let index = 0;
  let timer = null;
  let destroyed = false;
  // Paused while the tab is hidden.
  document.addEventListener('visibilitychange', restartTimer);
  let hovered = false;

  root.addEventListener('mouseenter', function () {
    hovered = true;
  });
  root.addEventListener('mouseleave', function () {
    hovered = false;
  });

  function render() {
    const n = items.length;
    for (let i = 0; i < n; i++) {
      const raw = i - index;
      let offset = ((raw % n) + n) % n;
      if (offset > n / 2) offset -= n;

      const slide = slides[i];
      slide.style.setProperty('--jellio-cf-offset', String(offset));

      const near = Math.abs(offset) <= 1;
      const current = offset === 0;
      slide.classList.toggle('jellio-coverflow-slide-near', near);
      slide.classList.toggle('jellio-coverflow-slide-far', !near);
      slide.classList.toggle('jellio-coverflow-slide-current', current);
      slide.setAttribute('aria-hidden', near ? 'false' : 'true');

      const buttons = slide.querySelectorAll('.jellio-coverflow-button');
      buttons.forEach(function (button) {
        if (current) {
          button.removeAttribute('tabindex');
        } else {
          button.setAttribute('tabindex', '-1');
        }
      });

      dots[i].classList.toggle('jellio-coverflow-dot-active', current);
    }
  }

  function restartTimer() {
    if (timer) window.clearInterval(timer);
    timer = null;
    if (destroyed || items.length < 2 || document.hidden) return;
    timer = window.setInterval(function () {
      if (hovered) return;
      go(index + 1);
    }, ADVANCE_MS);
  }

  function go(next) {
    const n = items.length;
    if (!n) return;
    index = ((next % n) + n) % n;
    render();
    restartTimer();
  }

  function build() {
    stage.textContent = '';
    dotsEl.textContent = '';
    slides = [];
    dots = [];

    items.forEach(function (item, i) {
      const slide = buildSlide(item);
      slide.addEventListener('click', function () {
        if (i === index) {
          navigateTo('#/item?id=' + item.Id);
        } else {
          go(i);
        }
      });
      stage.appendChild(slide);
      slides.push(slide);

      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'jellio-coverflow-dot';
      dot.setAttribute('aria-label', t('coverflow_show_item', { index: i + 1 }));
      dot.addEventListener('click', function () {
        go(i);
      });
      dotsEl.appendChild(dot);
      dots.push(dot);
    });

    render();
    restartTimer();
  }

  const fetchCandidates =
    options && options.items ? Promise.resolve(options.items) : getHeroCandidates(CANDIDATE_LIMIT, options);

  const ready = fetchCandidates
    .then(function (result) {
      if (!result || result.length < MIN_SLIDES) return false;
      items = options && options.rotate ? seededShuffle(result, rotationSeed()) : result;
      index = 0;
      build();
      return true;
    })
    .catch(function (err) {
      console.warn('Jellio: coverflow could not load candidates', err);
      return false;
    });

  return {
    element: root,
    ready: ready,
    destroy: function () {
      destroyed = true;
      document.removeEventListener('visibilitychange', restartTimer);
      if (timer) window.clearInterval(timer);
    },
  };
}
