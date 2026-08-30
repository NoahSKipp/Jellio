// Coverflow carousel for the library pages, ported from the original
// codebase's own libraryCoverflow.js: three wide cards, the middle one
// lit and carrying logo, meta and actions, the neighbours dimmed and
// tucked slightly under it, a move that carries right to middle,
// middle to left, left out. Home keeps its own heroCarousel.js (one
// full bleed backdrop, absolutely positioned copy); this is a second
// component rather than a mode of that one, real feedback asked
// directly for library pages to use this shape instead, not the hero's.
//
// Where a slide sits is expressed as --jellio-cf-offset, a signed step
// from the centre, css/app.css turns that into a transform; this file
// only decides ordering, which is what keeps the wrap working: the
// offset is always the shortest way round.
import { getHeroCandidates, getImageUrl } from '../runtime/api.js';
import { navigateTo } from '../runtime/router.js';

const CANDIDATE_LIMIT = 8;

// Below this a coverflow is not a coverflow: the overlapping side cards
// are the whole shape of it. Same floor the original codebase's own
// file uses, not re-derived.
const MIN_SLIDES = 3;
const ADVANCE_MS = 7000;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function metaLine(item) {
  const parts = [];
  if (item.ProductionYear) parts.push(String(item.ProductionYear));
  if (item.Genres && item.Genres.length) {
    parts.push.apply(parts, item.Genres.slice(0, 2));
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
    art.src = getImageUrl(item.Id, 'Backdrop', { tag: backdropTag, maxWidth: 1280 });
  } else if (item.ImageTags && item.ImageTags.Primary) {
    art.src = getImageUrl(item.Id, 'Primary', { tag: item.ImageTags.Primary, maxWidth: 1280 });
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
  actions.appendChild(buildButton('Play', 'jellio-coverflow-button', item));
  actions.appendChild(
    buildButton(
      item.Type === 'Series' ? 'Episodes' : 'More info',
      'jellio-coverflow-button jellio-coverflow-button-secondary',
      item,
    ),
  );
  info.appendChild(actions);

  slide.appendChild(info);
  return slide;
}

export function buildLibraryCoverflow(options) {
  const root = el('div', 'jellio-coverflow');
  const stage = el('div', 'jellio-coverflow-stage');
  const dotsEl = el('div', 'jellio-coverflow-dots');
  root.appendChild(stage);
  root.appendChild(dotsEl);

  let items = [];
  let slides = [];
  let dots = [];
  let index = 0;
  let timer = null;
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
    if (items.length < 2) return;
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
      dot.setAttribute('aria-label', 'Show item ' + (i + 1));
      dot.addEventListener('click', function () {
        go(i);
      });
      dotsEl.appendChild(dot);
      dots.push(dot);
    });

    render();
    restartTimer();
  }

  // A caller that already has a real item list (the anime page's own
  // matched catalog collection, screens/library.js) passes it directly
  // as options.items rather than this component fetching a second,
  // generic random set on top of it.
  const fetchCandidates =
    options && options.items ? Promise.resolve(options.items) : getHeroCandidates(CANDIDATE_LIMIT, options);

  const ready = fetchCandidates
    .then(function (result) {
      if (!result || result.length < MIN_SLIDES) return false;
      items = result;
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
      if (timer) window.clearInterval(timer);
    },
  };
}
