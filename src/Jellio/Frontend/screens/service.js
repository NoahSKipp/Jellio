// The page a streaming hub tile opens: every real catalog collection
// matched to that service, one row per collection, with type/genre
// filter chips. Own route (#/service?name=X), not borrowed off a
// library page the way the original codebase's own streamingHub.js had
// to (this runtime owns real routing, no native page to borrow).
import { getCollections, getCollectionItems, collectionKind, getImageUrl } from '../runtime/api.js';
import { groupByService, logoUrl, rowTitle } from '../components/services.js';
import { buildCard } from '../components/card.js';
import { renderLoading, renderRetry } from '../components/networkState.js';
import { navigateTo } from '../runtime/router.js';
import { describeNetworkFailure } from '../runtime/network.js';
import { attachScrollArrows } from '../components/scrollArrows.js';
import { makeRowTitleClickable } from '../components/rowListModal.js';
import { el } from '../runtime/dom.js';

const ROW_LIMIT = 24;
// components/rowListModal.js's own "browse everything": a real full
// depth request for whichever studio hub row a reader actually opened,
// not the same ROW_LIMIT-capped array the row itself already rendered
// from. No real Stremio catalog collection this runtime has ever seen
// comes close to this, generous on purpose rather than tuned to a real
// observed maximum.
const ROW_LIST_LIMIT = 500;

// The hero's own real backdrop: whichever item this service's real
// catalogs actually turned up rates highest, the same "let the real
// data pick it" spirit components/heroCarousel.js's own real candidate
// list already follows, rather than always just row zero's own first
// card. No backdrop of its own anywhere in the whole catalog (a bare
// service with nothing but posters) falls back to a flat elevated
// panel, same real fallback screens/detail.js's own hero already uses.
function pickHeroItem(rows) {
  let best = null;
  rows.forEach(function (row) {
    row.items.forEach(function (item) {
      if (!item.BackdropImageTags || !item.BackdropImageTags[0]) return;
      if (!best || (item.CommunityRating || 0) > (best.CommunityRating || 0)) best = item;
    });
  });
  return best;
}

function buildHeader(service, heroItem) {
  const hero = el('div', 'jellio-service-hero');
  if (heroItem) {
    hero.style.backgroundImage = 'url(' + getImageUrl(heroItem.Id, 'Backdrop', { tag: heroItem.BackdropImageTags[0], maxWidth: 1920 }) + ')';
  }

  const content = el('div', 'jellio-service-hero-content');
  const eyebrow = el('div', 'jellio-service-eyebrow', 'Popular on');
  content.appendChild(eyebrow);

  const heading = el('h1', 'jellio-service-name');
  const word = el('span', 'jellio-service-word', service);
  heading.appendChild(word);
  const logo = document.createElement('img');
  logo.className = 'jellio-service-logo';
  logo.alt = service;
  logo.loading = 'lazy';
  logo.src = logoUrl(service);
  logo.addEventListener('load', function () {
    heading.classList.add('jellio-has-logo');
  });
  logo.addEventListener('error', function () {
    logo.remove();
  });
  heading.appendChild(logo);
  content.appendChild(heading);

  hero.appendChild(content);
  return hero;
}

// Genres discovered from what actually came back, never a fixed list: a
// service's catalogs decide what is on offer.
function topGenres(rows, limit) {
  const counts = {};
  rows.forEach(function (row) {
    row.items.forEach(function (item) {
      (item.Genres || []).forEach(function (g) {
        counts[g] = (counts[g] || 0) + 1;
      });
    });
  });
  return Object.keys(counts)
    .filter(function (g) {
      return counts[g] >= 3;
    })
    .sort(function (a, b) {
      return counts[b] - counts[a];
    })
    .slice(0, limit);
}

function buildChips(genres, onFilter) {
  const chips = [{ key: 'all', label: 'All' }, { key: 'movies', label: 'Movies' }, { key: 'tvshows', label: 'TV Shows' }].concat(
    genres.map(function (g) {
      return { key: 'genre:' + g, label: g };
    }),
  );

  const bar = el('div', 'jellio-service-chips');
  bar.setAttribute('role', 'tablist');
  chips.forEach(function (chip, index) {
    const button = el('button', 'jellio-service-chip' + (index === 0 ? ' jellio-service-chip-active' : ''), chip.label);
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', index === 0 ? 'true' : 'false');
    button.addEventListener('click', function () {
      Array.prototype.forEach.call(bar.children, function (sibling) {
        sibling.classList.remove('jellio-service-chip-active');
        sibling.setAttribute('aria-selected', 'false');
      });
      button.classList.add('jellio-service-chip-active');
      button.setAttribute('aria-selected', 'true');
      onFilter(chip.key);
    });
    bar.appendChild(button);
  });
  return bar;
}

function buildRowSection(row, index) {
  const section = el('section', 'jellio-row jellio-service-row jellio-row-enter');
  section.style.setProperty('--jellio-row-enter-delay', Math.min(index, 6) * 60 + 'ms');
  section.dataset.jellioRowKind = row.kind;
  const titleEl = el('h2', 'jellio-row-title', row.title);
  section.appendChild(titleEl);
  makeRowTitleClickable(titleEl, row.title, row.items, {
    fetchAll: function () {
      return getCollectionItems(row.collection.Id, row.kind, ROW_LIST_LIMIT);
    },
  });

  const trackWrap = el('div', 'jellio-row-track-wrap');
  const track = el('div', 'jellio-row-track');
  row.items.forEach(function (item) {
    const card = buildCard(item);
    card.dataset.jellioGenres = (item.Genres || []).join('|');
    track.appendChild(card);
  });
  trackWrap.appendChild(track);
  section.appendChild(trackWrap);
  // Stashed on the section itself rather than a separate map keyed by
  // it: applyFilter() below already has this exact section in hand
  // every time it needs to re-check whether either arrow still has
  // anywhere left to go, a genre/type filter hiding enough cards to
  // change that real answer without ever touching scrollLeft itself
  // (attachScrollArrows()'s own scroll listener never fires for that).
  section._jellioRefreshArrows = attachScrollArrows(trackWrap, track);
  return section;
}

function applyFilter(rowsMount, filter) {
  Array.prototype.forEach.call(rowsMount.querySelectorAll('.jellio-service-row'), function (section) {
    const kind = section.dataset.jellioRowKind || '';
    const typeMatch = filter === 'all' || filter.indexOf('genre:') === 0 || kind === filter;

    let shown = 0;
    Array.prototype.forEach.call(section.querySelectorAll('.jellio-card'), function (card) {
      const genres = (card.dataset.jellioGenres || '').split('|');
      const genreMatch = filter.indexOf('genre:') !== 0 || genres.indexOf(filter.slice(6)) !== -1;
      const visible = typeMatch && genreMatch;
      card.style.display = visible ? '' : 'none';
      if (visible) shown++;
    });
    // A row filtered down to nothing is noise, not an empty state.
    section.style.display = shown ? '' : 'none';
    if (shown && section._jellioRefreshArrows) section._jellioRefreshArrows();
  });
}

export async function renderService(root, params) {
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-service';

  const service = params.get('name');
  if (!service) return;

  renderLoading(root);

  let collections;
  try {
    collections = await getCollections();
  } catch (err) {
    console.warn('Jellio: could not load streaming hub collections', err);
    renderRetry(root, describeNetworkFailure(service, err), function () {
      renderService(root, params);
    }, { onBack: function () { navigateTo('#/home'); }, backLabel: 'Back to Home' });
    return;
  }

  root.textContent = '';

  const matching = (groupByService(collections)[service] || []).map(function (collection) {
    const kind = collectionKind(collection);
    return { collection: collection, kind: kind, title: rowTitle(collection, service, kind) };
  });

  if (!matching.length) {
    root.appendChild(buildHeader(service, null));
    root.appendChild(el('p', 'jellio-service-empty', 'Nothing imported for ' + service + ' yet.'));
    return;
  }

  renderLoading(root);

  // Not awaited: app.js's own sync() queue only starts the next real
  // navigation once this function's own returned promise resolves, and
  // this fetch is one real request per matched catalog, several on a
  // real streaming hub tile. Awaiting it here meant a reader could not
  // leave a slow-loading service page for anywhere else until every
  // one of those had either resolved or timed out, same real bug
  // screens/library.js's own genre rows and screens/home.js's own
  // catalog rows already document and fix the same way. Unlike those
  // two, the real content this callback builds replaces root's own
  // top level content wholesale rather than filling in a shell this
  // function already returned control past, so a late arrival after
  // the reader has already left this screen needs an explicit guard
  // here, the same real shape screens/player.js's own screenTornDown
  // already uses for its error screen: without it, a slow response
  // still landing after a real navigation elsewhere would wipe out
  // whatever that next screen had already rendered into the same root.
  let tornDown = false;

  const filled = [];
  Promise.all(
    matching.map(function (entry) {
      return getCollectionItems(entry.collection.Id, entry.kind, ROW_LIMIT)
        .then(function (items) {
          if (items.length) filled.push(Object.assign({}, entry, { items: items }));
        })
        .catch(function (err) {
          console.warn('Jellio: could not load service catalog', err);
        });
    }),
  ).then(function () {
    if (tornDown) return;
    root.textContent = '';

    // Every catalog for this service came back empty. Jellyfin's
    // CleanupCollectionAndPlaylistPathsTask empties every Gelato collection
    // on each restart, since their items are virtual and carry no path for
    // it to find, so this is a real state a server sits in, not a bug to
    // paper over with a blank page.
    if (!filled.length) {
      root.appendChild(buildHeader(service, null));
      root.appendChild(
        el(
          'p',
          'jellio-service-empty',
          'Nothing imported for ' +
            service +
            ' yet. Run the Gelato catalog import, and check that the catalogs for this service have Collection enabled.',
        ),
      );
      return;
    }

    root.appendChild(buildHeader(service, pickHeroItem(filled)));
    const rowsMount = el('div', 'jellio-rows');
    root.appendChild(buildChips(topGenres(filled, 10), function (filter) {
      applyFilter(rowsMount, filter);
    }));
    filled.forEach(function (row, index) {
      rowsMount.appendChild(buildRowSection(row, index));
    });
    root.appendChild(rowsMount);
  });

  return function () {
    tornDown = true;
  };
}
