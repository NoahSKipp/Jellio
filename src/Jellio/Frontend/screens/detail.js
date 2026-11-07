import { t, translateGenre } from '../runtime/i18n.js';
import { shareItem } from '../runtime/shareLink.js';
import { buildDownloadButton, buildEpisodesDownloadButton, canDownload, promptDownload } from '../components/downloads.js';
import { getItemDetails, getImageUrl, getItem, getSeasons, getEpisodes, setPlayed, getSeriesNextUp, getResumeItems, audiobookTitle, getCachedItemSync, seedItemCache, getMediaSources, getWarmSources } from '../runtime/api.js';
import { warmItem, warmSource } from '../runtime/warmQueue.js';
import { isBadSource } from '../runtime/streamHealth.js';
import { normalizeId } from '../runtime/readySources.js';
import { getBookMetadata, getBookCoverUrl, getMangaSeriesCoverUrl, getAudiobookTracks, getReadingProgress } from '../runtime/apiBooks.js';
import { watchSources } from '../runtime/itemInfo.js';
import { navigateTo, setTitle } from '../runtime/router.js';
import { openStreamPicker } from '../components/streamPicker.js';
import { getAvailableEditions, getPreferredEdition, setPreferredEdition } from '../runtime/editions.js';
import { renderLoading, renderRetry } from '../components/networkState.js';
import { describeNetworkFailure } from '../runtime/network.js';
import { toggleWatched, toggleWatchlist, toggleRating, findSkipTimestamps } from '../components/cardOptionsMenu.js';
import { attachScrollArrows } from '../components/scrollArrows.js';
import { buildRatingBadge } from '../components/ratingBadge.js';
import { isGrouplistEnabled } from '../runtime/grouplistSettings.js';
import { openListMembershipMenu, isInsideListMembershipMenu } from '../components/listMembershipMenu.js';
import { isAdminSync } from '../runtime/adminStatus.js';
import { isSkipIntroCreditsMenuEnabled } from '../runtime/introCreditsMenuSetting.js';
import { loadShelf, saveSeriesPrefs } from '../runtime/shelf.js';
import { openTrackerDialog } from '../components/trackerDialog.js';
import { showToast } from '../components/toast.js';
import { formatRuntime } from '../runtime/format.js';
import { el, fadeInBackdrop } from '../runtime/dom.js';
import {
  isUnreleasedItem,
  episodeReleaseLabel,
  filterReleasedItems,
  seasonEpisodeReleaseLabels,
  isReleasedToday,
  isTodayItemStreamVerified,
  markTodayItemHasStream,
} from '../runtime/releaseDate.js';

function renderDetailError(root, message, onRetry) {
  renderRetry(root, message, onRetry, { onBack: function () { navigateTo('#/home'); }, backLabel: 'Back to Home' });
}

function bookCoverUrl(item, id) {
  if (item.ImageTags && item.ImageTags.Primary) {
    return getImageUrl(id, 'Primary', { tag: item.ImageTags.Primary, maxWidth: 500 });
  }
  if (item.AlbumId && item.AlbumPrimaryImageTag) {
    return getImageUrl(item.AlbumId, 'Primary', { tag: item.AlbumPrimaryImageTag, maxWidth: 500 });
  }
  return null;
}

// Jellyfin's Bookshelf plugin files a book's authors as People of type
// Author; an audiobook's tags carry them as AlbumArtist/Artists.
function bookAuthors(item) {
  const people = (item.People || [])
    .filter(function (person) {
      return person.Type === 'Author';
    })
    .map(function (person) {
      return person.Name;
    });
  if (people.length) return people.join(', ');
  if (item.AlbumArtist) return item.AlbumArtist;
  return (item.Artists || []).join(', ');
}

// Chaptarr's overviews come from Goodreads/Hardcover and often carry
// markup; parsed inertly and shown as plain text.
function plainText(html) {
  return new DOMParser().parseFromString(html, 'text/html').body.textContent.trim();
}

// Waits a few seconds at most: a first-ever Chaptarr match can take a
// while, and the page is still useful without it.
function loadBookMetadata(id) {
  return Promise.race([
    getBookMetadata(id),
    new Promise(function (resolve) {
      window.setTimeout(resolve, 8000, null);
    }),
  ]);
}

// Jellyfin's own book fields win whenever they are filled in; Chaptarr's
// only fill the gaps.
function mergeBookMetadata(item, meta) {
  if (!meta) return;
  if (!item.Overview && meta.Overview) item.Overview = plainText(meta.Overview);
  if ((!item.Genres || !item.Genres.length) && meta.Genres && meta.Genres.length) item.Genres = meta.Genres;
  if (!item.ProductionYear && meta.Year) item.ProductionYear = meta.Year;
}

function bookFacts(meta) {
  if (!meta) return '';
  return [
    meta.SeriesTitle,
    meta.Publisher,
    meta.PageCount ? meta.PageCount + ' pages' : '',
    meta.Isbn ? 'ISBN ' + meta.Isbn : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function buildMediaTechBadges(item) {
  if (!item) return null;
  const streams = item.MediaStreams || (item.MediaSources && item.MediaSources[0] && item.MediaSources[0].MediaStreams) || [];
  if (!streams.length) return null;

  const videoStream = streams.find(function (s) { return s.Type === 'Video'; });
  const audioStream = streams.find(function (s) { return s.Type === 'Audio' && s.IsDefault; }) || streams.find(function (s) { return s.Type === 'Audio'; });

  const badges = [];

  if (videoStream) {
    const width = videoStream.Width || 0;
    const height = videoStream.Height || 0;
    if (width >= 3600 || height >= 2000) {
      badges.push({ text: '4K UHD', type: 'res' });
    } else if (width >= 1800 || height >= 900) {
      badges.push({ text: '1080p', type: 'res' });
    } else if (width >= 1200 || height >= 700) {
      badges.push({ text: '720p', type: 'res' });
    }

    const range = (videoStream.VideoRange || '').toUpperCase();
    const rangeType = (videoStream.VideoRangeType || '').toUpperCase();
    const dispTitle = (videoStream.DisplayTitle || '').toUpperCase();
    if (rangeType.includes('DOVI') || range.includes('DOVI') || dispTitle.includes('VISION')) {
      badges.push({ text: 'Dolby Vision', type: 'hdr' });
    } else if (rangeType.includes('HDR10+') || range.includes('HDR10+')) {
      badges.push({ text: 'HDR10+', type: 'hdr' });
    } else if (range.includes('HDR') || rangeType.includes('HDR')) {
      badges.push({ text: 'HDR10', type: 'hdr' });
    }

    const codec = (videoStream.Codec || '').toUpperCase();
    if (codec === 'HEVC' || codec === 'H265') {
      badges.push({ text: 'HEVC', type: 'codec' });
    } else if (codec === 'AV1') {
      badges.push({ text: 'AV1', type: 'codec' });
    }
  }

  if (audioStream) {
    const title = ((audioStream.Title || '') + ' ' + (audioStream.DisplayTitle || '') + ' ' + (audioStream.Profile || '')).toUpperCase();
    const audioCodec = (audioStream.Codec || '').toUpperCase();
    const channels = audioStream.Channels || 0;

    if (title.includes('ATMOS')) {
      badges.push({ text: 'Dolby Atmos', type: 'audio' });
    } else if (title.includes('DTS:X') || title.includes('DTS-X')) {
      badges.push({ text: 'DTS:X', type: 'audio' });
    } else if (title.includes('TRUEHD') || audioCodec === 'TRUEHD') {
      badges.push({ text: 'Dolby TrueHD', type: 'audio' });
    } else if (title.includes('DTS-HD') || audioCodec.includes('DTS')) {
      badges.push({ text: 'DTS-HD', type: 'audio' });
    } else if (channels >= 8) {
      badges.push({ text: '7.1', type: 'audio' });
    } else if (channels >= 6) {
      badges.push({ text: '5.1', type: 'audio' });
    } else if (channels === 2) {
      badges.push({ text: 'Stereo', type: 'audio' });
    }
  }

  if (!badges.length) return null;

  const wrap = el('div', 'jellio-detail-tech-badges');
  badges.forEach(function (b) {
    const badge = el('span', 'jellio-detail-tech-badge jellio-detail-tech-badge-' + b.type, b.text);
    wrap.appendChild(badge);
  });
  return wrap;
}

function heroBackdropUrl(item, id) {
  if (item.BackdropImageTags && item.BackdropImageTags[0]) {
    return getImageUrl(id, 'Backdrop', { tag: item.BackdropImageTags[0], maxWidth: 1920 });
  }
  if (item.ParentBackdropItemId && item.ParentBackdropImageTags && item.ParentBackdropImageTags[0]) {
    return getImageUrl(item.ParentBackdropItemId, 'Backdrop', {
      tag: item.ParentBackdropImageTags[0],
      maxWidth: 1920,
    });
  }
  if (item.Type === 'Episode' && item.ImageTags && item.ImageTags.Primary) {
    return getImageUrl(id, 'Primary', { tag: item.ImageTags.Primary, maxWidth: 1920 });
  }
  const thumbTag = (item.ImageTags && item.ImageTags.Thumb) || item.ThumbImageTag;
  if (thumbTag) {
    return getImageUrl(id, 'Thumb', { tag: thumbTag, maxWidth: 1920 });
  }
  if (item.ParentThumbItemId && item.ParentThumbImageTag) {
    return getImageUrl(item.ParentThumbItemId, 'Thumb', { tag: item.ParentThumbImageTag, maxWidth: 1920 });
  }
  return null;
}

function paintHeroArt(hero, item, id) {
  const candidates = [];
  (item.BackdropImageTags || []).forEach(function (tag, index) {
    candidates.push({ url: getImageUrl(id, index ? 'Backdrop/' + index : 'Backdrop', { tag: tag, maxWidth: 1920 }) });
  });
  const chained = heroBackdropUrl(item, id);
  if (chained) candidates.push({ url: chained });
  const posterTag = (item.ImageTags && item.ImageTags.Primary) || item.PrimaryImageTag;
  if (posterTag) candidates.push({ url: getImageUrl(id, 'Primary', { tag: posterTag, maxWidth: 600 }), blur: true });

  const seen = {};
  const queue = candidates.filter(function (c) {
    if (seen[c.url]) return false;
    seen[c.url] = true;
    return true;
  });
  (function tryNext() {
    const next = queue.shift();
    if (!next) return;
    const probe = new Image();
    probe.onload = function () {
      if (next.blur) {
        const blur = el('div', 'jellio-detail-hero-blur');
        blur.style.backgroundImage = 'url(' + next.url + ')';
        hero.insertBefore(blur, hero.firstChild);
      } else {
        fadeInBackdrop(hero, next.url);
      }
    };
    probe.onerror = tryNext;
    probe.src = next.url;
  })();
  return candidates.length && !candidates[0].blur ? candidates[0].url : null;
}

function extractYouTubeId(url) {
  const match = /(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([\w-]{11})/.exec(url || '');
  return match ? match[1] : null;
}

const TRAILER_MODAL_ID = 'jellioTrailerModal';

function closeTrailerModal() {
  const existing = document.getElementById(TRAILER_MODAL_ID);
  if (existing) existing.remove();
  document.removeEventListener('keydown', handleTrailerKeydown);
}

function handleTrailerKeydown(event) {
  if (event.key === 'Escape') closeTrailerModal();
}

function openTrailerModal(trailer, youTubeId) {
  closeTrailerModal();
  const overlay = el('div', 'jellio-trailer-modal');
  overlay.id = TRAILER_MODAL_ID;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', trailer.Name || 'Trailer');

  const backdrop = el('div', 'jellio-trailer-modal-backdrop');
  backdrop.addEventListener('click', closeTrailerModal);
  overlay.appendChild(backdrop);

  const card = el('div', 'jellio-trailer-modal-card');
  const header = el('div', 'jellio-trailer-modal-header');
  header.appendChild(el('h3', 'jellio-trailer-modal-title', trailer.Name || 'Trailer'));

  const actions = el('div', 'jellio-trailer-modal-actions');
  const externalLink = el('a', 'jellio-trailer-modal-ext-link');
  externalLink.href = trailer.Url;
  externalLink.target = '_blank';
  externalLink.rel = 'noopener noreferrer';
  externalLink.title = t('detail_watch_youtube');
  externalLink.appendChild(el('span', 'material-icons open_in_new'));
  actions.appendChild(externalLink);

  const closeButton = el('button', 'jellio-trailer-modal-close', '×');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', t('action_close_trailer'));
  closeButton.addEventListener('click', closeTrailerModal);
  actions.appendChild(closeButton);

  header.appendChild(actions);
  card.appendChild(header);

  const playerWrap = el('div', 'jellio-trailer-modal-player');
  const iframe = document.createElement('iframe');
  iframe.className = 'jellio-trailer-modal-iframe';
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  iframe.src =
    'https://www.youtube-nocookie.com/embed/' +
    youTubeId +
    '?autoplay=1&rel=0&origin=' +
    encodeURIComponent(window.location.origin);
  iframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share');
  iframe.setAttribute('allowfullscreen', 'true');
  playerWrap.appendChild(iframe);
  card.appendChild(playerWrap);

  overlay.appendChild(card);
  document.body.appendChild(overlay);
  document.addEventListener('keydown', handleTrailerKeydown);
}

function buildTrailersRow(trailers) {
  const trailerList = Array.isArray(trailers) ? trailers : [];
  const usable = trailerList.filter(function (trailer) {
    return trailer && trailer.Url;
  });
  if (!usable.length) return null;

  const section = el('section', 'jellio-detail-trailers');
  section.appendChild(el('h2', 'jellio-row-title', t('detail_trailers')));
  const trackWrap = el('div', 'jellio-row-track-wrap');
  const track = el('div', 'jellio-row-track');

  usable.forEach(function (trailer) {
    const card = el('a', 'jellio-trailer-card');
    card.href = trailer.Url;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';

    const thumb = el('div', 'jellio-trailer-thumb');
    const youTubeId = extractYouTubeId(trailer.Url);
    if (youTubeId) {
      const img = document.createElement('img');
      img.className = 'jellio-trailer-thumb-image';
      img.src = 'https://i.ytimg.com/vi/' + youTubeId + '/hqdefault.jpg';
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', function () {
        img.remove();
      });
      thumb.appendChild(img);

      card.addEventListener('click', function (e) {
        e.preventDefault();
        openTrailerModal(trailer, youTubeId);
      });
    }
    thumb.appendChild(el('span', 'material-icons jellio-trailer-play play_circle_filled'));
    card.appendChild(thumb);
    card.appendChild(el('div', 'jellio-trailer-title', trailer.Name || 'Trailer'));
    track.appendChild(card);
  });

  trackWrap.appendChild(track);
  section.appendChild(trackWrap);
  attachScrollArrows(trackWrap, track);
  return section;
}

const EPISODE_MENU_ID = 'jellioEpisodeOptionsMenu';
const EPISODE_HOLD_MS = 500;

function closeEpisodeMenu() {
  const existing = document.getElementById(EPISODE_MENU_ID);
  if (existing) existing.remove();
  document.removeEventListener('keydown', handleEpisodeMenuKeydown);
  document.removeEventListener('pointerdown', handleEpisodeMenuOutsideClick, true);
}

function handleEpisodeMenuKeydown(event) {
  if (event.key === 'Escape') closeEpisodeMenu();
}

function handleEpisodeMenuOutsideClick(event) {
  const menu = document.getElementById(EPISODE_MENU_ID);
  if (menu && !menu.contains(event.target)) closeEpisodeMenu();
}

function buildEpisodeMenuOption(label, iconName, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'jellio-card-options-item';
  button.appendChild(el('span', 'jellio-card-options-item-label', label));
  button.appendChild(el('span', 'material-icons jellio-card-options-item-icon ' + iconName));
  button.addEventListener('click', function () {
    closeEpisodeMenu();
    onClick();
  });
  return button;
}

function positionEpisodeMenu(menu, anchorRect) {
  const menuWidth = 240;
  let left = anchorRect.left;
  if (left + menuWidth > window.innerWidth - 16) {
    left = window.innerWidth - menuWidth - 16;
  }
  menu.style.left = Math.max(16, left) + 'px';
  menu.style.top = anchorRect.bottom + 6 + 'px';
}

function openEpisodeOptionsMenu(episode, anchorRect, context) {
  closeEpisodeMenu();

  const menu = document.createElement('div');
  menu.id = EPISODE_MENU_ID;
  menu.className = 'jellio-card-options-menu';
  menu.setAttribute('role', 'menu');
  positionEpisodeMenu(menu, anchorRect);

  const isPlayed = !!(episode.UserData && episode.UserData.Played);
  menu.appendChild(
    buildEpisodeMenuOption(isPlayed ? t('detail_mark_unwatched') : t('detail_mark_watched'), 'check', function () {
      setPlayed(episode.Id, !isPlayed)
        .then(function (updated) {
          episode.UserData = updated;
          context.onChanged();
        })
        .catch(function (err) {
          console.warn('Jellio: could not update watched state', err);
          showToast(t('toast_watched_error'));
        });
    }),
  );

  const previous = context.episodes.slice(0, context.index);
  if (previous.length) {
    menu.appendChild(
      buildEpisodeMenuOption('Mark previous as watched', 'playlist_add_check', function () {
        Promise.all(
          previous.map(function (prevEpisode) {
            return setPlayed(prevEpisode.Id, true).then(function (updated) {
              prevEpisode.UserData = updated;
            });
          }),
        )
          .then(context.onChanged)
          .catch(function (err) {
            console.warn('Jellio: could not mark previous episodes watched', err);
            showToast(t('toast_mark_previous_watched_error'));
          });
      }),
    );
  }

  menu.appendChild(
    buildEpisodeMenuOption('Mark season as watched', 'done_all', function () {
      Promise.all(
        context.episodes.map(function (seasonEpisode) {
          return setPlayed(seasonEpisode.Id, true).then(function (updated) {
            seasonEpisode.UserData = updated;
          });
        }),
      )
        .then(context.onChanged)
        .catch(function (err) {
          console.warn('Jellio: could not mark season watched', err);
          showToast(t('toast_mark_season_watched_error'));
        });
    }),
  );

  menu.appendChild(
    buildEpisodeMenuOption('Mark season as unwatched', 'remove_done', function () {
      Promise.all(
        context.episodes.map(function (seasonEpisode) {
          return setPlayed(seasonEpisode.Id, false).then(function (updated) {
            seasonEpisode.UserData = updated;
          });
        }),
      )
        .then(context.onChanged)
        .catch(function (err) {
          console.warn('Jellio: could not mark season unwatched', err);
          showToast(t('toast_mark_season_unwatched_error'));
        });
    }),
  );

  // Keep it on this device (components/downloads.js): this episode, or
  // its season (unwatched or whole), each asking for the quality.
  if (canDownload(episode)) {
    menu.appendChild(
      buildEpisodeMenuOption('Download episode', 'download', function () {
        promptDownload(episode, anchorRect);
      }),
    );
    if (episode.SeasonId && episode.SeriesId) {
      menu.appendChild(
        buildEpisodeMenuOption('Download season', 'download_for_offline', function () {
          promptDownload({ Id: episode.SeasonId, Type: 'Season', SeriesId: episode.SeriesId }, anchorRect);
        }),
      );
    }
  }

  if (isAdminSync() && isSkipIntroCreditsMenuEnabled()) {
    menu.appendChild(
      buildEpisodeMenuOption('Quick Skip Search (Episode)', 'bolt', function () {
        findSkipTimestamps(episode.Id, episode.Name, false);
      }),
    );
    menu.appendChild(
      buildEpisodeMenuOption('Deep Skip Search (Episode)', 'travel_explore', function () {
        findSkipTimestamps(episode.Id, episode.Name, true);
      }),
    );
    if (context.season) {
      menu.appendChild(
        buildEpisodeMenuOption('Quick Skip Search (Season)', 'bolt', function () {
          findSkipTimestamps(context.season.Id, context.season.Name, false);
        }),
      );
      menu.appendChild(
        buildEpisodeMenuOption('Deep Skip Search (Season)', 'travel_explore', function () {
          findSkipTimestamps(context.season.Id, context.season.Name, true);
        }),
      );
    }
  }

  document.body.appendChild(menu);
  document.addEventListener('keydown', handleEpisodeMenuKeydown);
  window.setTimeout(function () {
    document.addEventListener('pointerdown', handleEpisodeMenuOutsideClick, true);
  }, 0);

  const first = menu.querySelector('button');
  if (first) first.focus();
}

function attachEpisodeOptionsTrigger(card, episode, context) {
  function trigger() {
    openEpisodeOptionsMenu(episode, card.getBoundingClientRect(), context);
  }

  card.addEventListener('contextmenu', function (event) {
    event.preventDefault();
    trigger();
  });

  let holdTimer = null;
  function cancelHold() {
    if (holdTimer) {
      window.clearTimeout(holdTimer);
      holdTimer = null;
    }
  }
  card.addEventListener('pointerdown', function (event) {
    if (event.button !== 0) return;
    cancelHold();
    holdTimer = window.setTimeout(function () {
      holdTimer = null;
      trigger();
    }, EPISODE_HOLD_MS);
  });
  card.addEventListener('pointerup', cancelHold);
  card.addEventListener('pointerleave', cancelHold);
  card.addEventListener('pointercancel', cancelHold);
}

function paintEpisodeWatched(thumb, episode) {
  const existing = thumb.querySelector('.jellio-episode-watched');
  if (existing) existing.remove();
  if (episode.UserData && episode.UserData.Played) {
    const badge = el('span', 'jellio-episode-watched material-icons check');
    badge.setAttribute('aria-hidden', 'true');
    thumb.appendChild(badge);
  }
}

function buildEpisodeCard(episode, context) {
  const card = el('div', 'jellio-episode-card');
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', episode.Name || '');
  const thumb = el('div', 'jellio-episode-thumb');
  let thumbUrl = null;
  if (episode.ImageTags && episode.ImageTags.Primary) {
    thumbUrl = getImageUrl(episode.Id, 'Primary', { tag: episode.ImageTags.Primary, maxWidth: 500 });
  } else if (episode.ParentThumbItemId && episode.ParentThumbImageTag) {
    thumbUrl = getImageUrl(episode.ParentThumbItemId, 'Thumb', { tag: episode.ParentThumbImageTag, maxWidth: 500 });
  }
  if (thumbUrl) {
    thumb.style.backgroundImage = 'url(' + thumbUrl + ')';
  }
  if (episode.IndexNumber != null) {
    thumb.appendChild(el('span', 'jellio-episode-badge', 'E' + episode.IndexNumber));
  }
  paintEpisodeWatched(thumb, episode);

  const releaseLabel = (context && context.releaseLabels && context.releaseLabels[episode.Id]) || episodeReleaseLabel(episode);
  if (releaseLabel) {
    thumb.appendChild(el('span', 'jellio-coming-soon-date jellio-episode-release-date', releaseLabel));
  } else {
    const quickPlay = el('button', 'jellio-episode-quick-play');
    quickPlay.type = 'button';
    quickPlay.setAttribute('aria-label', t('detail_play_episode_aria', { number: episode.IndexNumber != null ? episode.IndexNumber : episode.Name || '' }));
    quickPlay.title = t('detail_play_episode');
    quickPlay.appendChild(el('span', 'material-icons play_arrow'));
    quickPlay.addEventListener('click', function (e) {
      e.stopPropagation();
      openStreamPicker(episode);
    });
    thumb.appendChild(quickPlay);
  }

  card.appendChild(thumb);
  card.appendChild(el('div', 'jellio-episode-title', episode.Name || ''));
  if (episode.Overview) {
    card.appendChild(el('div', 'jellio-episode-overview', episode.Overview));
  }
  card.addEventListener('click', function () {
    seedItemCache(episode);
    navigateTo('#/item?id=' + episode.Id);
  });
  card.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      seedItemCache(episode);
      navigateTo('#/item?id=' + episode.Id);
    }
  });
  if (context) attachEpisodeOptionsTrigger(card, episode, context);
  return card;
}

function isSpecialsSeason(season) {
  if (season.IndexNumber === 0) return true;
  return /special/i.test(season.Name || '');
}

async function verifyItemHasStreamIfToday(item) {
  if (!item) return null;
  const now = Date.now();
  if (isUnreleasedItem(item, now)) return null;
  if (!isReleasedToday(item, now)) return item;
  if (isTodayItemStreamVerified(item.Id)) return item;
  const dateStr = item.PremiereDate || item.EndDate;
  if (dateStr) {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime()) && d.getTime() > now) return null;
  }
  try {
    const sources = await getMediaSources(item.Id);
    const has = Array.isArray(sources) && sources.length > 0;
    markTodayItemHasStream(item.Id, has);
    return has ? item : null;
  } catch (_) {
    markTodayItemHasStream(item.Id, false);
    return null;
  }
}

async function resolveSeriesPlayTarget(seriesId) {
  let episode = null;
  try {
    const resumeItems = await getResumeItems(50);
    episode = (resumeItems || []).find(function (it) {
      return it.SeriesId === seriesId;
    });
  } catch (err) {
    // continue to next up
  }

  if (!episode) {
    try {
      episode = await getSeriesNextUp(seriesId);
    } catch (err) {
      console.warn('Jellio: could not load next up for series', err);
    }
  }

  if (episode) {
    episode = await verifyItemHasStreamIfToday(episode);
  }

  if (!episode) {
    try {
      const seasons = await getSeasons(seriesId);
      const orderedSeasons = seasons.slice().sort(function (a, b) {
        return (isSpecialsSeason(a) ? 1 : 0) - (isSpecialsSeason(b) ? 1 : 0);
      });
      const firstSeason = orderedSeasons[0];
      if (firstSeason) {
        const episodes = await getEpisodes(seriesId, firstSeason.Id);
        const released = filterReleasedItems(episodes);
        const pool = released.length ? released : episodes;
        for (let i = 0; i < pool.length; i++) {
          const verified = await verifyItemHasStreamIfToday(pool[i]);
          if (verified) {
            episode = verified;
            break;
          }
        }
      }
    } catch (err) {
      console.warn('Jellio: could not load first episode for series', err);
    }
  }

  if (!episode) return null;

  const isFirstEpisode = episode.ParentIndexNumber === 1 && episode.IndexNumber === 1;
  const hasProgress = !!(episode.UserData && episode.UserData.PlaybackPositionTicks > 0);
  const resume = hasProgress || !isFirstEpisode;
  return { episode: episode, resume: resume };
}

async function resolveSeasonPlayTarget(item) {
  let episodes = [];
  try {
    episodes = await getEpisodes(item.SeriesId, item.Id);
  } catch (err) {
    console.warn('Jellio: could not load episodes for season', err);
    return null;
  }

  if (!episodes.length) return null;

  const released = filterReleasedItems(episodes);
  const pool = released.length ? released : episodes;
  const unplayedCandidates = pool.filter(function (e) {
    return !(e.UserData && e.UserData.Played);
  });
  let episode = null;
  for (let i = 0; i < unplayedCandidates.length; i++) {
    const verified = await verifyItemHasStreamIfToday(unplayedCandidates[i]);
    if (verified) {
      episode = verified;
      break;
    }
  }
  if (!episode) {
    for (let i = pool.length - 1; i >= 0; i--) {
      const ep = pool[i];
      if (isReleasedToday(ep) && !isTodayItemStreamVerified(ep.Id)) {
        continue;
      }
      if (isUnreleasedItem(ep)) {
        continue;
      }
      episode = ep;
      break;
    }
  }

  if (!episode) return null;

  const isFirstEpisode = episode.Id === episodes[0].Id;
  const hasProgress = !!(episode.UserData && episode.UserData.PlaybackPositionTicks > 0);
  const resume = hasProgress || !isFirstEpisode;
  return { episode: episode, resume: resume };
}

async function buildSeasonsSection(seriesId, targetPromise, onSeasonSelected, initialSeasonId, initialSeasonNumber) {
  let seasons;
  try {
    seasons = await getSeasons(seriesId);
  } catch (err) {
    console.warn('Jellio: could not load seasons', err);
    return null;
  }
  if (!seasons || !seasons.length) return null;

  const orderedSeasons = seasons.slice().sort(function (a, b) {
    return (isSpecialsSeason(a) ? 1 : 0) - (isSpecialsSeason(b) ? 1 : 0);
  });

  const section = el('section', 'jellio-detail-seasons');
  section.appendChild(el('h2', 'jellio-row-title', t('detail_episodes')));

  const tabsWrap = el('div', 'jellio-season-tabs-wrap jellio-row-track-wrap');
  const tabs = el('div', 'jellio-season-tabs');
  tabs.setAttribute('role', 'tablist');
  tabsWrap.appendChild(tabs);

  const trackWrap = el('div', 'jellio-episode-track-wrap jellio-row-track-wrap');
  const track = el('div', 'jellio-episode-track');
  trackWrap.appendChild(track);

  section.appendChild(tabsWrap);
  section.appendChild(trackWrap);
  attachScrollArrows(tabsWrap, tabs);
  const refreshTrackArrows = attachScrollArrows(trackWrap, track);

  function renderTrack(season, episodes) {
    track.textContent = '';
    const releaseLabels = seasonEpisodeReleaseLabels(episodes);
    episodes.forEach(function (episode, index) {
      track.appendChild(
        buildEpisodeCard(episode, {
          episodes: episodes,
          index: index,
          season: season,
          releaseLabels: releaseLabels,
          onChanged: function () {
            renderTrack(season, episodes);
          },
        }),
      );
    });
    window.requestAnimationFrame(refreshTrackArrows);
  }

  let currentSelectionToken = 0;
  function selectSeason(season, tabButton) {
    const token = ++currentSelectionToken;
    selectedSeasonObj = season;
    selectedTab = tabButton;
    Array.prototype.forEach.call(tabs.children, function (child) {
      child.classList.remove('jellio-season-tab-selected');
      child.setAttribute('aria-selected', 'false');
    });
    tabButton.classList.add('jellio-season-tab-selected');
    tabButton.setAttribute('aria-selected', 'true');
    if (onSeasonSelected) onSeasonSelected(season);
    track.textContent = '';
    for (let i = 0; i < 4; i++) {
      const skel = el('div', 'jellio-card jellio-card-skeleton');
      skel.style.width = '18em';
      skel.style.aspectRatio = '16 / 9';
      skel.style.flex = '0 0 auto';
      track.appendChild(skel);
    }
    getEpisodes(seriesId, season.Id)
      .then(function (episodes) {
        if (token !== currentSelectionToken) return;
        renderTrack(season, episodes);

        const now = Date.now();
        const unverifiedToday = (episodes || []).filter(function (ep) {
          if (!ep || !ep.Id) return false;
          if (!isReleasedToday(ep, now) || isTodayItemStreamVerified(ep.Id)) return false;
          const dateStr = ep.PremiereDate || ep.EndDate;
          if (dateStr) {
            const d = new Date(dateStr);
            if (!isNaN(d.getTime()) && d.getTime() > now) return false;
          }
          return true;
        });

        if (unverifiedToday.length > 0) {
          Promise.all(
            unverifiedToday.map(function (ep) {
              return getMediaSources(ep.Id)
                .then(function (sources) {
                  const has = Array.isArray(sources) && sources.length > 0;
                  markTodayItemHasStream(ep.Id, has);
                  return has;
                })
                .catch(function () {
                  markTodayItemHasStream(ep.Id, false);
                  return false;
                });
            }),
          ).then(function (results) {
            if (token !== currentSelectionToken) return;
            const anyVerified = results.some(function (has) {
              return has;
            });
            if (anyVerified && tabButton.classList.contains('jellio-season-tab-selected')) {
              renderTrack(season, episodes);
            }
          });
        }
      })
      .catch(function (err) {
        if (token !== currentSelectionToken) return;
        console.warn('Jellio: could not load episodes', err);
        track.textContent = '';
      });
  }

  let selectedTab = null;
  let selectedSeasonObj = null;
  let userSelectedTab = false;

  orderedSeasons.forEach(function (season, index) {
    const tab = el('button', 'jellio-season-tab', season.Name || '');
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', 'false');
    tab.addEventListener('click', function () {
      userSelectedTab = true;
      selectSeason(season, tab);
    });
    tabs.appendChild(tab);

    const isMatch = initialSeasonId
      ? String(season.Id) === String(initialSeasonId)
      : typeof initialSeasonNumber === 'number'
      ? season.IndexNumber === initialSeasonNumber
      : index === 0;
    if (isMatch) {
      selectedTab = tab;
      selectedSeasonObj = season;
    }
  });

  if (!selectedSeasonObj && orderedSeasons.length) {
    selectedSeasonObj = orderedSeasons[0];
    selectedTab = tabs.children[0];
  }

  if (selectedSeasonObj && selectedTab) {
    selectSeason(selectedSeasonObj, selectedTab);
    if (selectedSeasonObj !== orderedSeasons[0]) {
      window.setTimeout(function () {
        try {
          selectedTab.scrollIntoView({ block: 'nearest', inline: 'center' });
        } catch (e) {}
      }, 50);
    }
  }

  if (targetPromise) {
    Promise.resolve(targetPromise)
      .then(function (target) {
        if (userSelectedTab || !target || !target.episode) return;
        let activeSeasonId = target.episode.SeasonId || null;
        if (!activeSeasonId && typeof target.episode.ParentIndexNumber === 'number') {
          const match = orderedSeasons.find(function (s) {
            return s.IndexNumber === target.episode.ParentIndexNumber;
          });
          if (match) activeSeasonId = match.Id;
        }
        if (!activeSeasonId) return;
        if (selectedSeasonObj && String(selectedSeasonObj.Id) === String(activeSeasonId)) return;
        const targetIndex = orderedSeasons.findIndex(function (s) {
          return String(s.Id) === String(activeSeasonId);
        });
        if (targetIndex !== -1 && tabs.children[targetIndex]) {
          const targetTab = tabs.children[targetIndex];
          selectSeason(orderedSeasons[targetIndex], targetTab);
          window.setTimeout(function () {
            try {
              targetTab.scrollIntoView({ block: 'nearest', inline: 'center' });
            } catch (e) {}
          }, 50);
        }
      })
      .catch(function () {});
  }

  return section;
}

function buildCastRow(people) {
  const peopleList = Array.isArray(people) ? people : [];
  const cast = peopleList.filter(function (person) {
    return person.Type === 'Actor';
  });
  if (!cast.length) return null;

  const section = el('section', 'jellio-detail-cast');
  section.appendChild(el('h2', 'jellio-row-title', t('detail_cast')));
  const trackWrap = el('div', 'jellio-row-track-wrap');
  const track = el('div', 'jellio-row-track');
  cast.slice(0, 20).forEach(function (person) {
    const card = el('div', 'jellio-cast-card');
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', person.Name || '');
    if (person.PrimaryImageTag) {
      const img = el('img', 'jellio-cast-image');
      img.src = getImageUrl(person.Id, 'Primary', { tag: person.PrimaryImageTag, maxWidth: 200 });
      img.alt = person.Name || '';
      img.loading = 'lazy';
      card.appendChild(img);
    } else {
      card.appendChild(el('div', 'jellio-cast-image jellio-cast-image-empty'));
    }
    card.appendChild(el('div', 'jellio-cast-name', person.Name || ''));
    if (person.Role) card.appendChild(el('div', 'jellio-cast-role', person.Role));
    card.addEventListener('click', function () {
      navigateTo('#/person?id=' + person.Id);
    });
    card.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        navigateTo('#/person?id=' + person.Id);
      }
    });
    track.appendChild(card);
  });
  trackWrap.appendChild(track);
  section.appendChild(trackWrap);
  attachScrollArrows(trackWrap, track);
  return section;
}

const IMPORT_POLL_INTERVAL_MS = 3000;
const IMPORT_POLL_MAX_ATTEMPTS = 15;

function fetchItemDetailsWithRetry(itemId, onRetrying, signal) {
  function attempt(attemptsLeft) {
    if (signal && signal.aborted) {
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    }
    return getItemDetails(itemId, { signal: signal }).catch(function (err) {
      if (signal && signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      if (err && (err.name === 'AbortError' || err.aborted)) {
        throw err;
      }
      if (attemptsLeft <= 0) throw err;
      if (onRetrying) onRetrying();
      return new Promise(function (resolve, reject) {
        let timer = null;
        const onAbort = function () {
          if (timer !== null) {
            window.clearTimeout(timer);
            timer = null;
          }
          if (signal) {
            signal.removeEventListener('abort', onAbort);
          }
          reject(new DOMException('Aborted', 'AbortError'));
        };

        if (signal && signal.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }

        if (signal) {
          signal.addEventListener('abort', onAbort);
        }

        timer = window.setTimeout(function () {
          timer = null;
          if (signal) {
            signal.removeEventListener('abort', onAbort);
          }
          resolve();
        }, IMPORT_POLL_INTERVAL_MS);
      }).then(function () {
        return attempt(attemptsLeft - 1);
      });
    });
  }
  return attempt(IMPORT_POLL_MAX_ATTEMPTS);
}

function renderDetailSkeleton(root, preview) {
  root.textContent = '';
  const hero = el('div', 'jellio-detail-hero');
  const backdropUrl = paintHeroArt(hero, preview, preview.Id);
  const heroContent = el('div', 'jellio-detail-hero-content');
  const titleText = preview.Type === 'Episode' && preview.SeriesName
    ? preview.SeriesName + (preview.Name ? ' · ' + preview.Name : '')
    : preview.Name || '';
  heroContent.appendChild(el('h1', 'jellio-detail-title', titleText));

  const meta = el('div', 'jellio-detail-meta');
  if (preview.ProductionYear) meta.appendChild(el('span', null, String(preview.ProductionYear)));
  if (preview.CommunityRating) meta.appendChild(buildRatingBadge(preview.CommunityRating));
  heroContent.appendChild(meta);

  if (preview.Overview) {
    heroContent.appendChild(el('p', 'jellio-detail-overview', preview.Overview));
  }
  hero.appendChild(heroContent);
  root.appendChild(hero);

  const skeletonLoading = el('div', 'jellio-detail-skeleton-loading');
  skeletonLoading.appendChild(el('div', 'jellio-screen-spinner'));
  root.appendChild(skeletonLoading);
}

function renderEditionSelector(container, editions, current, onSelect) {
  container.textContent = '';
  const selector = el('div', 'jellio-edition-selector');
  selector.setAttribute('role', 'radiogroup');
  selector.setAttribute('aria-label', 'Edition');

  editions.forEach(function (edition) {
    const isSelected = edition === current;
    const pill = el('button', 'jellio-edition-pill' + (isSelected ? ' jellio-edition-pill-active' : ''), edition);
    pill.type = 'button';
    pill.setAttribute('role', 'radio');
    pill.setAttribute('aria-checked', isSelected ? 'true' : 'false');
    pill.addEventListener('click', function () {
      if (edition === current) return;
      current = edition;
      Array.from(selector.querySelectorAll('.jellio-edition-pill')).forEach(function (btn) {
        const isThis = btn === pill;
        btn.classList.toggle('jellio-edition-pill-active', isThis);
        btn.setAttribute('aria-checked', isThis ? 'true' : 'false');
      });
      onSelect(edition);
    });
    selector.appendChild(pill);
  });

  container.appendChild(selector);
}

export async function renderDetail(root, params, signal) {
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-detail';

  const itemId = params.get('id');
  if (!itemId || itemId === 'undefined' || itemId === 'null') {
    renderDetailError(root, 'Nothing to show.', null);
    return;
  }

  // Drawn from what was last seen: redraw once if the fresh copy differs.
  let subCleanup = null;
  const onRefreshed = function (event) {
    if (!event.detail || (event.detail.itemId !== itemId && event.detail.itemId !== String(itemId))) return;
    window.removeEventListener('jellio-item-refreshed', onRefreshed);
    if (!root.isConnected || window.location.hash.indexOf('id=' + itemId) === -1) return;
    Promise.resolve(renderDetail(root, params, signal)).then(function (fn) {
      if (typeof fn === 'function') subCleanup = fn;
    });
  };
  window.addEventListener('jellio-item-refreshed', onRefreshed);
  window.setTimeout(function () {
    window.removeEventListener('jellio-item-refreshed', onRefreshed);
  }, 30000);
  if (signal) {
    signal.addEventListener('abort', function () {
      window.removeEventListener('jellio-item-refreshed', onRefreshed);
    }, { once: true });
  }

  // If we already know the item from card click or memory cache, render an instant
  // hero skeleton with title, backdrop, and year so the transition feels instant.
  const preview = getCachedItemSync(itemId);
  if (preview && preview.Name) {
    renderDetailSkeleton(root, preview);
  } else {
    renderLoading(root);
  }

  let item;
  let shownImportMessage = false;
  try {
    item = await fetchItemDetailsWithRetry(itemId, function () {
      if (shownImportMessage) return;
      shownImportMessage = true;
      root.textContent = '';
      renderLoading(root, 'Importing this title for the first time. This can take up to a minute.');
    }, signal);
  } catch (err) {
    if (signal && signal.aborted) {
      throw err;
    }
    if (err && (err.name === 'AbortError' || err.aborted)) {
      throw err;
    }
    console.warn('Jellio: could not load item details', err);
    renderDetailError(root, describeNetworkFailure('this title', err), function () {
      renderDetail(root, params, signal);
    });
    return;
  }

  if (signal && signal.aborted) return;

  if (!item || (!item.Id && !item.Name && !item.Type)) {
    console.warn('Jellio: item details missing for id', itemId);
    renderDetailError(root, describeNetworkFailure('this title', new Error('Title details unavailable')), function () {
      renderDetail(root, params, signal);
    });
    return;
  }

  // Fetched while the loading state is still up, not after it clears.
  const isBook = item.Type === 'Book' || item.Type === 'AudioBook';
  const bookMeta = isBook ? await loadBookMetadata(item.Id || itemId).catch(() => null) : null;
  if (signal && signal.aborted) return;
  mergeBookMetadata(item, bookMeta);

  root.textContent = '';
  // One AudioBook item per file: the book's own title lives on Album,
  // the item's own Name is just this one track's.
  if (item.Type === 'AudioBook') {
    // Untagged books split into files are named by their folder.
    const tracks = item.Album ? null : await getAudiobookTracks(item).catch(() => null);
    item.Name = audiobookTitle(item, tracks ? tracks.length : 1);
  }
  setTitle((item.Type === 'Episode' && item.SeriesName ? item.SeriesName : item.Name) + ' - Jellio');

  const canonicalId = item.Id || itemId;
  item.Id = canonicalId;

  const hero = el('div', 'jellio-detail-hero');
  const backdropUrl = paintHeroArt(hero, item, canonicalId);

  const heroContent = el('div', 'jellio-detail-hero-content');

  // Books and audiobooks never carry a backdrop, only a cover: show the
  // cover itself above the title, plus who wrote it.
  if (isBook) {
    const coverUrl =
      bookCoverUrl(item, canonicalId) ||
      (bookMeta && bookMeta.HasCover ? getBookCoverUrl(canonicalId) : null) ||
      getMangaSeriesCoverUrl(canonicalId, item.SeriesName);
    if (coverUrl) {
      const cover = document.createElement('img');
      cover.className = 'jellio-detail-book-cover';
      cover.src = coverUrl;
      cover.alt = '';
      let triedMangaFallback = coverUrl === getMangaSeriesCoverUrl(canonicalId, item.SeriesName);
      cover.addEventListener('error', function () {
        if (!triedMangaFallback) {
          triedMangaFallback = true;
          cover.src = getMangaSeriesCoverUrl(canonicalId, item.SeriesName);
          return;
        }
        cover.remove();
      });
      heroContent.appendChild(cover);
    }
  }

  if (item.Type === 'Episode' && item.SeriesId && item.SeriesName) {
    const seriesLink = el('button', 'jellio-detail-series-link', item.SeriesName);
    seriesLink.type = 'button';
    seriesLink.addEventListener('click', function () {
      navigateTo('#/item?id=' + item.SeriesId);
    });
    heroContent.appendChild(seriesLink);
  }

  const hasEpisodeCode = typeof item.ParentIndexNumber === 'number' && typeof item.IndexNumber === 'number';
  const titleText =
    item.Type === 'Episode' && hasEpisodeCode
      ? 'S' + item.ParentIndexNumber + ' E' + item.IndexNumber + ' · ' + (item.Name || '')
      : item.Name || '';
  heroContent.appendChild(el('h1', 'jellio-detail-title', titleText));
  if (isBook) {
    const authors = bookAuthors(item) || (bookMeta && bookMeta.Authors);
    if (authors) heroContent.appendChild(el('div', 'jellio-detail-book-author', 'by ' + authors));
    const facts = bookFacts(bookMeta);
    if (facts) heroContent.appendChild(el('div', 'jellio-detail-book-facts', facts));
  }

  const meta = el('div', 'jellio-detail-meta');
  if (item.Type === 'Episode') {
    const releaseLabel = episodeReleaseLabel(item);
    if (releaseLabel) {
      meta.appendChild(el('span', 'jellio-detail-release-date', releaseLabel));
    }
    if (item.PremiereDate) {
      const premDate = new Date(item.PremiereDate);
      if (!isNaN(premDate.getTime()) && premDate.getUTCFullYear() < 9000) {
        meta.appendChild(el('span', null, premDate.toLocaleDateString()));
      }
    } else if (item.ProductionYear) {
      meta.appendChild(el('span', null, String(item.ProductionYear)));
    }
  } else if (item.ProductionYear) {
    meta.appendChild(el('span', null, String(item.ProductionYear)));
  }
  const runtime = formatRuntime(item.RunTimeTicks);
  if (runtime) meta.appendChild(el('span', null, runtime));
  if (item.OfficialRating) meta.appendChild(el('span', null, item.OfficialRating));
  if (item.CommunityRating) meta.appendChild(buildRatingBadge(item.CommunityRating));
  heroContent.appendChild(meta);

  // Filled in once the stream lookup below answers.
  const badgeSlot = el('div', 'jellio-detail-badge-slot');
  heroContent.appendChild(badgeSlot);

  const rawGenres = item.Genres || item.Genre;
  const genresList = Array.isArray(rawGenres)
    ? rawGenres
    : typeof rawGenres === 'string'
    ? rawGenres.split(',').map(function (s) { return s.trim(); }).filter(Boolean)
    : [];
  if (genresList.length) {
    const genres = el('div', 'jellio-detail-genres', genresList.map(function (genre) { return translateGenre(genre); }).join(', '));
    heroContent.appendChild(genres);
  }

  let seriesTargetPromise = null;
  const isSeries = item.Type === 'Series';
  const isSeason = item.Type === 'Season';
  const needsEpisodeResolution = isSeries || isSeason;
  // Books and audiobooks open Jellio's own reader/listener screens, not
  // the video stream picker - there is no stream to pick for either.
  const readerKind = item.Type === 'Book' ? 'read' : item.Type === 'AudioBook' ? 'listen' : null;
  const iconActionClass = 'jellio-detail-icon-action jellio-detail-icon-action-collapsible';
  let activeEdition = null;
  const actions = el('div', 'jellio-detail-actions jellio-detail-actions-has-more');

  if (readerKind) {
    const hasProgress = !!(
      item.UserData &&
      ((item.UserData.PlaybackPositionTicks && item.UserData.PlaybackPositionTicks > 0) ||
       (item.UserData.PlayedPercentage && item.UserData.PlayedPercentage > 0 && !item.UserData.Played))
    );
    const readButton = el('button', 'jellio-detail-play');
    readButton.type = 'button';
    readButton.appendChild(el('span', 'material-icons ' + (readerKind === 'read' ? 'menu_book' : 'headphones')));
    const readLabel = el('span', null, hasProgress ? t('action_resume') : readerKind === 'read' ? t('nav_reading') : t('nav_audiobooks'));
    readButton.appendChild(readLabel);
    readButton.addEventListener('click', function () {
      navigateTo('#/' + readerKind + '?id=' + item.Id);
    });
    actions.appendChild(readButton);

    if (readerKind === 'read' && !hasProgress) {
      getReadingProgress(item.Id)
        .then(function (progress) {
          if (progress && progress.Progress > 0 && progress.Progress < 0.98) {
            readLabel.textContent = t('action_resume');
          }
        })
        .catch(function () {});
    }
  } else if (!needsEpisodeResolution) {
    const playButton = el('button', 'jellio-detail-play');
    playButton.type = 'button';
    playButton.appendChild(el('span', 'material-icons play_arrow'));
    playButton.appendChild(el('span', null, t('action_play')));
    playButton.addEventListener('click', function () {
      openStreamPicker(item, activeEdition ? { edition: activeEdition } : undefined);
    });
    actions.appendChild(playButton);
  } else {
    const playButton = el('button', 'jellio-detail-play');
    playButton.type = 'button';
    const playIcon = el('span', 'material-icons play_arrow');
    const playLabel = el('span', null, t('action_play'));
    playButton.appendChild(playIcon);
    playButton.appendChild(playLabel);
    actions.appendChild(playButton);

    const targetPromise = (isSeason ? resolveSeasonPlayTarget(item) : resolveSeriesPlayTarget(item.Id)).then(
      function (result) {
        if (result && result.resume) {
          playLabel.textContent = t('detail_resume_episode', { s: result.episode.ParentIndexNumber, e: result.episode.IndexNumber });
        }
        return result;
      },
    );
    if (isSeries) seriesTargetPromise = targetPromise;

    playButton.addEventListener('click', function () {
      playButton.disabled = true;
      targetPromise
        .then(function (result) {
          if (result && result.episode) openStreamPicker(result.episode);
        })
        .catch(function (err) {
          console.warn('Jellio: could not resolve series/season play target', err);
        })
        .finally(function () {
          playButton.disabled = false;
        });
    });
  }

  const actionsIcons = el('div', 'jellio-detail-actions-icons');
  actions.appendChild(actionsIcons);

  function playPop(button) {
    button.classList.remove('jellio-detail-icon-action-pop');
    button.classList.remove('jellio-card-action-pop');
    void button.offsetWidth;
    button.classList.add('jellio-detail-icon-action-pop');
    button.classList.add('jellio-card-action-pop');
    button.addEventListener('animationend', function handler() {
      button.classList.remove('jellio-detail-icon-action-pop');
      button.classList.remove('jellio-card-action-pop');
      button.removeEventListener('animationend', handler);
    });
  }

  const watchlistButton = el('button', iconActionClass);
  watchlistButton.type = 'button';
  function paintWatchlist() {
    const active = !!(item.UserData && item.UserData.IsFavorite);
    watchlistButton.classList.toggle('jellio-detail-icon-action-active', active);
    watchlistButton.setAttribute('aria-label', active ? 'Remove from Watchlist' : 'Add to Watchlist');
    watchlistButton.textContent = '';
    watchlistButton.appendChild(el('span', 'material-icons ' + (active ? 'bookmark_added' : 'bookmark_add')));
  }
  paintWatchlist();
  let watchlistPending = false;
  watchlistButton.addEventListener('click', function (event) {
    event.stopPropagation();
    if (isGrouplistEnabled()) {
      openListMembershipMenu(item, watchlistButton.getBoundingClientRect(), paintWatchlist);
      return;
    }
    if (watchlistPending) return;
    watchlistPending = true;
    const req = toggleWatchlist(item);
    paintWatchlist();
    playPop(watchlistButton);
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
  actionsIcons.appendChild(watchlistButton);

  const watchedButton = el('button', iconActionClass);
  watchedButton.type = 'button';
  function paintWatched() {
    const active = !!(item.UserData && item.UserData.Played);
    watchedButton.classList.toggle('jellio-detail-icon-action-active', active);
    watchedButton.setAttribute('aria-label', active ? 'Mark as unwatched' : 'Mark as watched');
    watchedButton.textContent = '';
    watchedButton.appendChild(el('span', 'material-icons check'));
  }
  paintWatched();
  let watchedPending = false;
  watchedButton.addEventListener('click', function (event) {
    event.stopPropagation();
    if (watchedPending) return;
    watchedPending = true;
    const req = toggleWatched(item, {});
    paintWatched();
    playPop(watchedButton);
    req
      .then(function () {
        paintWatched();
      })
      .catch(function (err) {
        paintWatched();
        console.warn('Jellio: could not update watched state', err);
        showToast(t('toast_watched_error'));
      })
      .finally(function () {
        watchedPending = false;
      });
  });
  actionsIcons.appendChild(watchedButton);

  // A link to this title for anyone else with an account on the server.
  const shareButton = el('button', iconActionClass);
  shareButton.type = 'button';
  shareButton.setAttribute('aria-label', t('action_copy_link_share'));
  shareButton.title = t('action_copy_link_share');
  shareButton.appendChild(el('span', 'material-icons share'));
  shareButton.addEventListener('click', function (event) {
    event.stopPropagation();
    shareItem(item)
      .then(function (result) {
        if (result === 'copied') showToast(t('toast_link_copied'));
      })
      .catch(function () {
        showToast(t('toast_copy_link_error'));
      });
  });
  actionsIcons.appendChild(shareButton);

  const downloadButton =
    buildDownloadButton(item, { className: iconActionClass, compact: true }) ||
    buildEpisodesDownloadButton(item, { className: iconActionClass });
  if (downloadButton) actionsIcons.appendChild(downloadButton);

  const thumbsUpButton = el('button', iconActionClass);
  thumbsUpButton.type = 'button';
  const thumbsDownButton = el('button', iconActionClass);
  thumbsDownButton.type = 'button';

  let ratingTarget = item;
  let ratingTargetResolved = !(item.Type === 'Episode' && item.SeriesId);
  let ratingEdited = false;
  const ratingTargetPromise =
    item.Type === 'Episode' && item.SeriesId
      ? getItem(item.SeriesId).catch(function (err) {
          console.warn('Jellio: could not load series for rating', err);
          return item;
        })
      : Promise.resolve(item);

  function paintThumbs() {
    const likes = ratingTarget.UserData && ratingTarget.UserData.Likes;
    thumbsUpButton.classList.toggle('jellio-detail-icon-action-active', likes === true);
    thumbsUpButton.setAttribute('aria-label', likes === true ? 'Remove like' : 'Like');
    thumbsUpButton.textContent = '';
    thumbsUpButton.appendChild(el('span', 'material-icons ' + (likes === true ? 'thumb_up' : 'thumb_up_alt')));

    thumbsDownButton.classList.toggle('jellio-detail-icon-action-active', likes === false);
    thumbsDownButton.setAttribute('aria-label', likes === false ? 'Remove dislike' : 'Dislike');
    thumbsDownButton.textContent = '';
    thumbsDownButton.appendChild(el('span', 'material-icons ' + (likes === false ? 'thumb_down' : 'thumb_down_alt')));
  }
  paintThumbs();
  ratingTargetPromise.then(function (resolved) {
    ratingTarget = resolved;
    ratingTargetResolved = true;
    if (!ratingEdited) paintThumbs();
  });

  let ratingPending = false;
  function handleThumbClick(likesValue, button) {
    if (ratingPending) return;
    ratingPending = true;
    ratingEdited = true;
    if (ratingTargetResolved) {
      const req = toggleRating(ratingTarget, likesValue);
      paintThumbs();
      playPop(button);
      req
        .then(function () {
          paintThumbs();
        })
        .catch(function (err) {
          paintThumbs();
          console.warn('Jellio: could not update rating', err);
          showToast(t('toast_rating_error'));
        })
        .finally(function () {
          ratingPending = false;
        });
      return;
    }

    const prevLikes = ratingTarget.UserData && ratingTarget.UserData.Likes;
    const nextLikes = prevLikes === likesValue ? null : likesValue;
    ratingTarget.UserData = Object.assign({}, ratingTarget.UserData, { Likes: nextLikes });
    paintThumbs();
    playPop(button);

    ratingTargetPromise
      .then(function (resolved) {
        if (resolved === ratingTarget) {
          ratingTarget.UserData = Object.assign({}, ratingTarget.UserData, { Likes: prevLikes });
        }
        ratingTarget = resolved;
        ratingTargetResolved = true;
        return toggleRating(ratingTarget, likesValue);
      })
      .then(function () {
        paintThumbs();
      })
      .catch(function (err) {
        paintThumbs();
        console.warn('Jellio: could not update rating', err);
        showToast(t('toast_rating_error'));
      })
      .finally(function () {
        ratingPending = false;
      });
  }

  thumbsUpButton.addEventListener('click', function (event) {
    event.stopPropagation();
    handleThumbClick(true, thumbsUpButton);
  });
  actionsIcons.appendChild(thumbsUpButton);

  thumbsDownButton.addEventListener('click', function (event) {
    event.stopPropagation();
    handleThumbClick(false, thumbsDownButton);
  });
  actionsIcons.appendChild(thumbsDownButton);

  if (!needsEpisodeResolution && !readerKind) {
    const changeStreamButton = el('button', iconActionClass);
    changeStreamButton.type = 'button';
    changeStreamButton.setAttribute('aria-label', t('detail_change_stream'));
    changeStreamButton.appendChild(el('span', 'material-icons sync_alt'));
    changeStreamButton.addEventListener('click', function (event) {
      event.stopPropagation();
      openStreamPicker(item, Object.assign({ forceChoice: true }, activeEdition ? { edition: activeEdition } : {}));
    });
    actionsIcons.appendChild(changeStreamButton);
  }

  const seriesOrItemKey = 's:' + String(item.Id).replace(/-/g, '').toLowerCase();
  const rawKey = String(item.Id).replace(/-/g, '').toLowerCase();

  if (item.Type === 'Series') {
    const muteToggle = el('button', iconActionClass);
    muteToggle.type = 'button';
    muteToggle.setAttribute('aria-label', t('detail_mute_notifications'));
    muteToggle.title = t('detail_skip_notifications_show');
    muteToggle.appendChild(el('span', 'material-icons notifications_off'));

    function paintMuteToggle(on) {
      muteToggle.classList.toggle('jellio-detail-icon-action-active', !!on);
      muteToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
    }

    loadShelf('manga')
      .then(function (shelf) {
        const prefs = shelf.Series && (shelf.Series[seriesOrItemKey] || shelf.Series[rawKey] || shelf.Series[item.Id]);
        paintMuteToggle(prefs && prefs.SkipUpdates);
      })
      .catch(() => {});

    muteToggle.addEventListener('click', function (event) {
      event.stopPropagation();
      loadShelf('manga').then(function (shelf) {
        const prefs = shelf.Series && (shelf.Series[seriesOrItemKey] || shelf.Series[rawKey] || shelf.Series[item.Id]);
        const next = !(prefs && prefs.SkipUpdates);
        saveSeriesPrefs(seriesOrItemKey, { SkipUpdates: next })
          .then(function () {
            paintMuteToggle(next);
            showToast(next ? t('detail_notifications_muted') : t('detail_notifications_enabled'));
          })
          .catch(function () {
            showToast(t('toast_save_error'));
          });
      });
    });
    actionsIcons.appendChild(muteToggle);
  }

  const rawTags = item.Tags || item.Tag;
  const tagsList = Array.isArray(rawTags)
    ? rawTags
    : typeof rawTags === 'string'
    ? rawTags.split(',').map(function (s) { return s.trim(); }).filter(Boolean)
    : [];
  const isAnimeSeries =
    item.Type === 'Series' &&
    ((params && params.get('jellioKind') === 'anime') ||
      genresList.some(function (g) { return /anime/i.test(g); }) ||
      tagsList.some(function (t) { return /anime/i.test(t); }));
  if (isAnimeSeries) {
    const trackerButton = el('button', iconActionClass);
    trackerButton.type = 'button';
    trackerButton.setAttribute('aria-label', t('detail_track_anilist'));
    trackerButton.title = t('detail_track_anilist');
    trackerButton.appendChild(el('span', 'material-icons sync'));
    trackerButton.addEventListener('click', function (event) {
      event.stopPropagation();
      openTrackerDialog({
        key: seriesOrItemKey,
        title: item.Name,
        mediaType: 'ANIME',
        onChange: function () {},
      });
    });
    actionsIcons.appendChild(trackerButton);
  }

  const moreButton = el('button', 'jellio-detail-icon-action jellio-detail-icon-action-more');
  moreButton.type = 'button';
  moreButton.setAttribute('aria-label', t('action_more_options'));
  moreButton.appendChild(el('span', 'material-icons more_vert'));

  let actionsExpanded = false;
  function handleActionsOutsideClick(event) {
    if (actions.contains(event.target)) return;
    if (isInsideListMembershipMenu(event.target)) return;
    collapseActions();
  }
  function collapseActions() {
    if (!actionsExpanded) return;
    actionsExpanded = false;
    actions.classList.remove('jellio-detail-actions-expanded');
    moreButton.classList.remove('jellio-detail-icon-action-active');
    document.removeEventListener('pointerdown', handleActionsOutsideClick, true);
  }
  function expandActions() {
    if (actionsExpanded) return;
    actionsExpanded = true;
    actions.classList.add('jellio-detail-actions-expanded');
    moreButton.classList.add('jellio-detail-icon-action-active');
    window.setTimeout(function () {
      document.addEventListener('pointerdown', handleActionsOutsideClick, true);
    }, 0);
  }
  moreButton.addEventListener('click', function (event) {
    event.stopPropagation();
    if (actionsExpanded) {
      collapseActions();
    } else {
      expandActions();
    }
  });
  actionsIcons.appendChild(moreButton);

  const editionMount = el('div', 'jellio-detail-edition-mount');
  heroContent.appendChild(editionMount);
  heroContent.appendChild(actions);

  const playsVideo = !needsEpisodeResolution && !readerKind && (item.Type === 'Movie' || item.Type === 'Episode' || item.Type === 'Video');
  if (playsVideo) {
    warmItem(item.Id, true);
    // Still here after a moment: the next source in line is likely the
    // fallback, so have its probe done too.
    const openedHash = window.location.hash;
    window.setTimeout(function () {
      if (window.location.hash !== openedHash) return;
      Promise.all([getMediaSources(item.Id), getWarmSources(item.Id)])
        .then(function (results) {
          if (window.location.hash !== openedHash) return;
          const sources = results[0] || [];
          const warm = results[1] || {};
          const ordered = sources
            .filter(function (source) { return !isBadSource(item.Id, source); })
            .concat(sources.filter(function (source) { return isBadSource(item.Id, source); }));
          const second = ordered[1];
          const warmIds = Object.keys(warm).map(normalizeId);
          if (second && warmIds.indexOf(normalizeId(second.Id)) === -1) warmSource(item.Id, second.Id);
        })
        .catch(function () {});
    }, 1500);
    const streamStatus = el('div', 'jellio-detail-stream-status');
    heroContent.appendChild(streamStatus);
    watchSources(
      function () {
        return getMediaSources(item.Id);
      },
      function (update) {
        streamStatus.textContent = '';
        streamStatus.hidden = update.state === 'finding';
        if (update.state === 'finding') return;
        if (update.state === 'ready') {
          streamStatus.hidden = true;
          const badges = buildMediaTechBadges({ MediaSources: update.sources });
          if (badges) badgeSlot.appendChild(badges);

          const editions = getAvailableEditions(update.sources);
          if (editions.length >= 2) {
            activeEdition = getPreferredEdition(item.Id, editions);
            renderEditionSelector(editionMount, editions, activeEdition, function (newEd) {
              activeEdition = newEd;
              setPreferredEdition(item.Id, newEd);
            });
          } else {
            editionMount.textContent = '';
          }
          return;
        }
        streamStatus.appendChild(el('span', null, update.state === 'empty' ? t('detail_no_streams') : 'Could not check for streams.'));
      },
    );
  }

  hero.appendChild(heroContent);
  root.appendChild(hero);

  const overviewEl = el('p', 'jellio-detail-overview', item.Overview || '');
  overviewEl.hidden = !item.Overview;
  root.appendChild(overviewEl);

  let cancelled = false;
  let seasonsPromise = null;
  const castMount = el('div', 'jellio-detail-cast-mount');
  let shownBackdrop = backdropUrl;
  function showSeasonDetails(season) {
    getItemDetails(season.Id)
      .then(function (seasonItem) {
        if (cancelled || !seasonItem) return;
        const overview = seasonItem.Overview || item.Overview || '';
        overviewEl.textContent = overview;
        overviewEl.hidden = !overview;
        const people = seasonItem.People && seasonItem.People.length ? seasonItem.People : item.People;
        castMount.textContent = '';
        const seasonCast = buildCastRow(people);
        if (seasonCast) castMount.appendChild(seasonCast);
        const seasonBackdrop =
          seasonItem.BackdropImageTags && seasonItem.BackdropImageTags[0]
            ? getImageUrl(seasonItem.Id, 'Backdrop', { tag: seasonItem.BackdropImageTags[0], maxWidth: 1920 })
            : backdropUrl;
        if (seasonBackdrop && seasonBackdrop !== shownBackdrop) {
          shownBackdrop = seasonBackdrop;
          fadeInBackdrop(hero, seasonBackdrop);
        }
      })
      .catch(function (err) {
        console.warn('Jellio: could not load season details', err);
      });
  }
  if (item.Type === 'Series') {
    seasonsPromise = buildSeasonsSection(canonicalId, seriesTargetPromise, showSeasonDetails);
  } else if (item.Type === 'Episode' && item.SeriesId) {
    seasonsPromise = buildSeasonsSection(item.SeriesId, null, null, item.SeasonId, item.ParentIndexNumber);
  }

  const castRow = buildCastRow(item.People);
  if (castRow) castMount.appendChild(castRow);
  root.appendChild(castMount);

  const trailersRow = buildTrailersRow(item.RemoteTrailers);
  if (trailersRow) root.appendChild(trailersRow);

  if (seasonsPromise) {
    seasonsPromise.then(function (seasonsSection) {
      if (cancelled || !seasonsSection) return;
      root.insertBefore(seasonsSection, castMount);
    });
  }

  return function () {
    cancelled = true;
    window.removeEventListener('jellio-item-refreshed', onRefreshed);
    if (subCleanup) subCleanup();
    collapseActions();
    closeEpisodeMenu();
    closeTrailerModal();
  };
}
