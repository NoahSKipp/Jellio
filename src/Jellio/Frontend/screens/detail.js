// Metadata view for one item: backdrop, title, overview, genres, cast.
// Play hands off to the real native detail route rather than faking a
// button that does nothing: jellyfin-web's own actual playback trigger,
// playbackManager.play() (apps/legacy/controllers/itemDetails/index.js,
// real source, confirmed before writing this), is a plain ES module
// export, never put on window the way ApiClient is, so nothing outside
// jellyfin-web's own bundle can call it directly. Real player chrome for
// this runtime is its own later piece of work, not guessed at here.
import { getItemDetails, getImageUrl } from '../runtime/api.js';
import { navigateTo } from '../runtime/router.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function buildCastRow(people) {
  const cast = (people || []).filter(function (person) {
    return person.Type === 'Actor';
  });
  if (!cast.length) return null;

  const section = el('section', 'jellio-detail-cast');
  section.appendChild(el('h2', 'jellio-row-title', 'Cast'));
  const track = el('div', 'jellio-row-track');
  cast.slice(0, 20).forEach(function (person) {
    const card = el('div', 'jellio-cast-card');
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
    track.appendChild(card);
  });
  section.appendChild(track);
  return section;
}

export async function renderDetail(root, params) {
  root.textContent = '';
  root.className = 'jellio-screen-detail';

  const itemId = params.get('id');
  if (!itemId) return;

  let item;
  try {
    item = await getItemDetails(itemId);
  } catch (err) {
    console.warn('Jellio: could not load item details', err);
    return;
  }

  const backdropTag = item.BackdropImageTags && item.BackdropImageTags[0];
  const hero = el('div', 'jellio-detail-hero');
  if (backdropTag) {
    hero.style.backgroundImage = 'url(' + getImageUrl(itemId, 'Backdrop', { tag: backdropTag, maxWidth: 1600 }) + ')';
  }

  const heroContent = el('div', 'jellio-detail-hero-content');
  heroContent.appendChild(el('h1', 'jellio-detail-title', item.Name || ''));

  const meta = el('div', 'jellio-detail-meta');
  if (item.ProductionYear) meta.appendChild(el('span', null, String(item.ProductionYear)));
  if (item.OfficialRating) meta.appendChild(el('span', null, item.OfficialRating));
  if (item.CommunityRating) meta.appendChild(el('span', null, item.CommunityRating.toFixed(1) + ' ★'));
  heroContent.appendChild(meta);

  if (item.Genres && item.Genres.length) {
    const genres = el('div', 'jellio-detail-genres', item.Genres.join(', '));
    heroContent.appendChild(genres);
  }

  const playButton = el('button', 'jellio-detail-play', 'Play');
  playButton.type = 'button';
  playButton.addEventListener('click', function () {
    navigateTo('#/details?id=' + itemId);
  });
  heroContent.appendChild(playButton);

  hero.appendChild(heroContent);
  root.appendChild(hero);

  if (item.Overview) {
    root.appendChild(el('p', 'jellio-detail-overview', item.Overview));
  }

  const castRow = buildCastRow(item.People);
  if (castRow) root.appendChild(castRow);
}
