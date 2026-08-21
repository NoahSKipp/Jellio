// Shared item card, used by every screen that renders a poster grid or row
// (home's own rows, the library grid). One definition so a later visual
// change (a hover state, a progress bar) only has one place to happen.
import { getImageUrl } from '../runtime/api.js';
import { navigateTo } from '../runtime/router.js';

export function buildCard(item) {
  const card = document.createElement('div');
  card.className = 'jellio-card';
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', item.Name || '');

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

  card.appendChild(imageWrap);

  const title = document.createElement('div');
  title.className = 'jellio-card-title';
  title.textContent = item.Name || '';
  card.appendChild(title);

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

  return card;
}
