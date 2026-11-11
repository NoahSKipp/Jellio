import { t } from '../runtime/i18n.js';
import { getImageUrl, getUserImageUrl, TICKS_PER_SECOND, seedItemCache } from '../runtime/api.js';
import { landscapeImageWidth, posterImageWidth } from '../runtime/imageSize.js';
import { warmItem } from '../runtime/warmQueue.js';
import { getBookCoverUrl, getStreamCoverUrl, getMangaSeriesCoverUrl } from '../runtime/apiBooks.js';
import { isMangaChapter } from '../runtime/mangaChapters.js';
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
import { buildRatingBadge } from './ratingBadge.js';
import { el } from '../runtime/dom.js';
import { episodeReleaseLabel } from '../runtime/releaseDate.js';

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

function buildPersonAvatar(person) {
  if (person.PrimaryImageTag) {
    const img = document.createElement('img');
    img.className = 'jellio-card-watcher-avatar';
    img.src = getUserImageUrl(person.UserId, person.PrimaryImageTag, { maxWidth: 64 });
    img.alt = person.UserName || '';
    img.loading = 'lazy';
    return img;
  }
  const initial = document.createElement('span');
  initial.className = 'jellio-card-watcher-avatar jellio-card-watcher-initial';
  initial.textContent = (person.UserName || 'U').charAt(0).toUpperCase();
  return initial;
}

// Friends who put a title on the Watchlist (item.AddedBy, set by the
// Watchlist screen); a bookmark corner tells it from the watchers badge.
function buildAddedByBadge(entries) {
  const wrap = document.createElement('div');
  wrap.className = 'jellio-card-addedby';
  const names = entries.map((e) => e.UserName || '').filter(Boolean).join(', ');
  wrap.title = t('friends_added_by', { names });
  wrap.setAttribute('role', 'img');
  wrap.setAttribute('aria-label', t('friends_added_by', { names }));
  entries.slice(0, 3).forEach((e) => wrap.appendChild(buildPersonAvatar(e)));
  return wrap;
}

function buildWatchersBadge(watchers) {
  if (!watchers || !watchers.length) return null;
  const wrap = document.createElement('div');
  wrap.className = 'jellio-card-watchers';
  const names = watchers
    .map(function (w) {
      return w.UserName || 'User';
    })
    .join(', ');
  wrap.title = t('card_watching', { names });
  wrap.setAttribute('aria-label', t('card_watched_by', { names }));

  watchers.slice(0, 3).forEach(function (watcher) {
    wrap.appendChild(buildPersonAvatar(watcher));
  });

  if (watchers.length > 3) {
    const extra = document.createElement('span');
    extra.className = 'jellio-card-watcher-avatar jellio-card-watcher-extra';
    extra.textContent = '+' + (watchers.length - 3);
    wrap.appendChild(extra);
  }

  return wrap;
}

// Long enough that sweeping across a row doesn't warm every card on it.
const PREFETCH_DEBOUNCE_MS = 900;

function attachStreamPrefetch(card, item) {
  if (item.Type !== 'Movie' && item.Type !== 'Episode' && item.Type !== 'Series') return;
  if (!item.Id) return;
  let timer = null;
  function scheduleFire() {
    seedItemCache(item);
    if (timer) return;
    timer = window.setTimeout(function () {
      timer = null;
      warmItem(item.Id, true);
    }, PREFETCH_DEBOUNCE_MS);
  }
  function cancelFire() {
    if (!timer) return;
    window.clearTimeout(timer);
    timer = null;
  }
  card.addEventListener('mouseenter', scheduleFire);
  card.addEventListener('mouseleave', cancelFire);
  card.addEventListener('focus', scheduleFire);
  card.addEventListener('blur', cancelFire);
}

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
  let watchlistPending = false;
  watchlistButton.addEventListener('click', function (event) {
    event.stopPropagation();
    if (isGrouplistEnabled()) {
      openListMembershipMenu(item, watchlistButton.getBoundingClientRect(), function (changed) {
        paintWatchlist();
        if (onChanged) onChanged(changed);
      });
      return;
    }
    if (watchlistPending) return;
    watchlistPending = true;
    const req = toggleWatchlist(item, onChanged);
    paintWatchlist();
    popConfirm(watchlistButton);
    req
      .then(function () {
        paintWatchlist();
      })
      .catch(function (err) {
        paintWatchlist();
        console.warn('Jellio: could not update watchlist state', err);
        showToast(t('toast_watchlist_error'));
      })
      .finally(function () {
        watchlistPending = false;
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
  let watchedPending = false;
  watchedButton.addEventListener('click', function (event) {
    event.stopPropagation();
    if (watchedPending) return;
    watchedPending = true;
    const req = toggleWatched(
      item,
      Object.assign({}, opts, {
        onRemoved: function () {
          animateCardRemoval(card);
        },
      }),
      onChanged,
    );
    paintWatched();
    paintCardState(imageWrap, item);
    popConfirm(watchedButton);
    req
      .then(function () {
        paintWatched();
        paintCardState(imageWrap, item);
      })
      .catch(function (err) {
        paintWatched();
        paintCardState(imageWrap, item);
        console.warn('Jellio: could not update watched state', err);
        showToast(t('toast_watched_error'));
      })
      .finally(function () {
        watchedPending = false;
      });
  });

  bar.appendChild(watchlistButton);
  bar.appendChild(watchedButton);
  bar.paintWatchlist = function (updated) {
    if (updated) item = updated;
    paintWatchlist();
  };
  bar.paintWatched = function (updated) {
    if (updated) item = updated;
    paintWatched();
  };
  return bar;
}

function landscapeImageCandidates(item) {
  if (!item || !item.Id) return [];
  const urls = [];
  const width = landscapeImageWidth();
  // An item that came with its image tags says which images exist; asking
  // for one it doesn't have is a certain 404 before the art that does.
  const knowsImages = hasImageInfo(item);
  const backdropTag = item.BackdropImageTags && item.BackdropImageTags[0];
  if (backdropTag) {
    urls.push(getImageUrl(item.Id, 'Backdrop', { tag: backdropTag, maxWidth: width, quality: 85 }));
  } else if (!knowsImages) {
    urls.push(getImageUrl(item.Id, 'Backdrop', { maxWidth: width, quality: 85 }));
  }

  const primaryTag = (item.ImageTags && (item.ImageTags.Primary || item.ImageTags.primary || item.ImageTags['0'] || item.ImageTags[0]))
    || item.PrimaryImageTag
    || (item.ProviderIds && (item.ProviderIds.TmdbPoster || item.ProviderIds.PosterUrl));
  if (primaryTag) {
    urls.push(getImageUrl(item.Id, 'Primary', { tag: primaryTag, maxWidth: width, quality: 85 }));
  } else if (!knowsImages) {
    urls.push(getImageUrl(item.Id, 'Primary', { maxWidth: width, quality: 85 }));
  }

  if (item.ParentThumbItemId) {
    if (item.ParentThumbImageTag) {
      urls.push(getImageUrl(item.ParentThumbItemId, 'Thumb', { tag: item.ParentThumbImageTag, maxWidth: width, quality: 85 }));
    } else if (!knowsImages) {
      urls.push(getImageUrl(item.ParentThumbItemId, 'Thumb', { maxWidth: width, quality: 85 }));
    }
  }
  if (item.ParentBackdropItemId) {
    if (item.ParentBackdropImageTags && item.ParentBackdropImageTags[0]) {
      urls.push(getImageUrl(item.ParentBackdropItemId, 'Backdrop', {
        tag: item.ParentBackdropImageTags[0],
        maxWidth: width,
        quality: 85,
      }));
    } else if (!knowsImages) {
      urls.push(getImageUrl(item.ParentBackdropItemId, 'Backdrop', { maxWidth: width, quality: 85 }));
    }
  }
  if (item.SeriesId) {
    if (!knowsImages) urls.push(getImageUrl(item.SeriesId, 'Backdrop', { maxWidth: width, quality: 85 }));
    if (item.SeriesPrimaryImageTag) {
      urls.push(getImageUrl(item.SeriesId, 'Primary', { tag: item.SeriesPrimaryImageTag, maxWidth: width, quality: 85 }));
    } else if (!knowsImages) {
      urls.push(getImageUrl(item.SeriesId, 'Primary', { maxWidth: width, quality: 85 }));
    }
  }
  return Array.from(new Set(urls.filter(Boolean)));
}

// Jellyfin always sends ImageTags (possibly empty) and BackdropImageTags
// with an item's image info; without either, nothing is known.
function hasImageInfo(item) {
  return !!(item && (item.ImageTags || item.BackdropImageTags));
}

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
  const candidateUrls = landscapeImageCandidates(item);
  let candidateIndex = 0;
  function appendLandscapePlaceholder() {
    const placeholder = el('div', 'jellio-card-landscape-image jellio-card-image-empty');
    imageWrap.insertBefore(placeholder, imageWrap.firstChild);
  }
  if (candidateUrls.length > 0) {
    const img = document.createElement('img');
    img.className = 'jellio-card-landscape-image';
    img.src = candidateUrls[0];
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('error', function () {
      candidateIndex += 1;
      if (candidateIndex < candidateUrls.length) {
        img.src = candidateUrls[candidateIndex];
      } else {
        img.remove();
        appendLandscapePlaceholder();
      }
    });
    imageWrap.appendChild(img);
  } else {
    appendLandscapePlaceholder();
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
  if (item.Watchers && item.Watchers.length > 0) {
    const watchersBadge = buildWatchersBadge(item.Watchers);
    if (watchersBadge) imageWrap.appendChild(watchersBadge);
  }

  let isUnreleased = false;
  if (item && item.Type === 'Episode') {
    const releaseLabel = episodeReleaseLabel(item);
    if (releaseLabel) {
      isUnreleased = true;
      imageWrap.appendChild(el('div', 'jellio-coming-soon-date', releaseLabel));
    }
  }

  card.appendChild(imageWrap);

  const landscapeItemId = item.Id || item.id;
  if (!item.Id && landscapeItemId) item.Id = landscapeItemId;
  card.addEventListener('click', function () {
    seedItemCache(item);
    navigateTo('#/item?id=' + encodeURIComponent(landscapeItemId));
  });
  card.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      seedItemCache(item);
      navigateTo('#/item?id=' + encodeURIComponent(landscapeItemId));
    }
  });

  attachCardOptionsTrigger(card, item, function (updatedItem) {
    paintLandscapeProgress(imageWrap, updatedItem);
  }, options);

  if (!isUnreleased) {
    attachStreamPrefetch(card, item);
  }

  return card;
}

function cardImageCandidates(item) {
  if (!item || !item.Id) return [];
  const urls = [];
  const width = posterImageWidth();
  // Books keep their untagged guesses (covers live outside image tags).
  const isBookLike = item.Type === 'AudioBook' || item.Type === 'Book';
  const knowsImages = !isBookLike && hasImageInfo(item);
  const ownPrimaryTag = (item.ImageTags && (item.ImageTags.Primary || item.ImageTags.primary || item.ImageTags['0'] || item.ImageTags[0]))
    || item.PrimaryImageTag
    || (item.ProviderIds && (item.ProviderIds.TmdbPoster || item.ProviderIds.PosterUrl));
  if (ownPrimaryTag) {
    urls.push(getImageUrl(item.Id, 'Primary', { tag: ownPrimaryTag, maxWidth: width, quality: 85 }));
  } else if (!knowsImages) {
    urls.push(getImageUrl(item.Id, 'Primary', { maxWidth: width, quality: 85 }));
  }

  if (item.Type === 'AudioBook') {
    if (item.AlbumId) {
      if (item.AlbumPrimaryImageTag) {
        urls.push(getImageUrl(item.AlbumId, 'Primary', { tag: item.AlbumPrimaryImageTag, maxWidth: width, quality: 85 }));
      }
      urls.push(getImageUrl(item.AlbumId, 'Primary', { maxWidth: width, quality: 85 }));
    }
    urls.push(getBookCoverUrl(item.Id));
    return Array.from(new Set(urls.filter(Boolean)));
  }

  if (item.Type === 'Book') {
    const isChapter = isMangaChapter(item);
    const mangaCovers = [];
    if (item.Stream && item.Stream.MangaId) {
      mangaCovers.push(getStreamCoverUrl(item.Stream.MangaId, item.SeriesName));
    } else if (item.MangaId) {
      mangaCovers.push(getStreamCoverUrl(item.MangaId, item.SeriesName));
    }
    if (item.SeriesId) {
      if (item.SeriesPrimaryImageTag) {
        mangaCovers.push(getImageUrl(item.SeriesId, 'Primary', { tag: item.SeriesPrimaryImageTag, maxWidth: width, quality: 85 }));
      }
      mangaCovers.push(getImageUrl(item.SeriesId, 'Primary', { maxWidth: width, quality: 85 }));
    }
    if (item.ParentId) {
      if (item.ParentPrimaryImageTag) {
        mangaCovers.push(getImageUrl(item.ParentId, 'Primary', { tag: item.ParentPrimaryImageTag, maxWidth: width, quality: 85 }));
      }
      mangaCovers.push(getImageUrl(item.ParentId, 'Primary', { maxWidth: width, quality: 85 }));
    }
    mangaCovers.push(getMangaSeriesCoverUrl(item.Id, item.SeriesName));

    const bookCover = getBookCoverUrl(item.Id);
    if (isChapter) {
      urls.push(...mangaCovers);
      if (bookCover) urls.push(bookCover);
    } else {
      if (bookCover) urls.push(bookCover);
      urls.push(...mangaCovers);
    }
    return Array.from(new Set(urls.filter(Boolean)));
  }

  if (item.SeriesId) {
    const seriesTag = item.SeriesPrimaryImageTag || (item.ImageTags && item.ImageTags.SeriesPrimary);
    if (seriesTag) {
      urls.push(getImageUrl(item.SeriesId, 'Primary', { tag: seriesTag, maxWidth: width, quality: 85 }));
    } else if (!knowsImages) {
      urls.push(getImageUrl(item.SeriesId, 'Primary', { maxWidth: width, quality: 85 }));
    }
  }

  if (item.ParentThumbItemId) {
    if (item.ParentThumbImageTag) {
      urls.push(getImageUrl(item.ParentThumbItemId, 'Thumb', { tag: item.ParentThumbImageTag, maxWidth: width, quality: 85 }));
    } else if (!knowsImages) {
      urls.push(getImageUrl(item.ParentThumbItemId, 'Thumb', { maxWidth: width, quality: 85 }));
    }
  }

  if (item.ParentId) {
    if (item.ParentPrimaryImageTag) {
      urls.push(getImageUrl(item.ParentId, 'Primary', { tag: item.ParentPrimaryImageTag, maxWidth: width, quality: 85 }));
    } else if (!knowsImages) {
      urls.push(getImageUrl(item.ParentId, 'Primary', { maxWidth: width, quality: 85 }));
    }
  }

  const thumbTag = (item.ImageTags && item.ImageTags.Thumb) || item.ThumbImageTag;
  if (thumbTag) {
    urls.push(getImageUrl(item.Id, 'Thumb', { tag: thumbTag, maxWidth: width, quality: 85 }));
  } else if (!knowsImages) {
    urls.push(getImageUrl(item.Id, 'Thumb', { maxWidth: width, quality: 85 }));
  }

  const backdropTag = item.BackdropImageTags && item.BackdropImageTags[0];
  if (backdropTag) {
    urls.push(getImageUrl(item.Id, 'Backdrop', { tag: backdropTag, maxWidth: width, quality: 85 }));
  } else if (!knowsImages) {
    urls.push(getImageUrl(item.Id, 'Backdrop', { maxWidth: width, quality: 85 }));
  }

  if (item.ParentBackdropItemId) {
    if (item.ParentBackdropImageTags && item.ParentBackdropImageTags[0]) {
      urls.push(getImageUrl(item.ParentBackdropItemId, 'Backdrop', { tag: item.ParentBackdropImageTags[0], maxWidth: width, quality: 85 }));
    } else if (!knowsImages) {
      urls.push(getImageUrl(item.ParentBackdropItemId, 'Backdrop', { maxWidth: width, quality: 85 }));
    }
  }

  return Array.from(new Set(urls.filter(Boolean)));
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

  function appendPlaceholder() {
    const placeholder = document.createElement('div');
    placeholder.className = 'jellio-card-image jellio-card-image-empty';
    imageWrap.insertBefore(placeholder, imageWrap.firstChild);
  }

  const candidateUrls = cardImageCandidates(item);
  let candidateIndex = 0;
  if (candidateUrls.length > 0) {
    const img = document.createElement('img');
    img.className = 'jellio-card-image';
    img.src = candidateUrls[0];
    img.alt = item.Name || '';
    img.loading = (options && options.priority) ? 'eager' : 'lazy';
    img.decoding = 'async';
    if (options && options.priority) img.fetchPriority = 'high';
    img.addEventListener('error', function () {
      candidateIndex += 1;
      if (candidateIndex < candidateUrls.length) {
        img.src = candidateUrls[candidateIndex];
      } else {
        img.remove();
        appendPlaceholder();
      }
    });
    imageWrap.appendChild(img);
  } else {
    appendPlaceholder();
  }

  // A book in progress says how much is left, the way Continue Watching
  // cards show minutes left.
  if (item.JellioPagesLeft) {
    imageWrap.appendChild(el('div', 'jellio-card-landscape-remaining', item.JellioPagesLeft + 'p left'));
  }

  if (item.CommunityRating) {
    imageWrap.appendChild(buildRatingBadge(item.CommunityRating, 'jellio-card-rating'));
  }

  paintCardState(imageWrap, item);
  if (item.AddedBy && item.AddedBy.length > 0) imageWrap.appendChild(buildAddedByBadge(item.AddedBy));
  if (item.Watchers && item.Watchers.length > 0) {
    const watchersBadge = buildWatchersBadge(item.Watchers);
    if (watchersBadge) imageWrap.appendChild(watchersBadge);
  }

  let isUnreleased = false;
  if (item && item.Type === 'Episode') {
    const releaseLabel = episodeReleaseLabel(item);
    if (releaseLabel) {
      isUnreleased = true;
      imageWrap.appendChild(el('div', 'jellio-coming-soon-date', releaseLabel));
    }
  }

  let cardActionsBar = null;
  function handleChanged(updatedItem) {
    paintCardState(imageWrap, updatedItem);
    if (cardActionsBar && typeof cardActionsBar.paintWatchlist === 'function') {
      cardActionsBar.paintWatchlist(updatedItem);
    }
    if (cardActionsBar && typeof cardActionsBar.paintWatched === 'function') {
      cardActionsBar.paintWatched(updatedItem);
    }
    if (options && typeof options.onChanged === 'function') {
      options.onChanged(updatedItem, card);
    }
  }
  // Books and manga have no watchlist or watched state.
  if (!(options && options.reading)) {
    cardActionsBar = buildCardActions(item, card, imageWrap, options, handleChanged);
    imageWrap.appendChild(cardActionsBar);
  }

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

  const itemId = item.Id || item.id;
  if (!item.Id && itemId) item.Id = itemId;
  const targetHash =
    options && options.openReader
      ? '#/' + (item.Type === 'AudioBook' ? 'listen' : 'read') + '?id=' + encodeURIComponent(itemId) + (item.Stream && item.Stream.MangaId ? '&manga=' + encodeURIComponent(item.Stream.MangaId) : '')
      : '#/item?id=' + encodeURIComponent(itemId);
  card.addEventListener('click', function () {
    seedItemCache(item);
    navigateTo(targetHash);
  });
  card.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      seedItemCache(item);
      navigateTo(targetHash);
    }
  });

  attachCardOptionsTrigger(
    card,
    item,
    handleChanged,
    options,
  );

  if (!isUnreleased) {
    attachStreamPrefetch(card, item);
  }

  return card;
}
