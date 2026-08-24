// Shared item card, used by every screen that renders a poster grid or row
// (home's own rows, the library grid). One definition so a later visual
// change (a hover state, a progress bar) only has one place to happen.
import { getImageUrl } from '../runtime/api.js';
import { navigateTo } from '../runtime/router.js';
import { attachCardOptionsTrigger } from './cardOptionsMenu.js';

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

export function buildCard(item, options) {
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
    img.src = getImageUrl(item.Id, 'Primary', { tag: imageTag, maxWidth: 400 });
    img.alt = item.Name || '';
    img.loading = 'lazy';
    imageWrap.appendChild(img);
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'jellio-card-image jellio-card-image-empty';
    imageWrap.appendChild(placeholder);
  }

  paintCardState(imageWrap, item);

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
    function (updatedItem) {
      paintCardState(imageWrap, updatedItem);
    },
    options,
  );

  return card;
}
