// Shared item card, used by every screen that renders a poster grid or row
// (home's own rows, the library grid). One definition so a later visual
// change (a hover state, a progress bar) only has one place to happen.
import { getImageUrl, TICKS_PER_SECOND } from '../runtime/api.js';
import { navigateTo } from '../runtime/router.js';
import {
  attachCardOptionsTrigger,
  toggleWatched,
  toggleWatchlist,
  animateCardRemoval,
} from './cardOptionsMenu.js';
import { isGrouplistEnabled } from '../runtime/grouplistSettings.js';
import { openListMembershipMenu } from './listMembershipMenu.js';
import { showToast } from './toast.js';
import { el } from '../runtime/dom.js';

// Rebuilds just the watched badge/progress bar over the poster image,
// its own function so the options menu's mark watched/unwatched action
// can refresh a card already on screen instead of needing a full row
// re-render for something this small.
function paintCardState(imageWrap, item) {
  const existingBadge = imageWrap.querySelector('.jellio-card-watched');
  if (existingBadge) existingBadge.remove();
  const existingProgress = imageWrap.querySelector('.jellio-card-progress');
  if (existingProgress) existingProgress.remove();

  const userData = item.UserData || {};
  if (userData.Played) {
    const badge = document.createElement('span');
    badge.className = 'jellio-card-watched material-icons check';
    badge.setAttribute('aria-hidden', 'true');
    imageWrap.appendChild(badge);
  } else if (userData.PlayedPercentage > 0) {
    const progress = document.createElement('div');
    progress.className = 'jellio-card-progress';
    const fill = document.createElement('div');
    fill.className = 'jellio-card-progress-fill';
    fill.style.width = Math.min(100, userData.PlayedPercentage) + '%';
    progress.appendChild(fill);
    imageWrap.appendChild(progress);
  }
}

// Up Next/Continue Watching hand this the same Episode item Jellyfin
// itself uses for the row: item.Name is only ever the episode's own
// title ("Chapter One"), the series it belongs to and where in it
// this episode sits are separate real fields on the same object
// (SeriesName, ParentIndexNumber, IndexNumber), already present on
// every real /Shows/NextUp and .../Items/Resume response without
// asking for extra Fields, real feedback was that a bare episode
// title with no series name gave no way to tell rows of unrelated
// shows apart at a glance.
function episodeSubtitle(item) {
  const hasSeason = typeof item.ParentIndexNumber === 'number';
  const hasEpisode = typeof item.IndexNumber === 'number';
  let code = '';
  if (hasSeason && hasEpisode) {
    code = 'S' + item.ParentIndexNumber + ' E' + item.IndexNumber;
  } else if (hasEpisode) {
    code = 'E' + item.IndexNumber;
  }
  if (code && item.Name) return code + ': ' + item.Name;
  return code || item.Name || '';
}

// Real feedback: Play showing up on every card in a grid/row was one
// tap too many, the card itself already navigates straight to
// screens/detail.js's own Play button (this file's own click handler
// below). Watchlist and Mark Watched fade in on hover/focus, the two
// real actions worth reaching without leaving the grid at all; a fixed
// More (three dot) button used to sit beside them, real feedback found
// it redundant with the exact same menu a right click or a held press
// already opens (attachCardOptionsTrigger below), one real way to reach
// it being enough.
// Real feedback: the watchlist/watched glyph swap alone was easy to
// miss at this size. Restarting the same keyframe (remove then
// re-add next frame, a plain re-add on an already-present class is a
// no-op) reads as a confirmation pop rather than a state change
// nobody actually saw happen.
function popConfirm(button) {
  button.classList.remove('jellio-card-action-pop');
  requestAnimationFrame(function () {
    button.classList.add('jellio-card-action-pop');
  });
}

function buildCardActions(item, card, imageWrap, options, onChanged) {
  const opts = options || {};
  const bar = el('div', 'jellio-card-actions');

  const watchlistButton = document.createElement('button');
  watchlistButton.type = 'button';
  watchlistButton.className = 'jellio-card-action jellio-card-action-watchlist';
  function paintWatchlist() {
    const isWatchlisted = !!(item.UserData && item.UserData.IsFavorite);
    watchlistButton.classList.toggle('jellio-card-action-active', isWatchlisted);
    watchlistButton.setAttribute('aria-label', isWatchlisted ? 'Remove from Watchlist' : 'Add to Watchlist');
    watchlistButton.textContent = '';
    watchlistButton.appendChild(el('span', 'material-icons ' + (isWatchlisted ? 'bookmark_added' : 'bookmark_add')));
  }
  paintWatchlist();
  watchlistButton.addEventListener('click', function (event) {
    event.stopPropagation();
    if (isGrouplistEnabled()) {
      openListMembershipMenu(item, watchlistButton.getBoundingClientRect(), function (changed) {
        paintWatchlist();
        if (onChanged) onChanged(changed);
      });
      return;
    }
    watchlistButton.disabled = true;
    toggleWatchlist(item, onChanged)
      .then(function () {
        paintWatchlist();
        popConfirm(watchlistButton);
      })
      .catch(function (err) {
        console.warn('Jellio: could not update watchlist state', err);
        showToast('Could not update your watchlist. Try again.');
      })
      .finally(function () {
        watchlistButton.disabled = false;
      });
  });

  const watchedButton = document.createElement('button');
  watchedButton.type = 'button';
  watchedButton.className = 'jellio-card-action jellio-card-action-watched';
  function paintWatched() {
    const isPlayed = !!(item.UserData && item.UserData.Played);
    watchedButton.classList.toggle('jellio-card-action-active', isPlayed);
    watchedButton.setAttribute('aria-label', isPlayed ? 'Mark as unwatched' : 'Mark as watched');
    watchedButton.textContent = '';
    watchedButton.appendChild(el('span', 'material-icons check'));
  }
  paintWatched();
  watchedButton.addEventListener('click', function (event) {
    event.stopPropagation();
    watchedButton.disabled = true;
    toggleWatched(
      item,
      Object.assign({}, opts, {
        onRemoved: function () {
          animateCardRemoval(card);
        },
      }),
      onChanged,
    )
      .then(function () {
        paintWatched();
        paintCardState(imageWrap, item);
        popConfirm(watchedButton);
      })
      .catch(function (err) {
        console.warn('Jellio: could not update watched state', err);
        showToast('Could not update watched state. Try again.');
      })
      .finally(function () {
        watchedButton.disabled = false;
      });
  });

  bar.appendChild(watchlistButton);
  bar.appendChild(watchedButton);
  return bar;
}

// Real Harbor/Nuvio reference (screenshots checked before writing
// this): Up Next and Continue Watching read as a landscape strip,
// title and episode burned directly onto the bottom of a 16:9 still
// with a remaining-time badge and a real progress bar under it, not
// this file's own plain 2:3 poster shape every other row already
// uses. Backdrop art fits that box far better than a poster
// (portrait key art cropped into a wide box loses most of it), so a
// real Backdrop tag wins here first when there is one; an Episode
// never carries one at all (confirmed against a real server before
// writing this, same real constraint screens/detail.js's own
// heroBackdropUrl() already documents), so its own real still
// (Primary) is next, then the season/series' own real Thumb, the
// same real ParentThumbItemId/ParentThumbImageTag fallback that
// file's own buildEpisodeCard() already fixed the same real id/type
// mismatch bug for.
function landscapeImageUrl(item) {
  const backdropTag = item.BackdropImageTags && item.BackdropImageTags[0];
  if (backdropTag) {
    return getImageUrl(item.Id, 'Backdrop', { tag: backdropTag, maxWidth: 500, quality: 85 });
  }
  const primaryTag = item.ImageTags && item.ImageTags.Primary;
  if (primaryTag) {
    return getImageUrl(item.Id, 'Primary', { tag: primaryTag, maxWidth: 500, quality: 85 });
  }
  if (item.ParentThumbItemId && item.ParentThumbImageTag) {
    return getImageUrl(item.ParentThumbItemId, 'Thumb', { tag: item.ParentThumbImageTag, maxWidth: 500, quality: 85 });
  }
  if (item.ParentBackdropItemId && item.ParentBackdropImageTags && item.ParentBackdropImageTags[0]) {
    return getImageUrl(item.ParentBackdropItemId, 'Backdrop', {
      tag: item.ParentBackdropImageTags[0],
      maxWidth: 500,
      quality: 85,
    });
  }
  return null;
}

// Real RunTimeTicks/PlaybackPositionTicks, both already real fields on
// a real Resume/NextUp response (runtime/api.js's own getResumeItems
// now asks for RunTimeTicks explicitly alongside the fields it already
// requested; getNextUp already did). Blank rather than "0m left" for
// an Up Next item, which never carries a real PlaybackPositionTicks at
// all, matching real Harbor/Nuvio reference: only a title actually mid
// playback shows a real remaining time at all.
function remainingLabel(item) {
  const userData = item.UserData || {};
  const runTicks = item.RunTimeTicks;
  const posTicks = userData.PlaybackPositionTicks;
  if (!runTicks || !posTicks) return '';
  const remainingTicks = runTicks - posTicks;
  if (remainingTicks <= 0) return '';
  const minutes = Math.round(remainingTicks / TICKS_PER_SECOND / 60);
  return minutes > 0 ? minutes + 'm left' : '';
}

function paintLandscapeProgress(imageWrap, item) {
  const existing = imageWrap.querySelector('.jellio-card-landscape-progress');
  if (existing) existing.remove();
  const percentage = item.UserData && item.UserData.PlayedPercentage;
  if (!(percentage > 0)) return;
  const progress = el('div', 'jellio-card-landscape-progress');
  const fill = el('div', 'jellio-card-landscape-progress-fill');
  fill.style.width = Math.min(100, percentage) + '%';
  progress.appendChild(fill);
  imageWrap.appendChild(progress);
}

function buildLandscapeCard(item, options) {
  const isEpisode = item.Type === 'Episode' && !!item.SeriesName;

  const card = document.createElement('div');
  card.className = 'jellio-card jellio-card-landscape';
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', isEpisode ? item.SeriesName + ' - ' + episodeSubtitle(item) : item.Name || '');

  const imageWrap = el('div', 'jellio-card-landscape-image-wrap');
  const imageUrl = landscapeImageUrl(item);
  if (imageUrl) {
    const img = document.createElement('img');
    img.className = 'jellio-card-landscape-image';
    img.src = imageUrl;
    img.alt = '';
    img.loading = 'lazy';
    imageWrap.appendChild(img);
  } else {
    imageWrap.appendChild(el('div', 'jellio-card-landscape-image jellio-card-image-empty'));
  }

  imageWrap.appendChild(el('div', 'jellio-card-landscape-scrim'));

  const info = el('div', 'jellio-card-landscape-info');
  if (isEpisode) {
    const hasSeason = typeof item.ParentIndexNumber === 'number';
    const hasEpisode = typeof item.IndexNumber === 'number';
    const code = hasSeason && hasEpisode ? 'S' + item.ParentIndexNumber + ' E' + item.IndexNumber : '';
    if (code) info.appendChild(el('div', 'jellio-card-landscape-eyebrow', code));
    info.appendChild(el('div', 'jellio-card-landscape-title', item.SeriesName));
    if (item.Name) info.appendChild(el('div', 'jellio-card-landscape-subtitle', item.Name));
  } else {
    info.appendChild(el('div', 'jellio-card-landscape-title', item.Name || ''));
  }
  imageWrap.appendChild(info);

  const remaining = remainingLabel(item);
  if (remaining) {
    imageWrap.appendChild(el('div', 'jellio-card-landscape-remaining', remaining));
  }

  paintLandscapeProgress(imageWrap, item);
  card.appendChild(imageWrap);

  card.addEventListener('click', function () {
    navigateTo('#/item?id=' + item.Id);
  });
  card.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      navigateTo('#/item?id=' + item.Id);
    }
  });

  attachCardOptionsTrigger(card, item, function (updatedItem) {
    paintLandscapeProgress(imageWrap, updatedItem);
  }, options);

  return card;
}

export function buildCard(item, options) {
  if (options && (options.continueWatching || options.upNext)) {
    return buildLandscapeCard(item, options);
  }

  const isEpisode = item.Type === 'Episode' && !!item.SeriesName;

  const card = document.createElement('div');
  card.className = 'jellio-card';
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', isEpisode ? item.SeriesName + ' - ' + episodeSubtitle(item) : item.Name || '');

  const imageWrap = document.createElement('div');
  imageWrap.className = 'jellio-card-image-wrap';

  const imageTag = item.ImageTags && item.ImageTags.Primary;
  if (imageTag) {
    const img = document.createElement('img');
    img.className = 'jellio-card-image';
    // quality: 85 alongside the existing maxWidth: every card grid can
    // hold a hundred-plus of these at once, and a poster shrunk to
    // this real display size loses nothing visible at a JPEG quality
    // a shade under the server's own real default, real bytes saved on
    // every single one of them for it.
    img.src = getImageUrl(item.Id, 'Primary', { tag: imageTag, maxWidth: 400, quality: 85 });
    img.alt = item.Name || '';
    img.loading = 'lazy';
    imageWrap.appendChild(img);
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'jellio-card-image jellio-card-image-empty';
    imageWrap.appendChild(placeholder);
  }

  paintCardState(imageWrap, item);

  function handleChanged(updatedItem) {
    paintCardState(imageWrap, updatedItem);
  }
  imageWrap.appendChild(buildCardActions(item, card, imageWrap, options, handleChanged));

  card.appendChild(imageWrap);

  const title = document.createElement('div');
  title.className = 'jellio-card-title';
  title.textContent = isEpisode ? item.SeriesName : item.Name || '';
  card.appendChild(title);

  if (isEpisode) {
    const subtitle = document.createElement('div');
    subtitle.className = 'jellio-card-subtitle';
    subtitle.textContent = episodeSubtitle(item);
    card.appendChild(subtitle);
  }

  // #/item rather than native's own #/details: screens/detail.js's own
  // Play button hands off to the real #/details route for actual
  // playback (playbackManager.play() is a plain ES module export, never
  // reachable from here, see that file's own header), so this runtime's
  // own detail screen has to live at a route native does not already
  // own, or the two would collide on the same hash.
  card.addEventListener('click', function () {
    navigateTo('#/item?id=' + item.Id);
  });
  card.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      navigateTo('#/item?id=' + item.Id);
    }
  });

  attachCardOptionsTrigger(
    card,
    item,
    handleChanged,
    options,
  );

  return card;
}
