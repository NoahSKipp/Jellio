// Shared item card, used by every screen that renders a poster grid or row
// (home's own rows, the library grid). One definition so a later visual
// change (a hover state, a progress bar) only has one place to happen.
import { getImageUrl } from '../runtime/api.js';
import { navigateTo } from '../runtime/router.js';

export function buildCard(item) {
  const card = document.createElement('div');
  card.className = 'jellio-card';

  const imageTag = item.ImageTags && item.ImageTags.Primary;
  if (imageTag) {
    const img = document.createElement('img');
    img.className = 'jellio-card-image';
    img.src = getImageUrl(item.Id, 'Primary', { tag: imageTag, maxWidth: 400 });
    img.alt = item.Name || '';
    img.loading = 'lazy';
    card.appendChild(img);
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'jellio-card-image jellio-card-image-empty';
    card.appendChild(placeholder);
  }

  const title = document.createElement('div');
  title.className = 'jellio-card-title';
  title.textContent = item.Name || '';
  card.appendChild(title);

  // No detail screen built yet (that is its own, later piece of this
  // rebuild), so a card click falls back to the same real route native
  // jellyfin-web's own item detail page already answers to.
  card.addEventListener('click', function () {
    navigateTo('#/details?id=' + item.Id);
  });

  return card;
}
