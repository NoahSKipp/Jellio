// First real screen, proof of the whole architecture end to end: its own
// markup, fed entirely by runtime/api.js's own fetch calls, no native DOM
// read or waited on.
import { getCurrentUser, getUserViews, getResumeItems, getLatestItems, getFavoriteItems, getCollections } from '../runtime/api.js';
import { buildCard } from '../components/card.js';
import { groupByService, logoSlug } from '../components/services.js';
import { buildHeroCarousel } from '../components/heroCarousel.js';
import { navigateTo } from '../runtime/router.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// The logo is requested optimistically and the name sits behind it in
// CSS: onerror is the only way to know a file does not exist, and a
// service with no icon shows its name immediately rather than an empty
// tile flashing first. Same technique the original codebase's own
// streamingHub.js uses.
function buildHubTile(name) {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'jellio-hub-tile';
  tile.title = name;

  const label = document.createElement('span');
  label.className = 'jellio-hub-tile-name';
  label.textContent = name;
  tile.appendChild(label);

  const logo = document.createElement('img');
  logo.className = 'jellio-hub-tile-logo';
  logo.alt = name;
  logo.loading = 'lazy';
  logo.src = '/Jellio/frontend/img/services/' + logoSlug(name) + '.svg';
  logo.addEventListener('load', function () {
    tile.classList.add('jellio-has-logo');
  });
  logo.addEventListener('error', function () {
    logo.remove();
  });
  tile.appendChild(logo);

  tile.addEventListener('click', function () {
    navigateTo('#/service?name=' + encodeURIComponent(name));
  });
  return tile;
}

async function buildHubStrip() {
  let collections;
  try {
    collections = await getCollections();
  } catch (err) {
    console.warn('Jellio: could not load streaming hub collections', err);
    return null;
  }
  const groups = groupByService(collections);
  const names = Object.keys(groups).sort();
  if (!names.length) return null;

  const section = el('section', 'jellio-hub');
  section.appendChild(el('h2', 'jellio-row-title', 'Your streaming'));
  const tiles = el('div', 'jellio-hub-tiles');
  names.forEach(function (name) {
    tiles.appendChild(buildHubTile(name));
  });
  section.appendChild(tiles);
  return section;
}

function buildRow(title, items) {
  if (!items || !items.length) return null;
  const section = el('section', 'jellio-row');
  section.appendChild(el('h2', 'jellio-row-title', title));
  const track = el('div', 'jellio-row-track');
  items.forEach(function (item) {
    track.appendChild(buildCard(item));
  });
  section.appendChild(track);
  return section;
}

// #/home?tab=1, the same hash the sidebar's own Favorites link and the
// original Jellio codebase's own NAV_LINKS both already point at, rather
// than a separate #/favorites route.
async function renderFavorites(root) {
  const header = el('header', 'jellio-home-header');
  header.appendChild(el('h1', 'jellio-home-greeting', 'Favorites'));
  root.appendChild(header);

  const grid = el('div', 'jellio-library-grid');
  root.appendChild(grid);

  try {
    const items = await getFavoriteItems();
    items.forEach(function (item) {
      grid.appendChild(buildCard(item));
    });
  } catch (err) {
    console.warn('Jellio: could not load favorites', err);
  }
}

export async function renderHome(root, params) {
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-home';

  if (params && params.get('tab') === '1') {
    await renderFavorites(root);
    return undefined;
  }

  const hero = buildHeroCarousel();
  root.appendChild(hero.element);

  const header = el('header', 'jellio-home-header');
  const [user] = await Promise.allSettled([getCurrentUser()]);
  header.appendChild(
    el(
      'h1',
      'jellio-home-greeting',
      user.status === 'fulfilled' && user.value ? 'Welcome back, ' + user.value.Name : 'Welcome back',
    ),
  );
  root.appendChild(header);

  const rows = el('div', 'jellio-rows');
  root.appendChild(rows);

  const [resumeResult, viewsResult] = await Promise.allSettled([
    getResumeItems(20),
    getUserViews(),
  ]);

  if (resumeResult.status === 'fulfilled') {
    const row = buildRow('Continue Watching', resumeResult.value);
    if (row) rows.appendChild(row);
  }

  const hub = await buildHubStrip();
  if (hub) rows.appendChild(hub);

  if (viewsResult.status === 'fulfilled') {
    const views = viewsResult.value.slice(0, 6);
    const latestByView = await Promise.allSettled(
      views.map(function (view) {
        return getLatestItems(view.Id, 16);
      }),
    );
    latestByView.forEach(function (result, index) {
      if (result.status === 'fulfilled') {
        const row = buildRow('Latest in ' + views[index].Name, result.value);
        if (row) rows.appendChild(row);
      }
    });
  }

  return hero.destroy;
}
