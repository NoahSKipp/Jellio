// "More like this" row on the player end screen: poster cards, arrow key
// movement and a delayed backdrop preview of the focused title.

import { el } from '../runtime/dom.js';
import { getImageUrl } from '../runtime/api.js';
import { t } from '../runtime/i18n.js';
import { transitionsAllowed } from '../runtime/motionSettings.js';
import { cssUrl } from '../runtime/safeUrl.js';
import { createFocusPreview, nextFocusIndex } from '../runtime/endScreenRecs.js';

export const RECS_CLASS = 'jellio-player-endscreen-recs';

function backdropUrl(item) {
  const tag = item.BackdropImageTags && item.BackdropImageTags[0];
  return tag ? getImageUrl(item.Id, 'Backdrop', { tag: tag, maxWidth: 1280, quality: 80 }) : null;
}

function logoUrl(item) {
  const tag = item.ImageTags && item.ImageTags.Logo;
  return tag ? getImageUrl(item.Id, 'Logo', { tag: tag, maxWidth: 400, quality: 100 }) : null;
}

// previewHost receives the crossfading backdrop layers.
export function buildRecsRow(items, previewHost, onOpen) {
  const section = el('section', RECS_CLASS);
  section.setAttribute('aria-label', t('player_more_like_this'));
  section.appendChild(el('h3', RECS_CLASS + '-title', t('player_more_like_this')));

  const caption = el('div', RECS_CLASS + '-caption');
  caption.setAttribute('aria-live', 'polite');
  section.appendChild(caption);

  const track = el('div', RECS_CLASS + '-track');
  section.appendChild(track);

  const cards = items.map(function (item) {
    const card = el('button', RECS_CLASS + '-card');
    card.type = 'button';
    card.setAttribute('aria-label', item.Name || '');
    // Titles outside the library carry a TMDB poster URL instead of a tag.
    const tag = (item.ImageTags && item.ImageTags.Primary) || (item.ProviderIds && item.ProviderIds.TmdbPoster);
    if (tag) {
      const img = el('img', RECS_CLASS + '-img');
      img.alt = '';
      img.loading = 'lazy';
      img.src = getImageUrl(item.Id, 'Primary', { tag: tag, maxWidth: 320, quality: 85 });
      card.appendChild(img);
    } else {
      card.appendChild(el('span', RECS_CLASS + '-fallback', item.Name || ''));
    }
    card.addEventListener('click', function () {
      onOpen(item);
    });
    track.appendChild(card);
    return card;
  });

  let layer = null;
  function showPreview(item) {
    const url = backdropUrl(item);
    if (!url) return;
    const next = el('div', RECS_CLASS + '-preview');
    next.style.backgroundImage = cssUrl(url);
    previewHost.appendChild(next);
    const previous = layer;
    layer = next;
    const fade = transitionsAllowed();
    if (fade) {
      void next.offsetWidth;
      next.classList.add(RECS_CLASS + '-preview-on');
    } else {
      next.classList.add(RECS_CLASS + '-preview-on', RECS_CLASS + '-preview-instant');
    }
    if (previous) {
      window.setTimeout(function () {
        previous.remove();
      }, fade ? 700 : 0);
    }
    caption.textContent = '';
    const logo = logoUrl(item);
    if (logo) {
      const img = el('img', RECS_CLASS + '-logo');
      img.alt = item.Name || '';
      img.src = logo;
      caption.appendChild(img);
    } else {
      caption.appendChild(el('strong', RECS_CLASS + '-name', item.Name || ''));
    }
    if (item.Overview) caption.appendChild(el('span', RECS_CLASS + '-overview', item.Overview));
  }

  const preview = createFocusPreview(function (index) {
    showPreview(items[index]);
  });

  cards.forEach(function (card, index) {
    card.addEventListener('focus', function () {
      preview.focus(index);
      card.scrollIntoView({ block: 'nearest', inline: 'center', behavior: transitionsAllowed() ? 'smooth' : 'auto' });
    });
    card.addEventListener('blur', function () {
      preview.cancel();
    });
  });

  track.addEventListener('keydown', function (event) {
    const current = cards.indexOf(document.activeElement);
    let delta = 0;
    if (event.key === 'ArrowRight') delta = 1;
    else if (event.key === 'ArrowLeft') delta = -1;
    else if (event.key === 'Home') delta = -cards.length;
    else if (event.key === 'End') delta = cards.length;
    if (!delta) return;
    event.preventDefault();
    const target = cards[nextFocusIndex(current, delta, cards.length)];
    if (target) target.focus();
  });

  return {
    section: section,
    cards: cards,
    focusFirst: function () {
      if (cards[0]) cards[0].focus();
    },
    cleanup: function () {
      preview.cancel();
    },
  };
}
