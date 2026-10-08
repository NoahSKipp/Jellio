// Metadata view for one item: backdrop, title, overview, genres, cast,
// trailers.
// Play opens components/streamPicker.js's own picker first when there
// is real more than one source to choose from (that same file falls
// straight through to #/play, real playback, PlaybackInfo negotiation
// plus a bare <video> element, see screens/player.js's own header for
// why that needed no access to jellyfin-web's own playbackManager at
// all, when there is not).
import { shareItem } from '../runtime/shareLink.js';
import { buildDownloadButton, buildEpisodesDownloadButton, canDownload, promptDownload } from '../components/downloads.js';
import {
  getItemDetails,
  getImageUrl,
  getItem,
  getSeasons,
  getEpisodes,
  setPlayed,
  getSeriesNextUp,
  getBookMetadata,
  getBookCoverUrl,
  getAudiobookTracks,
  audiobookTitle,
  getCachedItemSync,
  getReadingProgress,
} from '../runtime/api.js';
import { navigateTo, setTitle } from '../runtime/router.js';
import { openStreamPicker } from '../components/streamPicker.js';
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
import { el } from '../runtime/dom.js';

// A failed item lookup used to just console.warn and return, leaving
// root exactly as blank as root.textContent = '' left it: a series's
// own episode card navigates straight here, so a reader clicking an
// episode saw nothing happen at all, same silent failure shape found
// and fixed on the search screen, the boot splash and the player
// screen's own three negotiation failures. A real message plus a real
// way back is the same fix again here, now a real Retry too
// (components/networkState.js's own renderRetry()) rather than only
// Back to Home: on a bad connection the same lookup often just needs
// asking again, not a trip back to a whole different screen first.
function renderDetailError(root, message, onRetry) {
  renderRetry(root, message, onRetry, { onBack: function () { navigateTo('#/home'); }, backLabel: 'Back to Home' });
}

// An Episode's own real BaseItemDto never carries BackdropImageTags,
// confirmed live (Jellyfin only stores backdrop art against a Movie/
// Series/Season), so the hero above an episode's own detail page had
// nothing to show at all, real feedback live. The episode's own still
// (ImageTags.Primary, the same real field components/card.js's own
// buildEpisodeCard below already reads for its own thumb) is the real
// per-episode art Jellyfin does keep, falling back to the parent
// series' own backdrop (ParentBackdropItemId/ParentBackdropImageTags,
// populated whenever that series has one) rather than a blank hero for
// the rare episode with neither.
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
  // Real bug, found live against a real screenshot: an episode's own
  // real Primary image is a screengrab a metadata provider pulled
  // straight from the episode itself, usually a real few hundred px
  // wide and framed for a real small thumbnail, not this hero's own
  // real large banner. The series/season's own real ParentBackdrop is
  // real cinematic key art sized for exactly this, and used to only be
  // reached here once the episode's own real Primary check above it
  // had already failed, so a series with a real backdrop still rendered
  // that low real resolution, oddly cropped screengrab stretched across
  // the whole real hero instead. Only an episode with neither a real
  // backdrop of its own nor a real parent one to borrow ever really
  // needs its own Primary here now, the one real case it still can
  // recover something from at all.
  if (item.ParentBackdropItemId && item.ParentBackdropImageTags && item.ParentBackdropImageTags[0]) {
    return getImageUrl(item.ParentBackdropItemId, 'Backdrop', {
      tag: item.ParentBackdropImageTags[0],
      maxWidth: 1920,
    });
  }
  if (item.Type === 'Episode' && item.ImageTags && item.ImageTags.Primary) {
    return getImageUrl(id, 'Primary', { tag: item.ImageTags.Primary, maxWidth: 1920 });
  }
  return null;
}

// RemoteTrailers, runtime/api.js's own getItemDetails() Fields list:
// TMDb's own metadata provider (already installed, confirmed against
// this same server's own plugin list) populates this with YouTube
// links server side on every scanned title, real data this screen used
// to just never ask for at all. i.ytimg.com's own real thumbnail
// convention (hqdefault.jpg, no API key needed) rather than a second
// real network round trip through Jellyfin itself just to get a
// preview image for a link this card already opens in a new tab.
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
  externalLink.title = 'Watch on YouTube';
  externalLink.appendChild(el('span', 'material-icons open_in_new'));
  actions.appendChild(externalLink);

  const closeButton = el('button', 'jellio-trailer-modal-close', '×');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Close trailer');
  closeButton.addEventListener('click', closeTrailerModal);
  actions.appendChild(closeButton);

  header.appendChild(actions);
  card.appendChild(header);

  const playerWrap = el('div', 'jellio-trailer-modal-player');
  const iframe = document.createElement('iframe');
  iframe.className = 'jellio-trailer-modal-iframe';
  // jellyfin-web's page carries <meta name="referrer" content="no-referrer">,
  // and YouTube now refuses an embed that arrives without a Referer (its
  // "error 153"). The iframe's own policy overrides the page's, and the
  // origin is passed along too.
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
  const usable = (trailers || []).filter(function (trailer) {
    return trailer && trailer.Url;
  });
  if (!usable.length) return null;

  const section = el('section', 'jellio-detail-trailers');
  section.appendChild(el('h2', 'jellio-row-title', 'Trailers'));
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

// Real Nuvio reference, screenshots checked before writing this: a
// right click (or a held press, touch's own equivalent, the same real
// gesture components/cardOptionsMenu.js's own attachCardOptionsTrigger
// already uses for a poster card) on an episode still opens Mark as
// watched, Mark previous as watched and Mark season as watched, no
// Play Manually here (that only ever made real sense for a Continue
// Watching card with a resume position to skip past, not a season
// browse). context.episodes is the exact same array this season's own
// track was built from, mutated in place by setPlayed's own response
// rather than re-fetched, so onChanged can re-render every card from
// it directly without a second real network round trip.
function openEpisodeOptionsMenu(episode, anchorRect, context) {
  closeEpisodeMenu();

  const menu = document.createElement('div');
  menu.id = EPISODE_MENU_ID;
  menu.className = 'jellio-card-options-menu';
  menu.setAttribute('role', 'menu');
  positionEpisodeMenu(menu, anchorRect);

  const isPlayed = !!(episode.UserData && episode.UserData.Played);
  menu.appendChild(
    buildEpisodeMenuOption(isPlayed ? 'Mark as unwatched' : 'Mark as watched', 'check', function () {
      setPlayed(episode.Id, !isPlayed)
        .then(function (updated) {
          episode.UserData = updated;
          context.onChanged();
        })
        .catch(function (err) {
          console.warn('Jellio: could not update watched state', err);
          showToast('Could not update watched state. Try again.');
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
            showToast('Could not mark previous episodes watched. Try again.');
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
          showToast('Could not mark season watched. Try again.');
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
          showToast('Could not mark season unwatched. Try again.');
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

  // Admin only, and only once the server side toggle itself is on
  // (Configuration/config.html's own "Show Find Skip Intro/Credits..."
  // checkbox, off by default): components/cardOptionsMenu.js's own
  // findSkipTimestamps, the same Quick/Deep pair a Series card's own
  // right click offers for the whole show, scoped here to just this one
  // Episode or its whole Season instead - "Mark season as watched" right
  // above already established this same menu as where a season wide
  // action against an episode card belongs.
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
  // Real bug, found live: the fallback below used to ask for
  // episode.Id's own Primary image using ParentThumbImageTag as the
  // tag, two real fields off completely different real items
  // (ParentThumbImageTag is the season/series' own Thumb image, not a
  // second Primary tag for the episode itself), so an episode with no
  // real still of its own asked Jellyfin for an image that item never
  // actually has under that type, an occasionally-wrong or
  // occasionally-blank real result depending on how the server itself
  // handles that mismatch. ParentThumbItemId (the real real id that
  // tag actually belongs to) plus the real Thumb type is the same real
  // pattern this file's own heroBackdropUrl() above already gets right
  // for ParentBackdropItemId/ParentBackdropImageTags.
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

  const quickPlay = el('button', 'jellio-episode-quick-play');
  quickPlay.type = 'button';
  quickPlay.setAttribute('aria-label', 'Play episode ' + (episode.IndexNumber != null ? episode.IndexNumber : episode.Name || ''));
  quickPlay.title = 'Play episode';
  quickPlay.appendChild(el('span', 'material-icons play_arrow'));
  quickPlay.addEventListener('click', function (e) {
    e.stopPropagation();
    openStreamPicker(episode);
  });
  thumb.appendChild(quickPlay);

  card.appendChild(thumb);
  card.appendChild(el('div', 'jellio-episode-title', episode.Name || ''));
  if (episode.Overview) {
    card.appendChild(el('div', 'jellio-episode-overview', episode.Overview));
  }
  card.addEventListener('click', function () {
    navigateTo('#/item?id=' + episode.Id);
  });
  card.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      navigateTo('#/item?id=' + episode.Id);
    }
  });
  if (context) attachEpisodeOptionsTrigger(card, episode, context);
  return card;
}

// A Specials "season" is real Jellyfin IndexNumber 0 (checked against a
// live server before writing this, name text as a fallback for a server
// that names one oddly): real feedback wanted it last, the same real
// place Nuvio and native jellyfin-web both already put it, not leading
// the row where a season list otherwise reads oldest to newest.
function isSpecialsSeason(season) {
  if (season.IndexNumber === 0) return true;
  return /special/i.test(season.Name || '');
}

// A series' own real hero Play button (real feedback: it had none at
// all, only Watchlist/Mark Watched, unlike a movie or an episode)
// needs a real episode to actually open the stream picker against, not
// the series item itself, a real Jellyfin Series carries no video of
// its own. runtime/api.js's own getSeriesNextUp already answers "what
// should this reader watch next" the same way a real Up Next row does,
// scoped to just this series; a series with no watch history at all
// still needs a real fallback target though (real feedback specifically
// asked for one: "starts the playback from ep 1"), covered here by
// walking straight to the first real season's own first real episode
// instead of trusting an unscoped, undocumented "does NextUp already
// default to episode one" real server behaviour to hold across every
// real Jellyfin version this plugin runs against.
async function resolveSeriesPlayTarget(seriesId) {
  let episode = null;
  try {
    episode = await getSeriesNextUp(seriesId);
  } catch (err) {
    console.warn('Jellio: could not load next up for series', err);
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
        episode = episodes[0] || null;
      }
    } catch (err) {
      console.warn('Jellio: could not load first episode for series', err);
    }
  }

  if (!episode) return null;

  // Real watch history, not only a real in-progress position: real
  // feedback drew the line at "is this really episode one of season
  // one, untouched", not at whether this exact episode itself has a
  // real partial position on it, one real episode already finished
  // still means the next one up is a real "Resume", not a "Play".
  const isFirstEpisode = episode.ParentIndexNumber === 1 && episode.IndexNumber === 1;
  const hasProgress = !!(episode.UserData && episode.UserData.PlaybackPositionTicks > 0);
  const resume = hasProgress || !isFirstEpisode;
  return { episode: episode, resume: resume };
}

// Real bug, found live: a Season, same as a Series, carries no video of
// its own (item.Type is 'Season' here, not 'Movie'/'Episode'), but used
// to fall into the plain openStreamPicker(item) branch below anyway -
// only isSeries was ever checked, nothing excluded Season from the
// "has its own video" side. openStreamPicker(item) against a Season's
// own id still reached the player, which still reports real playback
// progress against whatever itemId it was handed - writing real
// UserData.PlaybackPositionTicks onto the Season item itself, which
// then surfaced in Continue Watching as a bare "Season 01"/"Specials"
// card with none of a real episode's own context. Scoped to just this
// season's own episodes (getSeriesNextUp isn't season-scoped, it looks
// across the whole series), same resume-vs-play distinction
// resolveSeriesPlayTarget above already makes.
async function resolveSeasonPlayTarget(item) {
  let episodes = [];
  try {
    episodes = await getEpisodes(item.SeriesId, item.Id);
  } catch (err) {
    console.warn('Jellio: could not load episodes for season', err);
    return null;
  }

  if (!episodes.length) return null;

  const episode =
    episodes.filter(function (e) {
      return !(e.UserData && e.UserData.Played);
    })[0] || episodes[episodes.length - 1];

  const isFirstEpisode = episode.Id === episodes[0].Id;
  const hasProgress = !!(episode.UserData && episode.UserData.PlaybackPositionTicks > 0);
  const resume = hasProgress || !isFirstEpisode;
  return { episode: episode, resume: resume };
}

// Season tabs plus the current season's own episode track, appended in
// place once seasons resolve rather than blocking the rest of the screen
// on a series with a lot of them. Real endpoints, GET /Shows/{id}/Seasons
// and GET /Shows/{id}/Episodes, the dedicated show hierarchy API.
async function buildSeasonsSection(seriesId, targetPromise) {
  let seasons;
  try {
    seasons = await getSeasons(seriesId);
  } catch (err) {
    console.warn('Jellio: could not load seasons', err);
    return null;
  }
  if (!seasons.length) return null;

  let activeSeasonId = null;
  if (targetPromise) {
    try {
      const target = await targetPromise;
      if (target && target.episode) {
        activeSeasonId = target.episode.SeasonId || null;
        if (!activeSeasonId && typeof target.episode.ParentIndexNumber === 'number') {
          const match = seasons.find(function (s) {
            return s.IndexNumber === target.episode.ParentIndexNumber;
          });
          if (match) activeSeasonId = match.Id;
        }
      }
    } catch (err) {}
  }

  // Array.prototype.sort is a real stable sort (ES2019+): every real
  // season keeps the order the server itself sent it in, only Specials
  // moves, to the end rather than wherever the server happened to list
  // it (real Jellyfin puts it first, index 0).
  const orderedSeasons = seasons.slice().sort(function (a, b) {
    return (isSpecialsSeason(a) ? 1 : 0) - (isSpecialsSeason(b) ? 1 : 0);
  });

  const section = el('section', 'jellio-detail-seasons');
  section.appendChild(el('h2', 'jellio-row-title', 'Episodes'));

  // Real feedback: neither row had any visible way to reach anything
  // scrolled past its own edge except a mouse drag or a trackpad swipe,
  // real gap on a series with enough seasons or one season with enough
  // episodes. components/scrollArrows.js's own attachScrollArrows(),
  // the same hover revealed prev/next control components/row.js's own
  // rows already use, needs its own position: relative wrap around each
  // real track to anchor against, same real shape that file's own
  // trackWrap already is. Real bug, found live: an arrow only actually
  // turns visible on hover through css/app.css's own real
  // .jellio-row-track-wrap:hover selector, scoped to that one real
  // class name; without it here too the arrows still built and still
  // worked, just sitting at a real permanent opacity: 0 no hover ever
  // reached. jellio-row-track-wrap joins each wrap's own real class
  // rather than replacing it, this section's own real CSS still needs
  // its own two real class names for width/overflow.
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

  // The exact array each episode card's own context menu mutates in
  // place (screens/detail.js's own openEpisodeOptionsMenu, above),
  // re-rendered straight from it again on a mark watched/unwatched
  // rather than a second real fetch of the same season. season itself
  // rides along in context too now, findSkipTimestamps's own Season
  // scope needs its own real id, not just the episode array.
  function renderTrack(season, episodes) {
    track.textContent = '';
    episodes.forEach(function (episode, index) {
      track.appendChild(
        buildEpisodeCard(episode, {
          episodes: episodes,
          index: index,
          season: season,
          onChanged: function () {
            renderTrack(season, episodes);
          },
        }),
      );
    });
    // A season switch swaps in a real different episode count, well
    // after attachScrollArrows()'s own one time initial check already
    // ran and found nothing here yet: this real season might cross the
    // "does this even need arrows" line the last one did not either
    // way, requestAnimationFrame so the track's own real scrollWidth
    // reflects what was just appended before this checks it.
    window.requestAnimationFrame(refreshTrackArrows);
  }

  function selectSeason(season, tabButton) {
    Array.prototype.forEach.call(tabs.children, function (child) {
      child.classList.remove('jellio-season-tab-selected');
      child.setAttribute('aria-selected', 'false');
    });
    tabButton.classList.add('jellio-season-tab-selected');
    tabButton.setAttribute('aria-selected', 'true');
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
        renderTrack(season, episodes);
      })
      .catch(function (err) {
        console.warn('Jellio: could not load episodes', err);
        track.textContent = '';
      });
  }

  let selectedTab = null;
  let selectedSeasonObj = null;

  orderedSeasons.forEach(function (season, index) {
    const tab = el('button', 'jellio-season-tab', season.Name || '');
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', 'false');
    tab.addEventListener('click', function () {
      selectSeason(season, tab);
    });
    tabs.appendChild(tab);

    const isMatch = activeSeasonId ? String(season.Id) === String(activeSeasonId) : index === 0;
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

  return section;
}

function buildCastRow(people) {
  const cast = (people || []).filter(function (person) {
    return person.Type === 'Actor';
  });
  if (!cast.length) return null;

  const section = el('section', 'jellio-detail-cast');
  section.appendChild(el('h2', 'jellio-row-title', 'Cast'));
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

// Real bug, found live: opening a title straight from a search result
// that has never been opened before failed outright every time, going
// back and searching again always fixed it. Root cause matches this
// screen's own comment further down about a search result's own
// synthetic placeholder id: the request below is what actually triggers
// Gelato's real metadata insert the first time a title is ever opened,
// and that insert racing this same request losing (an immediate 404
// before the insert has actually landed, not merely a slow answer) reads
// identically to a real failure with no way to tell the two apart from
// here. A plain second search always worked because the title was a
// real already-imported library item by then.
//
// A single short retry was not enough: confirmed against a real server
// log, Gelato's own InsertActionFilter took 23 real seconds end to end
// for a title never imported before, and a request that lands anywhere
// in that window still just 404s, no matter how it is asked. Polling
// instead, same real wait the reader was already doing by hand (search
// again, wait, open it) just automatic, with the spinner saying why once
// the first attempt has already lost that race.
const IMPORT_POLL_INTERVAL_MS = 3000;
const IMPORT_POLL_MAX_ATTEMPTS = 15;

function fetchItemDetailsWithRetry(itemId, onRetrying) {
  function attempt(attemptsLeft) {
    return getItemDetails(itemId).catch(function (err) {
      if (attemptsLeft <= 0) throw err;
      if (onRetrying) onRetrying();
      return new Promise(function (resolve) {
        window.setTimeout(resolve, IMPORT_POLL_INTERVAL_MS);
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
  const backdropUrl = heroBackdropUrl(preview, preview.Id);
  if (backdropUrl) {
    hero.style.backgroundImage = 'url(' + backdropUrl + ')';
  }
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

export async function renderDetail(root, params) {
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-detail';

  const itemId = params.get('id');
  if (!itemId) {
    renderDetailError(root, 'Nothing to show.', null);
    return;
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
    });
  } catch (err) {
    console.warn('Jellio: could not load item details', err);
    renderDetailError(root, describeNetworkFailure('this title', err), function () {
      renderDetail(root, params);
    });
    return;
  }

  // Fetched while the loading state is still up, not after it clears.
  const isBook = item.Type === 'Book' || item.Type === 'AudioBook';
  const bookMeta = isBook ? await loadBookMetadata(item.Id || itemId) : null;
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

  // A title reached straight from a search result carries a synthetic
  // placeholder id, not a real library one, confirmed against Gelato's
  // own real source: SearchActionFilter's own ConvertMetasToDtos sets
  // dto.Id to a Stremio URI hash and only saves the real metadata for
  // later insertion. The very first request under that id (this one)
  // is what actually triggers the insert, and the response above
  // already describes the real, canonical item, real id included, so
  // every request this screen makes from here on addresses that one
  // directly rather than the placeholder still sitting in params. The
  // original codebase's own canonicalItemId.js exists for the same
  // reason (its own header documents the same mechanism, several
  // follow up requests otherwise all racing the same in-progress
  // insert under the same placeholder).
  const canonicalId = item.Id || itemId;
  // toggleWatched/toggleWatchlist below (components/cardOptionsMenu.js's
  // own shared real state calls, the same ones the poster grid's own
  // inline actions already use) both read item.Id directly, never the
  // canonicalId fallback above: keeping the two in sync here means
  // every downstream real call this screen makes, shared helper or
  // not, addresses the one real canonical id consistently.
  item.Id = canonicalId;

  const hero = el('div', 'jellio-detail-hero');
  const backdropUrl = heroBackdropUrl(item, canonicalId);
  if (backdropUrl) {
    hero.style.backgroundImage = 'url(' + backdropUrl + ')';
  }

  const heroContent = el('div', 'jellio-detail-hero-content');

  // Books and audiobooks never carry a backdrop, only a cover: show the
  // cover itself above the title, plus who wrote it.
  if (isBook) {
    const coverUrl = bookCoverUrl(item, canonicalId) || (bookMeta && bookMeta.HasCover ? getBookCoverUrl(canonicalId) : null);
    if (coverUrl) {
      const cover = document.createElement('img');
      cover.className = 'jellio-detail-book-cover';
      cover.src = coverUrl;
      cover.alt = '';
      cover.addEventListener('error', function () {
        cover.remove();
      });
      heroContent.appendChild(cover);
    }
  }

  // An episode reached from Up Next/Continue Watching (components/
  // card.js's own click handler hands off to this exact route for any
  // item, episodes included) used to land here with no way back to
  // its own series at all, real feedback live: SeriesId/SeriesName are
  // real default BaseItemDto fields on an Episode, already present on
  // every real response here with no extra Fields request needed
  // (components/card.js's own episodeSubtitle() already reads the same
  // two fields off the same kind of response), so this is a real link
  // back, not a second lookup.
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
  if (item.Type === 'Episode' && item.PremiereDate) {
    meta.appendChild(el('span', null, new Date(item.PremiereDate).toLocaleDateString()));
  } else if (item.ProductionYear) {
    meta.appendChild(el('span', null, String(item.ProductionYear)));
  }
  const runtime = formatRuntime(item.RunTimeTicks);
  if (runtime) meta.appendChild(el('span', null, runtime));
  if (item.OfficialRating) meta.appendChild(el('span', null, item.OfficialRating));
  if (item.CommunityRating) meta.appendChild(buildRatingBadge(item.CommunityRating));
  heroContent.appendChild(meta);

  const techBadges = buildMediaTechBadges(item);
  if (techBadges) heroContent.appendChild(techBadges);

  if (item.Genres && item.Genres.length) {
    const genres = el('div', 'jellio-detail-genres', item.Genres.join(', '));
    heroContent.appendChild(genres);
  }

  // Real feedback: three separate wide pill buttons (Play, Change
  // Stream, Add to Watchlist) wrapped onto two real lines at most
  // mobile widths, nothing like Nuvio's own real hero action row
  // (screenshots checked before writing this). Play stays the one wide
  // pill; Watchlist and Mark Watched are icon only circles the same
  // real size as More, matching that same real reference, with Change
  // Stream moved behind More instead of sitting out as its own wide
  // pill for a choice most titles here only have one real answer to
  // anyway (components/streamPicker.js's own openStreamPicker already
  // skips straight to Play for a single source title).
  // A series used to render Watchlist/Mark Watched plain and always
  // visible instead, skipping this row's own collapsible/More machinery
  // entirely: real reasoning at the time was that a series had no Play
  // of its own to lead the row, nothing behind More worth collapsing
  // two of only three real actions for. Real feedback since then: a
  // series' own hero now has a working Play (resolveSeriesPlayTarget()
  // above), the same real leading action a movie or an episode already
  // has, so the same real collapsed-behind-More treatment applies here
  // too now, not a second, inconsistent always-expanded row.
  let seriesTargetPromise = null;
  const isSeries = item.Type === 'Series';
  // Season carries no video of its own either, same as Series - see
  // resolveSeasonPlayTarget's own header for the real bug this avoids.
  const isSeason = item.Type === 'Season';
  const needsEpisodeResolution = isSeries || isSeason;
  // Books and audiobooks open Jellio's own reader/listener screens, not
  // the video stream picker - there is no stream to pick for either.
  const readerKind = item.Type === 'Book' ? 'read' : item.Type === 'AudioBook' ? 'listen' : null;
  const iconActionClass = 'jellio-detail-icon-action jellio-detail-icon-action-collapsible';
  const actions = el('div', 'jellio-detail-actions jellio-detail-actions-has-more');

  // A series (or a season) has no video of its own, only its episodes
  // do (each already opens this same screen at its own item id, with
  // its own working Play button), so Change Stream is skipped entirely
  // here rather than pointing at nothing playable; Watchlist/Mark
  // Watched still apply to the series/season item itself. Play itself
  // still belongs here though (real feedback: a series page with none
  // at all, unlike a movie or an episode), just resolved lazily against
  // whichever episode resolveSeriesPlayTarget/resolveSeasonPlayTarget
  // above actually decides is next.
  if (readerKind) {
    const hasProgress = !!(
      item.UserData &&
      ((item.UserData.PlaybackPositionTicks && item.UserData.PlaybackPositionTicks > 0) ||
       (item.UserData.PlayedPercentage && item.UserData.PlayedPercentage > 0 && !item.UserData.Played))
    );
    const readButton = el('button', 'jellio-detail-play');
    readButton.type = 'button';
    readButton.appendChild(el('span', 'material-icons ' + (readerKind === 'read' ? 'menu_book' : 'headphones')));
    const readLabel = el('span', null, hasProgress ? 'Resume' : readerKind === 'read' ? 'Read' : 'Listen');
    readButton.appendChild(readLabel);
    readButton.addEventListener('click', function () {
      navigateTo('#/' + readerKind + '?id=' + item.Id);
    });
    actions.appendChild(readButton);

    if (readerKind === 'read' && !hasProgress) {
      getReadingProgress(item.Id)
        .then(function (progress) {
          if (progress && progress.Progress > 0 && progress.Progress < 0.98) {
            readLabel.textContent = 'Resume';
          }
        })
        .catch(function () {});
    }
  } else if (!needsEpisodeResolution) {
    const playButton = el('button', 'jellio-detail-play');
    playButton.type = 'button';
    playButton.appendChild(el('span', 'material-icons play_arrow'));
    playButton.appendChild(el('span', null, 'Play'));
    playButton.addEventListener('click', function () {
      openStreamPicker(item);
    });
    actions.appendChild(playButton);
  } else {
    const playButton = el('button', 'jellio-detail-play');
    playButton.type = 'button';
    const playIcon = el('span', 'material-icons play_arrow');
    const playLabel = el('span', null, 'Play');
    playButton.appendChild(playIcon);
    playButton.appendChild(playLabel);
    actions.appendChild(playButton);

    const targetPromise = (isSeason ? resolveSeasonPlayTarget(item) : resolveSeriesPlayTarget(item.Id)).then(
      function (result) {
        if (result && result.resume) {
          playLabel.textContent = 'Resume S' + result.episode.ParentIndexNumber + ' E' + result.episode.IndexNumber;
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
  watchlistButton.addEventListener('click', function (event) {
    event.stopPropagation();
    if (isGrouplistEnabled()) {
      openListMembershipMenu(item, watchlistButton.getBoundingClientRect(), paintWatchlist);
      return;
    }
    watchlistButton.disabled = true;
    toggleWatchlist(item)
      .then(function () {
        paintWatchlist();
        watchlistButton.classList.remove('jellio-card-action-pop');
        requestAnimationFrame(function () {
          watchlistButton.classList.add('jellio-card-action-pop');
        });
      })
      .catch(function (err) {
        console.warn('Jellio: could not update watchlist state', err);
        showToast('Could not update your watchlist. Try again.');
      })
      .finally(function () {
        watchlistButton.disabled = false;
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
  watchedButton.addEventListener('click', function (event) {
    event.stopPropagation();
    watchedButton.disabled = true;
    toggleWatched(item, {})
      .then(function () {
        paintWatched();
        watchedButton.classList.remove('jellio-card-action-pop');
        requestAnimationFrame(function () {
          watchedButton.classList.add('jellio-card-action-pop');
        });
      })
      .catch(function (err) {
        console.warn('Jellio: could not update watched state', err);
        showToast('Could not update watched state. Try again.');
      })
      .finally(function () {
        watchedButton.disabled = false;
      });
  });
  actionsIcons.appendChild(watchedButton);

  // A link to this title for anyone else with an account on the server.
  const shareButton = el('button', iconActionClass);
  shareButton.type = 'button';
  shareButton.setAttribute('aria-label', 'Copy a link to share');
  shareButton.title = 'Copy a link to share';
  shareButton.appendChild(el('span', 'material-icons share'));
  shareButton.addEventListener('click', function (event) {
    event.stopPropagation();
    shareItem(item)
      .then(function (result) {
        if (result === 'copied') showToast('Link copied. Anyone with an account on this server can open it.');
      })
      .catch(function () {
        showToast('Could not copy the link.');
      });
  });
  actionsIcons.appendChild(shareButton);

  // Keep it on this device for offline (components/downloads.js): books,
  // manga, audiobooks, films and episodes.
  // Behind More with the other actions. A series or season downloads
  // several episodes at once.
  const downloadButton =
    buildDownloadButton(item, { className: iconActionClass, compact: true }) ||
    buildEpisodesDownloadButton(item, { className: iconActionClass });
  if (downloadButton) actionsIcons.appendChild(downloadButton);

  // Real Jellyfin's own native like/dislike (UserData.Likes, POST/DELETE
  // /Users/{id}/Items/{id}/Rating), not a second real system this
  // runtime invented: real feedback asked for a personal rating that
  // could also feed runtime/recommend.js's own scorer, and this is the
  // one Jellyfin already has. jellio-detail-icon-action-pop below plays
  // a quick real bounce on whichever thumb the reader just actually
  // set, css/app.css's own jellio-thumb-pop keyframe, removed again on
  // its own animationend so the same thumb can replay it next time
  // rather than only ever once.
  function playPop(button) {
    button.classList.remove('jellio-detail-icon-action-pop');
    // Forces a real reflow: re-adding the same real class in the same
    // real tick would not restart a still-matching CSS animation at
    // all otherwise, the same real trick every other one-shot class
    // toggle in this codebase already needs.
    void button.offsetWidth;
    button.classList.add('jellio-detail-icon-action-pop');
    button.addEventListener('animationend', function handler() {
      button.classList.remove('jellio-detail-icon-action-pop');
      button.removeEventListener('animationend', handler);
    });
  }

  const thumbsUpButton = el('button', iconActionClass);
  thumbsUpButton.type = 'button';
  const thumbsDownButton = el('button', iconActionClass);
  thumbsDownButton.type = 'button';

  // Real feedback: rating one episode used to rate that one episode,
  // real UserData.Likes living on its own real id, no different from
  // Watchlist or Mark Watched there. A personal rating reads as one
  // real opinion about the whole show though, not each episode judged
  // on its own; real feedback asked for liking any one episode to like
  // the series itself instead. ratingTarget is the series' own real
  // item for an Episode (a real fetch, its own UserData is not part of
  // an Episode's own real response at all), item itself otherwise; both
  // thumbs read and write whichever one this resolves to, never the
  // episode's own real record.
  let ratingTarget = item;
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
    paintThumbs();
  });

  thumbsUpButton.addEventListener('click', function (event) {
    event.stopPropagation();
    thumbsUpButton.disabled = true;
    ratingTargetPromise
      .then(function () {
        return toggleRating(ratingTarget, true);
      })
      .then(function () {
        paintThumbs();
        playPop(thumbsUpButton);
      })
      .catch(function (err) {
        console.warn('Jellio: could not update rating', err);
        showToast('Could not update your rating. Try again.');
      })
      .finally(function () {
        thumbsUpButton.disabled = false;
      });
  });
  actionsIcons.appendChild(thumbsUpButton);

  thumbsDownButton.addEventListener('click', function (event) {
    event.stopPropagation();
    thumbsDownButton.disabled = true;
    ratingTargetPromise
      .then(function () {
        return toggleRating(ratingTarget, false);
      })
      .then(function () {
        paintThumbs();
        playPop(thumbsDownButton);
      })
      .catch(function (err) {
        console.warn('Jellio: could not update rating', err);
        showToast('Could not update your rating. Try again.');
      })
      .finally(function () {
        thumbsDownButton.disabled = false;
      });
  });
  actionsIcons.appendChild(thumbsDownButton);

  // Play alone already reopens components/streamPicker.js's own picker
  // whenever there is real more than one source and "remember my
  // stream choice" is off; this exists for when it is on, real
  // feedback asked for a way back to the picker specifically without
  // going through Settings, for a remembered choice that stopped
  // working. forceChoice: true skips only that remembered shortcut, a
  // title with one real source still has nothing to change to either
  // way. A series has no stream of its own to change (each episode has
  // its own), so this is skipped there the same as Play above; More
  // still applies to a series though, real feedback's own point,
  // collapsing Watchlist/Mark Watched behind it just the same.
  if (!needsEpisodeResolution && !readerKind) {
    const changeStreamButton = el('button', iconActionClass);
    changeStreamButton.type = 'button';
    changeStreamButton.setAttribute('aria-label', 'Change Stream');
    changeStreamButton.appendChild(el('span', 'material-icons sync_alt'));
    changeStreamButton.addEventListener('click', function (event) {
      event.stopPropagation();
      openStreamPicker(item, { forceChoice: true });
    });
    actionsIcons.appendChild(changeStreamButton);
  }

  if (item.Type === 'Series') {
    const seriesOrItemKey = 's:' + String(item.Id).replace(/-/g, '').toLowerCase();
    const rawKey = String(item.Id).replace(/-/g, '').toLowerCase();

    const muteToggle = el('button', iconActionClass);
    muteToggle.type = 'button';
    muteToggle.setAttribute('aria-label', 'Mute notifications');
    muteToggle.title = 'Skip new-episode notifications for this show';
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
            showToast(next ? 'Notifications muted for this title.' : 'Notifications enabled for this title.');
          })
          .catch(function () {
            showToast('Could not save that setting.');
          });
      });
    });
    actionsIcons.appendChild(muteToggle);
  }

  const isAnimeSeries =
    item.Type === 'Series' &&
    ((params && params.get('jellioKind') === 'anime') ||
      (item.Genres && item.Genres.some((g) => /anime/i.test(g))) ||
      (item.Tags && item.Tags.some((t) => /anime/i.test(t))));
  if (isAnimeSeries) {
    const trackerButton = el('button', iconActionClass);
    trackerButton.type = 'button';
    trackerButton.setAttribute('aria-label', 'Track on AniList');
    trackerButton.title = 'Track on AniList';
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

  // Real feedback: Watchlist, Mark Watched and Change Stream used to
  // sit there permanently, real Nuvio screenshots confirmed that is
  // not the real reference either, only Play and More show by default
  // there, the other two or three only appearing once More itself is
  // actually tapped, More's own colour (and its own three dots rotating
  // flat) flipping to show it is now the one selected. A second real
  // tap on More collapses it straight back, a plain real toggle, the
  // same as tapping anywhere else on the page; real feedback found a
  // second tap opening a whole separate Change Stream menu instead
  // confusing, Change Stream is a plain extra button revealed alongside
  // the other two instead now, for whichever title actually has one.
  //
  // Real feedback, four times over: every real attempt at measuring or
  // pinning some other element's own width to cancel out More's own
  // real drift kept a real visible flash or a real residual jump one
  // way or another, transitions and synchronous layout reads never
  // actually behaving quite the way relying on them assumed. Given up
  // on cancelling real drift after the fact entirely: More
  // (css/app.css's own jellio-detail-icon-action-more) is now position:
  // absolute, right: 0 against .jellio-detail-actions' own real
  // position: relative, taken out of this row's own flex flow
  // altogether. Nothing Play or the other buttons do to their own real
  // widths can ever move an element that flexbox no longer has any
  // real say over the position of at all, the one real way to
  // guarantee this rather than trying to correct for it.
  const moreButton = el('button', 'jellio-detail-icon-action jellio-detail-icon-action-more');
  moreButton.type = 'button';
  moreButton.setAttribute('aria-label', 'More options');
  moreButton.appendChild(el('span', 'material-icons more_vert'));

  let actionsExpanded = false;
  // Real bug, found live: Watchlist's own list-membership popover
  // (components/listMembershipMenu.js) mounts straight to document.body,
  // a real sibling of this actions row rather than a descendant of it -
  // that file's own header explains why. A genuine click inside it used
  // to read as "outside" this row, collapsing it (and the still-open
  // popover's own real anchor along with it) the instant a reader tried
  // to check Watchlist or Grouplist, before ever seeing whether it took.
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

  heroContent.appendChild(actions);

  hero.appendChild(heroContent);
  root.appendChild(hero);

  if (item.Overview) {
    root.appendChild(el('p', 'jellio-detail-overview', item.Overview));
  }

  // Real bug, audit-found: buildCastRow/buildTrailersRow below are pure
  // sync builds off item fields already in hand, no network call of
  // their own, but used to sit behind this section's own real
  // getSeasons round trip regardless. Fired without awaiting instead,
  // same real cancelled-flag shape mountCoverflow() in screens/library.js
  // already uses for the identical reason: a reader who navigates away
  // before this resolves must not have a stale insertBefore land in a
  // root the next screen, or a different title's own renderDetail, has
  // since taken over.
  let cancelled = false;
  let seasonsPromise = null;
  if (item.Type === 'Series') {
    seasonsPromise = buildSeasonsSection(canonicalId, seriesTargetPromise);
  }

  const castRow = buildCastRow(item.People);
  if (castRow) root.appendChild(castRow);

  const trailersRow = buildTrailersRow(item.RemoteTrailers);
  if (trailersRow) root.appendChild(trailersRow);

  if (seasonsPromise) {
    seasonsPromise.then(function (seasonsSection) {
      if (cancelled || !seasonsSection) return;
      // Ahead of Cast/Trailers, same real order this section always
      // rendered in, just no longer holding either of them up to get
      // there: whichever of the two actually rendered is still the
      // real first child in root at this point, nothing else this
      // screen builds lands between them and here.
      root.insertBefore(seasonsSection, castRow || trailersRow || null);
    });
  }

  return function () {
    cancelled = true;
    // Real leak, audit-found: a reader who taps More then navigates away
    // without collapsing it first (Play, a related card, a sidebar link)
    // left handleActionsOutsideClick bound to document forever, one more
    // permanent listener (and this whole renderDetail closure) per such
    // visit. collapseActions() itself already checks actionsExpanded, so
    // this is a no-op on the far more common path where nothing is open.
    collapseActions();
    // Same shape for the episode options menu: closeEpisodeMenu() already
    // no-ops when nothing is open, self-heals on the next real open
    // regardless, but leaving it for that next open means a stray menu
    // node and its document listeners can sit alive well past this
    // screen's own real lifetime.
    closeEpisodeMenu();
    closeTrailerModal();
  };
}
