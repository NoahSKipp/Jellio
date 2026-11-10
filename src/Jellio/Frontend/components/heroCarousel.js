import { translateGenre } from '../runtime/i18n.js';
import { t } from '../runtime/i18n.js';
import { getHeroCandidates, getImageUrl } from '../runtime/api.js';
import { navigateTo } from '../runtime/router.js';
import { formatRuntime } from '../runtime/format.js';
import { toggleWatchlist } from './cardOptionsMenu.js';
import { el } from '../runtime/dom.js';
import { transitionsAllowed } from '../runtime/motionSettings.js';

const ROTATE_MS = 9000;
const CANDIDATE_LIMIT = 8;

// Read by Services/IndexHtmlPatchService.cs's early script.
const HERO_PRELOAD_KEY = 'jellio.heroPreload';

export function getHeroBackdropUrl(item) {
  if (!item || !item.Id) return '';
  const backdropTag = item.BackdropImageTags && item.BackdropImageTags[0];
  if (backdropTag) {
    return getImageUrl(item.Id, 'Backdrop', { tag: backdropTag, maxWidth: 1920 });
  }
  if (item.ParentBackdropItemId && item.ParentBackdropImageTags && item.ParentBackdropImageTags[0]) {
    return getImageUrl(item.ParentBackdropItemId, 'Backdrop', {
      tag: item.ParentBackdropImageTags[0],
      maxWidth: 1920,
    });
  }
  if (item.ParentBackdropItemId) {
    return getImageUrl(item.ParentBackdropItemId, 'Backdrop', { maxWidth: 1920 });
  }
  if (item.ImageTags && item.ImageTags.Primary) {
    return getImageUrl(item.Id, 'Primary', { tag: item.ImageTags.Primary, maxWidth: 1920 });
  }
  return getImageUrl(item.Id, 'Backdrop', { maxWidth: 1920 });
}

export function getHeroLogoUrl(item) {
  if (!item || !item.Id) return null;
  const logoTag = item.ImageTags && item.ImageTags.Logo;
  if (logoTag) {
    return getImageUrl(item.Id, 'Logo', { tag: logoTag, maxWidth: 800 });
  }
  if (item.ParentLogoItemId && item.ParentLogoImageTag) {
    return getImageUrl(item.ParentLogoItemId, 'Logo', { tag: item.ParentLogoImageTag, maxWidth: 800 });
  }
  return null;
}

function metaLine(item) {
  if (!item) return '';
  const parts = [];
  if (item.ProductionYear) parts.push(String(item.ProductionYear));
  const runtime = formatRuntime(item.RunTimeTicks);
  if (runtime) parts.push(runtime);
  if (item.OfficialRating) parts.push(item.OfficialRating);
  if (item.Genres) {
    const list = Array.isArray(item.Genres)
      ? item.Genres
      : typeof item.Genres === 'string'
      ? item.Genres.split(',').map(function (s) { return s.trim(); }).filter(Boolean)
      : [];
    if (list.length) {
      parts.push(
        list.slice(0, 3).map(function (genre) {
          try {
            return translateGenre(genre);
          } catch (_) {
            return genre;
          }
        }).join(', ')
      );
    }
  }
  return parts.join(' • ');
}

function crossfadeBackdrop(container, url, isCurrent) {
  if (!url) return;
  const img = new Image();
  img.onload = function () {
    if (isCurrent && !isCurrent()) return;
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
  };
  img.src = url;
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

  const playButton = el('button', 'jellio-hero-action jellio-hero-action-play');
  playButton.type = 'button';
  const playIcon = el('span', 'material-icons play_arrow');
  playIcon.setAttribute('aria-hidden', 'true');
  playButton.appendChild(playIcon);
  playButton.appendChild(el('span', null, t('action_play')));
  actions.appendChild(playButton);

  const watchlistButton = el('button', 'jellio-hero-action jellio-hero-action-watchlist');
  watchlistButton.type = 'button';
  const watchIcon = el('span', 'material-icons bookmark_add');
  watchIcon.setAttribute('aria-hidden', 'true');
  watchlistButton.appendChild(watchIcon);
  const watchLabel = el('span', null, t('nav_watchlist'));
  watchlistButton.appendChild(watchLabel);
  actions.appendChild(watchlistButton);

  const infoButton = el('button', 'jellio-hero-action jellio-hero-action-info');
  infoButton.type = 'button';
  const infoIcon = el('span', 'material-icons info_outline');
  infoIcon.setAttribute('aria-hidden', 'true');
  infoButton.appendChild(infoIcon);
  infoButton.appendChild(el('span', null, t('home_action_details')));
  actions.appendChild(infoButton);

  content.appendChild(logo);
  content.appendChild(title);
  content.appendChild(meta);
  content.appendChild(overview);
  content.appendChild(actions);

  const dots = el('div', 'jellio-hero-dots');

  const prevButton = el('button', 'jellio-hero-nav jellio-hero-nav-prev');
  prevButton.type = 'button';
  prevButton.setAttribute('aria-label', t('hero_previous'));
  const prevIcon = el('span', 'material-icons chevron_left');
  prevIcon.setAttribute('aria-hidden', 'true');
  prevButton.appendChild(prevIcon);

  const nextButton = el('button', 'jellio-hero-nav jellio-hero-nav-next');
  nextButton.type = 'button';
  nextButton.setAttribute('aria-label', t('hero_next'));
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
  let activeSlideId = null;

  let shownOnce = false;
  function render() {
    if (!items.length) return;
    const item = items[index];
    if (!item) return;

    activeSlideId = item.Id;
    if (!shownOnce || hovered) focusCurrent();
    root.classList.remove('jellio-hero-loading');

    // Synchronously update text so stale descriptions or metadata from
    // a prior slide are immediately replaced and never linger.
    title.textContent = item.Name || '';
    meta.textContent = metaLine(item);
    overview.textContent = item.Overview || '';

    // Clear and hide logo immediately; only display if the current item
    // has a valid logo that loads successfully.
    logo.src = '';
    logo.classList.add('jellio-hero-logo-hidden');

    const logoUrl = getHeroLogoUrl(item);
    if (logoUrl) {
      const currentId = item.Id;
      logo.onload = function () {
        if (activeSlideId === currentId) {
          logo.classList.remove('jellio-hero-logo-hidden');
        }
      };
      logo.onerror = function () {
        if (activeSlideId === currentId) {
          logo.classList.add('jellio-hero-logo-hidden');
          logo.src = '';
        }
      };
      logo.src = logoUrl;
    }

    const backdropUrl = getHeroBackdropUrl(item);
    // The first backdrop on this page, for the next load: index.html's
    // early script starts downloading it before any of Jellio's code runs.
    if (backdropUrl && !shownOnce) {
      try {
        localStorage.setItem(HERO_PRELOAD_KEY, JSON.stringify({ route: location.hash || '', url: backdropUrl }));
      } catch (err) {}
    }
    if (backdropUrl) {
      const currentId = item.Id;
      crossfadeBackdrop(backdrop, backdropUrl, function () {
        return activeSlideId === currentId;
      });
    }

    if (shownOnce && transitionsAllowed() && typeof content.animate === 'function') {
      content.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, easing: 'ease-out' });
    }
    shownOnce = true;

    function syncWatchlistUI() {
      const isWatchlisted = Boolean(item.UserData && item.UserData.IsFavorite);
      watchIcon.className = 'material-icons ' + (isWatchlisted ? 'bookmark_added' : 'bookmark_add');
      watchLabel.textContent = isWatchlisted ? 'Saved' : 'Watchlist';
      watchlistButton.classList.toggle('jellio-hero-action-active', isWatchlisted);
    }
    syncWatchlistUI();

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

  playButton.addEventListener('click', function () {
    if (!items.length) return;
    navigateTo('#/item?id=' + items[index].Id);
  });
  let watchlistPending = false;
  watchlistButton.addEventListener('click', function () {
    if (!items.length || watchlistPending) return;
    const current = items[index];
    watchlistPending = true;
    const req = toggleWatchlist(current);
    render();
    watchlistButton.classList.remove('jellio-card-action-pop');
    requestAnimationFrame(function () {
      watchlistButton.classList.add('jellio-card-action-pop');
    });
    req
      .then(function () {
        render();
      })
      .catch(function () {
        render();
      })
      .finally(function () {
        watchlistPending = false;
      });
  });
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
  // The slide shown first, and whichever one the viewer points at.
  function focusCurrent() {
    const item = items[index];
    if (item && options && typeof options.onFocusItem === 'function') options.onFocusItem(item);
  }
  root.addEventListener('mouseenter', function () {
    hovered = true;
    focusCurrent();
  });
  root.addEventListener('mouseleave', function () {
    hovered = false;
  });
  root.addEventListener('focusin', function () {
    hovered = true;
    focusCurrent();
  });
  root.addEventListener('focusout', function () {
    hovered = false;
  });

  let touchStartX = 0;
  root.addEventListener('touchstart', function (e) {
    if (e.touches && e.touches[0]) touchStartX = e.touches[0].clientX;
  }, { passive: true });
  root.addEventListener('touchend', function (e) {
    if (!items.length) return;
    if (e.changedTouches && e.changedTouches[0]) {
      const diffX = e.changedTouches[0].clientX - touchStartX;
      if (Math.abs(diffX) > 48) {
        if (diffX < 0) {
          index = (index + 1) % items.length;
        } else {
          index = (index - 1 + items.length) % items.length;
        }
        render();
      }
    }
  }, { passive: true });

  // Rotation stops while the tab is hidden and picks up again when it is back.
  let rotating = false;
  let destroyed = false;
  function startRotation() {
    if (timer) window.clearInterval(timer);
    timer = null;
    if (!rotating || document.hidden) return;
    timer = window.setInterval(function () {
      if (hovered || !items.length) return;
      index = (index + 1) % items.length;
      render();
    }, ROTATE_MS);
  }
  document.addEventListener('visibilitychange', startRotation);

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

      if (destroyed) return;
      rotating = true;
      startRotation();
    })
    .catch(function (err) {
      console.warn('Jellio: hero carousel could not load candidates', err);
      root.classList.remove('jellio-hero-loading');
    });

  return {
    element: root,
    destroy: function () {
      rotating = false;
      destroyed = true;
      document.removeEventListener('visibilitychange', startRotation);
      if (timer) window.clearInterval(timer);
    },
  };
}
