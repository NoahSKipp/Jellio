// Metadata view for one item: backdrop, title, overview, genres, cast.
// Play opens this runtime's own player at #/play, real playback
// (PlaybackInfo negotiation plus a bare <video> element, see
// screens/player.js's own header for why that needed no access to
// jellyfin-web's own playbackManager at all).
import { getItemDetails, getImageUrl, getSeasons, getEpisodes, setFavorite } from '../runtime/api.js';
import { navigateTo } from '../runtime/router.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function buildEpisodeCard(episode) {
  const card = el('div', 'jellio-episode-card');
  const thumbTag =
    (episode.ImageTags && episode.ImageTags.Primary) ||
    (episode.ParentThumbImageTag && episode.ParentThumbImageTag);
  const thumb = el('div', 'jellio-episode-thumb');
  if (thumbTag) {
    thumb.style.backgroundImage =
      'url(' + getImageUrl(episode.Id, 'Primary', { tag: thumbTag, maxWidth: 500 }) + ')';
  }
  if (episode.IndexNumber != null) {
    thumb.appendChild(el('span', 'jellio-episode-badge', 'E' + episode.IndexNumber));
  }
  card.appendChild(thumb);
  card.appendChild(el('div', 'jellio-episode-title', episode.Name || ''));
  if (episode.Overview) {
    card.appendChild(el('div', 'jellio-episode-overview', episode.Overview));
  }
  card.addEventListener('click', function () {
    navigateTo('#/item?id=' + episode.Id);
  });
  return card;
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

  const section = el('section', 'jellio-detail-seasons');
  section.appendChild(el('h2', 'jellio-row-title', 'Episodes'));

  const tabs = el('div', 'jellio-season-tabs');
  const track = el('div', 'jellio-episode-track');
  section.appendChild(tabs);
  section.appendChild(track);

  function selectSeason(season, tabButton) {
    Array.prototype.forEach.call(tabs.children, function (child) {
      child.classList.remove('jellio-season-tab-selected');
    });
    tabButton.classList.add('jellio-season-tab-selected');
    track.textContent = '';
    getEpisodes(seriesId, season.Id)
      .then(function (episodes) {
        episodes.forEach(function (episode) {
          track.appendChild(buildEpisodeCard(episode));
        });
      })
      .catch(function (err) {
        console.warn('Jellio: could not load episodes', err);
      });
  }

  seasons.forEach(function (season, index) {
    const tab = el('button', 'jellio-season-tab', season.Name || '');
    tab.type = 'button';
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

  const actions = el('div', 'jellio-detail-actions');

  // A series has no video of its own, only its episodes do (each already
  // opens this same screen at its own item id, with its own working Play
  // button), so this one is skipped entirely here rather than pointing at
  // nothing playable.
  if (item.Type !== 'Series') {
    const playButton = el('button', 'jellio-detail-play', 'Play');
    playButton.type = 'button';
    playButton.addEventListener('click', function () {
      navigateTo('#/play?id=' + itemId);
    });
    actions.appendChild(playButton);
  }

  const isFavorite = !!(item.UserData && item.UserData.IsFavorite);
  const favoriteButton = el(
    'button',
    'jellio-detail-favorite' + (isFavorite ? ' jellio-detail-favorite-active' : ''),
    isFavorite ? 'In Favorites' : 'Add to Favorites',
  );
  favoriteButton.type = 'button';
  favoriteButton.addEventListener('click', function () {
    const nextState = !favoriteButton.classList.contains('jellio-detail-favorite-active');
    favoriteButton.disabled = true;
    setFavorite(itemId, nextState)
      .then(function (userData) {
        const active = !!(userData && userData.IsFavorite);
        favoriteButton.classList.toggle('jellio-detail-favorite-active', active);
        favoriteButton.textContent = active ? 'In Favorites' : 'Add to Favorites';
      })
      .catch(function (err) {
        console.warn('Jellio: could not update favorite state', err);
      })
      .finally(function () {
        favoriteButton.disabled = false;
      });
  });
  actions.appendChild(favoriteButton);

  heroContent.appendChild(actions);

  hero.appendChild(heroContent);
  root.appendChild(hero);

  if (item.Overview) {
    root.appendChild(el('p', 'jellio-detail-overview', item.Overview));
  }

  if (item.Type === 'Series') {
    const seasonsSection = await buildSeasonsSection(itemId);
    if (seasonsSection) root.appendChild(seasonsSection);
  }

  const castRow = buildCastRow(item.People);
  if (castRow) root.appendChild(castRow);
}
