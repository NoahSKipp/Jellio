// Metadata view for one item: backdrop, title, overview, genres, cast,
// trailers.
// Play opens components/streamPicker.js's own picker first when there
// is real more than one source to choose from (that same file falls
// straight through to #/play, real playback, PlaybackInfo negotiation
// plus a bare <video> element, see screens/player.js's own header for
// why that needed no access to jellyfin-web's own playbackManager at
// all, when there is not).
import { getItemDetails, getImageUrl, getItem, getSeasons, getEpisodes, setPlayed, getSeriesNextUp } from '../runtime/api.js';
import { navigateTo } from '../runtime/router.js';
import { openStreamPicker } from '../components/streamPicker.js';
import { renderLoading, renderRetry } from '../components/networkState.js';
import { describeNetworkFailure } from '../runtime/network.js';
import { toggleWatched, toggleWatchlist, toggleRating } from '../components/cardOptionsMenu.js';
import { attachScrollArrows } from '../components/scrollArrows.js';

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

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function formatRuntime(ticks) {
  if (!ticks) return '';
  const minutes = Math.round(ticks / 600000000);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return hours > 0 ? hours + 'h ' + mins + 'm' : mins + 'm';
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
        });
    }),
  );

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

// Season tabs plus the current season's own episode track, appended in
// place once seasons resolve rather than blocking the rest of the screen
// on a series with a lot of them. Real endpoints, GET /Shows/{id}/Seasons
// and GET /Shows/{id}/Episodes, the dedicated show hierarchy API.
async function buildSeasonsSection(seriesId) {
  let seasons;
  try {
    seasons = await getSeasons(seriesId);
  } catch (err) {
    console.warn('Jellio: could not load seasons', err);
    return null;
  }
  if (!seasons.length) return null;

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
  // rather than a second real fetch of the same season.
  function renderTrack(episodes) {
    track.textContent = '';
    episodes.forEach(function (episode, index) {
      track.appendChild(
        buildEpisodeCard(episode, {
          episodes: episodes,
          index: index,
          onChanged: function () {
            renderTrack(episodes);
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
    getEpisodes(seriesId, season.Id)
      .then(renderTrack)
      .catch(function (err) {
        console.warn('Jellio: could not load episodes', err);
      });
  }

  orderedSeasons.forEach(function (season, index) {
    const tab = el('button', 'jellio-season-tab', season.Name || '');
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', 'false');
    tab.addEventListener('click', function () {
      selectSeason(season, tab);
    });
    tabs.appendChild(tab);
    if (index === 0) selectSeason(season, tab);
  });

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

export async function renderDetail(root, params) {
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-detail';

  const itemId = params.get('id');
  if (!itemId) {
    renderDetailError(root, 'Nothing to show.', null);
    return;
  }

  // Shown the instant this screen starts fetching, not after: a card's
  // own click already navigates here synchronously (components/card.js's
  // own click handler), so the only thing standing between that tap and
  // something visible was this screen's own await below. On a slow
  // connection that gap used to just read as the tap doing nothing.
  renderLoading(root);

  let item;
  try {
    item = await getItemDetails(itemId);
  } catch (err) {
    console.warn('Jellio: could not load item details', err);
    renderDetailError(root, describeNetworkFailure('this title', err), function () {
      renderDetail(root, params);
    });
    return;
  }

  root.textContent = '';

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

  const meta = el('div', 'jellio-detail-meta');
  if (item.Type === 'Episode' && item.PremiereDate) {
    meta.appendChild(el('span', null, new Date(item.PremiereDate).toLocaleDateString()));
  } else if (item.ProductionYear) {
    meta.appendChild(el('span', null, String(item.ProductionYear)));
  }
  const runtime = formatRuntime(item.RunTimeTicks);
  if (runtime) meta.appendChild(el('span', null, runtime));
  if (item.OfficialRating) meta.appendChild(el('span', null, item.OfficialRating));
  if (item.CommunityRating) meta.appendChild(el('span', null, item.CommunityRating.toFixed(1) + ' ★'));
  heroContent.appendChild(meta);

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
  const isSeries = item.Type === 'Series';
  const iconActionClass = 'jellio-detail-icon-action jellio-detail-icon-action-collapsible';
  const actions = el('div', 'jellio-detail-actions jellio-detail-actions-has-more');

  // A series has no video of its own, only its episodes do (each already
  // opens this same screen at its own item id, with its own working Play
  // button), so Change Stream is skipped entirely here rather than
  // pointing at nothing playable; Watchlist/Mark Watched still apply to
  // the series itself. Play itself still belongs here though (real
  // feedback: a series page with none at all, unlike a movie or an
  // episode), just resolved lazily against whichever episode
  // resolveSeriesPlayTarget() above actually decides is next.
  if (!isSeries) {
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

    const targetPromise = resolveSeriesPlayTarget(item.Id).then(function (result) {
      if (result && result.resume) {
        playLabel.textContent = 'Resume S' + result.episode.ParentIndexNumber + ' E' + result.episode.IndexNumber;
      }
      return result;
    });

    playButton.addEventListener('click', function () {
      playButton.disabled = true;
      targetPromise
        .then(function (result) {
          if (result && result.episode) openStreamPicker(result.episode);
        })
        .catch(function (err) {
          console.warn('Jellio: could not resolve series play target', err);
        })
        .finally(function () {
          playButton.disabled = false;
        });
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
  watchlistButton.addEventListener('click', function (event) {
    event.stopPropagation();
    watchlistButton.disabled = true;
    toggleWatchlist(item)
      .then(paintWatchlist)
      .catch(function (err) {
        console.warn('Jellio: could not update watchlist state', err);
      })
      .finally(function () {
        watchlistButton.disabled = false;
      });
  });
  actions.appendChild(watchlistButton);

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
      .then(paintWatched)
      .catch(function (err) {
        console.warn('Jellio: could not update watched state', err);
      })
      .finally(function () {
        watchedButton.disabled = false;
      });
  });
  actions.appendChild(watchedButton);

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
      })
      .finally(function () {
        thumbsUpButton.disabled = false;
      });
  });
  actions.appendChild(thumbsUpButton);

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
      })
      .finally(function () {
        thumbsDownButton.disabled = false;
      });
  });
  actions.appendChild(thumbsDownButton);

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
  if (!isSeries) {
    const changeStreamButton = el('button', iconActionClass);
    changeStreamButton.type = 'button';
    changeStreamButton.setAttribute('aria-label', 'Change Stream');
    changeStreamButton.appendChild(el('span', 'material-icons sync_alt'));
    changeStreamButton.addEventListener('click', function (event) {
      event.stopPropagation();
      openStreamPicker(item, { forceChoice: true });
    });
    actions.appendChild(changeStreamButton);
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
  function handleActionsOutsideClick(event) {
    if (!actions.contains(event.target)) collapseActions();
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
  actions.appendChild(moreButton);

  heroContent.appendChild(actions);

  hero.appendChild(heroContent);
  root.appendChild(hero);

  if (item.Overview) {
    root.appendChild(el('p', 'jellio-detail-overview', item.Overview));
  }

  if (item.Type === 'Series') {
    const seasonsSection = await buildSeasonsSection(canonicalId);
    if (seasonsSection) root.appendChild(seasonsSection);
  }

  const castRow = buildCastRow(item.People);
  if (castRow) root.appendChild(castRow);

  const trailersRow = buildTrailersRow(item.RemoteTrailers);
  if (trailersRow) root.appendChild(trailersRow);
}
