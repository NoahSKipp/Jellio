// The page a streaming hub tile opens: every real catalog collection
// matched to that service, one row per collection, with type/genre
// filter chips. Own route (#/service?name=X), not borrowed off a
// library page the way the original codebase's own streamingHub.js had
// to (this runtime owns real routing, no native page to borrow).
import { getCollections, getCollectionItems, collectionKind } from '../runtime/api.js';
import { groupByService, logoSlug, rowTitle } from '../components/services.js';
import { buildCard } from '../components/card.js';

const ROW_LIMIT = 24;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function buildHeader(service, rowCount) {
  const header = el('div', 'jellio-service-header');
  const eyebrow = el('div', 'jellio-service-eyebrow', 'Popular on');
  header.appendChild(eyebrow);

  const heading = el('h1', 'jellio-service-name');
  const word = el('span', 'jellio-service-word', service);
  heading.appendChild(word);
  const logo = document.createElement('img');
  logo.className = 'jellio-service-logo';
  logo.alt = service;
  logo.loading = 'lazy';
  logo.src = '/Jellio/frontend/img/services/' + logoSlug(service) + '.svg';
  logo.addEventListener('load', function () {
    heading.classList.add('jellio-has-logo');
  });
  logo.addEventListener('error', function () {
    logo.remove();
  });
  heading.appendChild(logo);
  header.appendChild(heading);

  if (rowCount) {
    const blurb = el(
      'p',
      'jellio-service-blurb',
      rowCount === 1 ? 'One catalog imported from ' + service + '.' : rowCount + ' catalogs imported from ' + service + '.',
    );
    header.appendChild(blurb);
  }
  return header;
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

function buildRowSection(row) {
  const section = el('section', 'jellio-row jellio-service-row');
  section.dataset.jellioRowKind = row.kind;
  section.appendChild(el('h2', 'jellio-row-title', row.title));
  const track = el('div', 'jellio-row-track');
  row.items.forEach(function (item) {
    const card = buildCard(item);
    card.dataset.jellioGenres = (item.Genres || []).join('|');
    track.appendChild(card);
  });
  section.appendChild(track);
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
  });
}

export async function renderService(root, params) {
  root.textContent = '';
  root.className = 'jellio-screen-service';

  const service = params.get('name');
  if (!service) return;

  let collections;
  try {
    collections = await getCollections();
  } catch (err) {
    console.warn('Jellio: could not load streaming hub collections', err);
    return;
  }

  const matching = (groupByService(collections)[service] || []).map(function (collection) {
    const kind = collectionKind(collection);
    return { collection: collection, kind: kind, title: rowTitle(collection, service, kind) };
  });

  if (!matching.length) {
    root.appendChild(buildHeader(service, 0));
    root.appendChild(el('p', 'jellio-service-empty', 'Nothing imported for ' + service + ' yet.'));
    return;
  }

  const filled = [];
  await Promise.all(
    matching.map(function (entry) {
      return getCollectionItems(entry.collection.Id, entry.kind, ROW_LIMIT)
        .then(function (items) {
          if (items.length) filled.push(Object.assign({}, entry, { items: items }));
        })
        .catch(function (err) {
          console.warn('Jellio: could not load service catalog', err);
        });
    }),
  );

  // Every catalog for this service came back empty. Jellyfin's
  // CleanupCollectionAndPlaylistPathsTask empties every Gelato collection
  // on each restart, since their items are virtual and carry no path for
  // it to find, so this is a real state a server sits in, not a bug to
  // paper over with a blank page.
  if (!filled.length) {
    root.appendChild(buildHeader(service, 0));
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

  root.appendChild(buildHeader(service, filled.length));
  const rowsMount = el('div', 'jellio-rows');
  root.appendChild(buildChips(topGenres(filled, 10), function (filter) {
    applyFilter(rowsMount, filter);
  }));
  filled.forEach(function (row) {
    rowsMount.appendChild(buildRowSection(row));
  });
  root.appendChild(rowsMount);
}
