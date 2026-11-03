import { t, translateGenre } from '../runtime/i18n.js';
import { withoutStaleEpisodes } from '../runtime/continueWatching.js';
import { createRowGate } from '../runtime/rowGate.js';
import { getCurrentUser, getResumeItems, getNextUp, getWatchlistItems, getGrouplistItems, getCollections, collectionKind, getCollectionItems, discoverGenres, getGenreItems, getGenreItemsPage, isAnimeCollection, getCalendarEntries, setUpcomingHidden, getImageUrl, getAnimeIds, withoutAnime, isHomeRowCacheEnabled, markHomeRowPainted } from '../runtime/api.js';
import { getContinueReading, getContinueListening } from '../runtime/apiBooks.js';
import { getCommunityWatching, invalidateCommunityWatchingCache } from '../runtime/apiSocial.js';
import {
  isCommunityRowEnabled,
  getCommunityExcludedUsers,
  getSelectedGenres,
} from '../runtime/recommendationSettings.js';
import { streamRecommendationRows, titleKey } from '../runtime/recommend.js';
import { buildCard } from '../components/card.js';
import { appendCardsLazily } from '../components/lazyGrid.js';
import { buildRow } from '../components/row.js';
import { attachScrollArrows } from '../components/scrollArrows.js';
import { groupByService, logoUrl, serviceOf } from '../components/services.js';
import { buildHeroCarousel } from '../components/heroCarousel.js';
import { pickWarmupItems } from '../runtime/streamWarmup.js';
import { warmItem, warmItems } from '../runtime/warmQueue.js';
import { buildHomeSkeleton } from '../components/homeSkeleton.js';
import {
  wrapRowForCustomization,
  applyHomeCustomization,
  buildHomeCustomizeBar,
  updateHomeCustomizeBar,
  resetHomeCustomization,
} from '../components/homeCustomizer.js';
import { navigateTo } from '../runtime/router.js';
import { attachCardOptionsTrigger, animateCardRemoval } from '../components/cardOptionsMenu.js';
import { showToast } from '../components/toast.js';
import { isGrouplistEnabled } from '../runtime/grouplistSettings.js';
import { onUserDataChange } from '../runtime/syncPlay.js';
import { el } from '../runtime/dom.js';

const CATALOG_ROW_LIMIT = 24;
const MAX_CATALOG_ROWS = 8;
const MIN_CATALOG_ITEMS = 3;
const MAX_ANIME_CATALOG_ROWS = 0;
const GENRE_ROWS = 4;
const GENRE_ROW_LIMIT = 24;

// Catalogs worth leading with, in this order. Anything unlisted keeps
// its own alphabetical order behind them.
const LEAD = ['trending', 'popular', 'top rated', 'new releases'];
const GENERIC_NAME = /^(trending|popular|top rated)$/i;

function leadIndex(name) {
  const index = LEAD.indexOf(String(name || '').toLowerCase());
  return index === -1 ? LEAD.length : index;
}

function dedupe(items, seen) {
  const kept = [];
  items.forEach(function (item) {
    if (seen[item.Id] || seen[titleKey(item)]) return;
    seen[item.Id] = true;
    seen[titleKey(item)] = true;
    kept.push(item);
  });
  return kept;
}

function titleFor(name, kind) {
  if (!GENERIC_NAME.test(name)) return name;
  if (kind === 'tvshows') return name + ' Series';
  if (kind === 'movies') return name + ' Movies';
  return name;
}

function chooseCatalogs(collections) {
  let usable = collections.filter(function (collection) {
    if (serviceOf(collection.Name)) return false;
    return (collection.ChildCount || 0) >= MIN_CATALOG_ITEMS;
  });

  usable.sort(function (a, b) {
    const diff = leadIndex(a.Name) - leadIndex(b.Name);
    if (diff) return diff;
    return (b.ChildCount || 0) - (a.ChildCount || 0);
  });

  let animeSeen = 0;
  usable = usable.filter(function (collection) {
    if (!isAnimeCollection(collection)) return true;
    animeSeen++;
    return animeSeen <= MAX_ANIME_CATALOG_ROWS;
  });

  return usable.slice(0, MAX_CATALOG_ROWS);
}

function buildCatalogRow(entry, seen) {
  const row = buildRow(entry.title, dedupe(entry.items, seen), null, {
    fetchPage: function (start, size) {
      return Promise.all([getCollectionItems(entry.id, entry.kind, size, start), getAnimeIds()]).then(function (results) {
        return withoutAnime(results[0], results[1]);
      });
    },
  });
  return row ? wrapRowForCustomization(row, 'catalog:' + entry.id) : null;
}

const HOME_GENRES_KEY = 'jellioHomeGenres';
const HOME_GENRES_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function storedHomeGenres() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(HOME_GENRES_KEY) || 'null');
    if (stored && Array.isArray(stored.genres) && stored.genres.length && Date.now() - stored.at < HOME_GENRES_MAX_AGE_MS) {
      return stored.genres;
    }
  } catch (err) {
    // Unreadable or blocked storage: discover them instead.
  }
  return null;
}

function chooseHomeGenres() {
  const selected = getSelectedGenres();
  if (Array.isArray(selected) && selected.length > 0) return Promise.resolve(selected);
  const discovered = discoverGenres(null, 'Movie,Series', GENRE_ROWS).then(function (genres) {
    if (genres.length) {
      try {
        window.localStorage.setItem(HOME_GENRES_KEY, JSON.stringify({ at: Date.now(), genres: genres }));
      } catch (err) {
        // Not kept; discovered again next time.
      }
    }
    return genres;
  });
  const stored = storedHomeGenres();
  if (stored) {
    discovered.catch(function () {});
    return Promise.resolve(stored);
  }
  return discovered;
}

function buildGenreRow(entry, seen) {
  const row = buildRow(translateGenre(entry.title), dedupe(entry.items, seen), null, {
    fetchPage: function (start, size) {
      return Promise.all([getGenreItemsPage(null, 'Movie,Series', entry.title, start, size), getAnimeIds()]).then(function (results) {
        return withoutAnime(results[0], results[1]);
      });
    },
  });
  return row ? wrapRowForCustomization(row, 'genre:' + entry.title) : null;
}

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
  logo.src = logoUrl(name);
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

function buildHubStrip(collections) {
  const groups = groupByService(collections);
  const names = Object.keys(groups).sort();
  if (!names.length) return null;

  const section = el('section', 'jellio-hub');
  section.appendChild(el('h2', 'jellio-row-title', t('home_studio_hubs')));
  const tilesWrap = el('div', 'jellio-row-track-wrap');
  const tiles = el('div', 'jellio-hub-tiles');
  names.forEach(function (name) {
    tiles.appendChild(buildHubTile(name));
  });
  tilesWrap.appendChild(tiles);
  section.appendChild(tilesWrap);
  attachScrollArrows(tilesWrap, tiles);
  return section;
}

// Everything the Calendar screen used to list lives in this row now.
const COMING_SOON_LIMIT = 60;

function comingSoonKindLabel(entry) {
  if (entry.Kind === 'episode') {
    return entry.Detail ? t('calendar_new_episode') + ' · ' + entry.Detail : t('calendar_new_episode');
  }
  return t('calendar_digital_release');
}

function comingSoonDateLabel(entry) {
  const date = new Date(entry.Date);
  const diffDays = Math.round((date - new Date()) / (24 * 60 * 60 * 1000));
  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays < 7) return 'In ' + diffDays + ' days';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function buildComingSoonCard(entry) {
  const card = document.createElement('div');
  card.className = 'jellio-card jellio-coming-soon-card';
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', entry.Name);
  card.addEventListener('click', function () {
    navigateTo('#/item?id=' + entry.ItemId);
  });
  card.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      navigateTo('#/item?id=' + entry.ItemId);
    }
  });

  const imageWrap = el('div', 'jellio-card-image-wrap');
  const img = document.createElement('img');
  img.className = 'jellio-card-image';
  img.src = getImageUrl(entry.ItemId, 'Primary', { maxWidth: 400, quality: 85 });
  img.alt = '';
  img.loading = 'lazy';
  imageWrap.appendChild(img);
  imageWrap.appendChild(el('div', 'jellio-coming-soon-date', comingSoonDateLabel(entry)));
  card.appendChild(imageWrap);

  card.appendChild(el('div', 'jellio-card-title', entry.Name));
  card.appendChild(el('div', 'jellio-card-subtitle', comingSoonKindLabel(entry)));

  // Right click or a long press: details, or take the title out of Upcoming.
  attachCardOptionsTrigger(card, { Id: entry.ItemId, Name: entry.Name }, null, {
    onlyExtra: true,
    extraOptions: [
      {
        label: t('menu_go_to_details'),
        icon: 'info',
        onClick: function () {
          navigateTo('#/item?id=' + entry.ItemId);
        },
      },
      {
        label: t('menu_remove_upcoming'),
        icon: 'event_busy',
        onClick: function () {
          const track = card.parentNode;
          const next = card.nextSibling;
          setUpcomingHidden(entry.ItemId, true)
            .then(function () {
              animateCardRemoval(card);
              showToast(t('toast_removed_upcoming', { name: entry.Name }), function () {
                setUpcomingHidden(entry.ItemId, false)
                  .then(function () {
                    card.style.visibility = '';
                    if (track) track.insertBefore(card, next && next.parentNode === track ? next : null);
                  })
                  .catch(function () {});
              });
            })
            .catch(function (err) {
              console.warn('Jellio: could not remove from Upcoming', err);
              showToast(t('toast_remove_upcoming_error'));
            });
        },
      },
    ],
  });

  return card;
}

async function buildComingSoonRow() {
  let entries = [];
  try {
    // Built from the reader's own Watchlist, so anime they follow stays in
    // (the Calendar this row replaced never left it out either).
    entries = (await getCalendarEntries()) || [];
  } catch (err) {
    console.warn('Jellio: could not load Coming Soon', err);
    return null;
  }
  if (!entries.length) return null;

  const section = el('section', 'jellio-row');
  section.appendChild(el('h2', 'jellio-row-title', t('home_coming_soon')));
  const trackWrap = el('div', 'jellio-row-track-wrap');
  const track = el('div', 'jellio-row-track');
  entries.slice(0, COMING_SOON_LIMIT).forEach(function (entry) {
    track.appendChild(buildComingSoonCard(entry));
  });
  trackWrap.appendChild(track);
  section.appendChild(trackWrap);
  attachScrollArrows(trackWrap, track);
  return section;
}

function buildWatchlistSection(title, items) {
  if (!items.length) return null;
  const section = el('section', 'jellio-row');
  section.appendChild(el('h2', 'jellio-row-title', title));
  const grid = el('div', 'jellio-library-grid');
  section.appendChild(grid);
  appendCardsLazily(grid, items, buildCard);
  return section;
}

function buildListsHeader(activeList) {
  const header = el('header', 'jellio-home-header');
  if (!isGrouplistEnabled()) {
    header.appendChild(el('h1', 'jellio-home-greeting', t('home_watchlist')));
    return header;
  }

  const toggle = el('div', 'jellio-lists-toggle');
  const watchlistTab = el('button', 'jellio-lists-toggle-tab', t('home_watchlist'));
  watchlistTab.type = 'button';
  watchlistTab.classList.toggle('jellio-lists-toggle-tab-active', activeList !== 'group');
  watchlistTab.addEventListener('click', function () {
    navigateTo('#/home?tab=1');
  });
  const grouplistTab = el('button', 'jellio-lists-toggle-tab', t('settings_grouplist_label'));
  grouplistTab.type = 'button';
  grouplistTab.classList.toggle('jellio-lists-toggle-tab-active', activeList === 'group');
  grouplistTab.addEventListener('click', function () {
    navigateTo('#/home?tab=1&list=group');
  });
  toggle.appendChild(watchlistTab);
  toggle.appendChild(grouplistTab);
  header.appendChild(toggle);
  return header;
}

async function renderWatchlist(root, activeList) {
  root.appendChild(buildListsHeader(activeList));

  const isGroup = activeList === 'group' && isGrouplistEnabled();
  const emptyMessage = isGroup ? 'Nothing on your Grouplist yet.' : 'Nothing on your watchlist yet.';

  const skeleton = buildHomeSkeleton(3);
  root.appendChild(skeleton);

  try {
    const items = await (isGroup ? getGrouplistItems() : getWatchlistItems());
    skeleton.remove();
    const movies = items.filter(function (item) {
      return item.Type === 'Movie';
    });
    const series = items.filter(function (item) {
      return item.Type === 'Series';
    });

    const movieSection = buildWatchlistSection('Movies', movies);
    if (movieSection) root.appendChild(movieSection);
    const seriesSection = buildWatchlistSection('Series', series);
    if (seriesSection) root.appendChild(seriesSection);

    if (!movieSection && !seriesSection) {
      root.appendChild(el('p', 'jellio-service-empty', emptyMessage));
    }
  } catch (err) {
    skeleton.remove();
    console.warn('Jellio: could not load ' + (isGroup ? 'grouplist' : 'watchlist'), err);
  }
}

let cheapSectionsPromise = null;

const WARMUP_COUNT = 6;
let homeWarmupIds = [];

let expensiveSectionsPromise = null;
let cheapBuilt = [];
let expensiveBuilt = [];

const EXPENSIVE_ORDER_BASE = 1000;

export function invalidateHomeSections() {
  cheapSectionsPromise = null;
  cheapBuilt = [];
}

export function invalidateAllHomeSections() {
  invalidateHomeSections();
  invalidateCommunityWatchingCache();
  expensiveSectionsPromise = null;
  expensiveBuilt = [];
}

const PERSONAL_ROW_CLASSES = ['personal', 'user', 'latest', 'watchlist'];
const rowCacheRefreshers = new Set();
let rowCacheRefreshTimer = null;
let rowCacheRefreshAll = false;

if (typeof document !== 'undefined') {
  document.addEventListener('jellio:rowcache-change', function (event) {
    const detail = (event && event.detail) || {};
    const classes = detail.classes || [];
    if (
      detail.type === 'wipe' ||
      classes.some(function (cls) {
        return PERSONAL_ROW_CLASSES.indexOf(cls) === -1;
      })
    ) {
      rowCacheRefreshAll = true;
    }
    window.clearTimeout(rowCacheRefreshTimer);
    rowCacheRefreshTimer = window.setTimeout(function () {
      const all = rowCacheRefreshAll;
      rowCacheRefreshAll = false;
      if (all) invalidateAllHomeSections();
      else invalidateHomeSections();
      rowCacheRefreshers.forEach(function (refresh) {
        refresh(all);
      });
    }, 400);
  });
}

let sectionListeners = [];

function notifySections(newSections) {
  sectionListeners.forEach(function (listener) {
    try {
      newSections.forEach(listener);
    } catch (err) {
      console.warn('Jellio: home section listener failed', err);
    }
  });
}

function settle(promise) {
  return promise.then(
    function (value) {
      return { status: 'fulfilled', value: value };
    },
    function (reason) {
      return { status: 'rejected', reason: reason };
    },
  );
}

async function buildCheapSections() {
  const built = [];
  cheapBuilt = built;

  const ORDER = {
    'continue-watching': 0,
    'continue-reading': 1,
    'continue-listening': 2,
    'up-next': 3,
    'coming-soon': 4,
    'studio-hubs': 5,
  };

  function push(section, key) {
    if (!section) return;
    section.dataset.jellioHomeOrder = String(ORDER[key] !== undefined ? ORDER[key] : built.length);
    built.push(section);
    notifySections([section]);
  }

  const nextUpResult = settle(getNextUp(20));
  const resume = Promise.all([settle(getResumeItems(20)), nextUpResult]).then(function (results) {
    const result = results[0];
    if (result.status === 'fulfilled') {
      const nextUpItems = results[1].status === 'fulfilled' ? results[1].value : [];
      const items = withoutStaleEpisodes(result.value, nextUpItems);
      homeWarmupIds = pickWarmupItems([items, nextUpItems], WARMUP_COUNT);
      const row = buildRow(t('home_continue_watching'), items, { continueWatching: true });
      if (row) push(wrapRowForCustomization(row, 'continue-watching'), 'continue-watching');
    }
  });

  const reading = settle(getContinueReading(20)).then(function (result) {
    if (result.status === 'fulfilled') {
      const row = buildRow(t('home_continue_reading'), result.value, { openReader: true });
      if (row) push(wrapRowForCustomization(row, 'continue-reading'), 'continue-reading');
    }
  });

  const listening = settle(getContinueListening(20)).then(function (result) {
    if (result.status === 'fulfilled') {
      const row = buildRow(t('home_continue_listening'), result.value, { openReader: true });
      if (row) push(wrapRowForCustomization(row, 'continue-listening'), 'continue-listening');
    }
  });

  const nextUp = nextUpResult.then(function (result) {
    if (result.status === 'fulfilled') {
      const row = buildRow(t('home_next_up'), result.value, { upNext: true });
      if (row) push(wrapRowForCustomization(row, 'up-next'), 'up-next');
    }
  });

  const comingSoon = settle(buildComingSoonRow()).then(function (result) {
    if (result.status === 'fulfilled' && result.value) {
      push(wrapRowForCustomization(result.value, 'coming-soon'), 'coming-soon');
    }
  });

  let collections = null;
  const collectionsJob = settle(getCollections()).then(function (result) {
    collections = result.status === 'fulfilled' ? result.value : null;
    if (collections) {
      const hub = buildHubStrip(collections);
      if (hub) push(wrapRowForCustomization(hub, 'studio-hubs'), 'studio-hubs');
    }
  });

  await Promise.all([resume, reading, listening, nextUp, comingSoon, collectionsJob]);

  built.sort(function (a, b) {
    return Number(a.dataset.jellioHomeOrder || 0) - Number(b.dataset.jellioHomeOrder || 0);
  });

  return { sections: built.slice(), collections: collections };
}

const EXPENSIVE_SLOTS = { recommendations: 0, community: 15, catalogs: 200, genres: 300 };

async function buildExpensiveSections() {
  const built = [];
  expensiveBuilt = built;
  const seen = {};
  const animeIdsPromise = getAnimeIds();
  const rowGate = createRowGate(2);

  function place(section, slot) {
    if (!section) return;
    section.dataset.jellioHomeOrder = String(EXPENSIVE_ORDER_BASE + slot);
    built.push(section);
    notifySections([section]);
  }

  // Never awaited: a slow community lookup can't hold the other rows up.
  if (isCommunityRowEnabled()) {
    Promise.all([getCommunityWatching(getCommunityExcludedUsers()), animeIdsPromise])
      .then(function (results) {
        // Not deduped against the other rows: it lands after them and would
        // usually come out empty, and the watchers make it a different row.
        const valid = dedupe(withoutAnime(results[0] || [], results[1]), {});
        if (!valid.length) return;
        const row = buildRow(t('home_community_watching'), valid);
        if (row) place(wrapRowForCustomization(row, 'rec:What Others Are Watching'), EXPENSIVE_SLOTS.community);
      })
      .catch(function (err) {
        console.warn('Jellio: could not load community watching row', err);
      });
  }

  // Each recommendation row goes up as soon as its own data arrives.
  const recommendations = animeIdsPromise
    .then(function (animeIds) {
      return streamRecommendationRows(seen, function (spec, slot) {
        const row = buildRow(spec.title, withoutAnime(spec.items, animeIds));
        if (row) place(wrapRowForCustomization(row, 'rec:' + spec.title), EXPENSIVE_SLOTS.recommendations + slot);
      });
    })
    .catch(function (err) {
      console.warn('Jellio: could not load recommendation rows', err);
    })
    .finally(function () {
      rowGate.open();
    });

  const catalogs = getCollections()
    .then(function (collections) {
      return Promise.all(
        chooseCatalogs(collections).map(function (collection, index) {
          const kind = collectionKind(collection);
          const slot = EXPENSIVE_SLOTS.catalogs + index;
          return Promise.all([rowGate(slot, () => getCollectionItems(collection.Id, kind, CATALOG_ROW_LIMIT)), animeIdsPromise])
            .then(function (results) {
              const entry = { id: collection.Id, kind: kind, title: titleFor(collection.Name, kind), items: withoutAnime(results[0], results[1]) };
              place(buildCatalogRow(entry, seen), slot);
            })
            .catch(function () {});
        }),
      );
    })
    .catch(function (err) {
      console.warn('Jellio: could not load catalog rows', err);
    });

  const genres = chooseHomeGenres()
    .then(function (list) {
      return Promise.all(
        list.map(function (genre, index) {
          const slot = EXPENSIVE_SLOTS.genres + index;
          return Promise.all([rowGate(slot, () => getGenreItems(null, 'Movie,Series', genre, GENRE_ROW_LIMIT)), animeIdsPromise])
            .then(function (results) {
              place(buildGenreRow({ title: genre, items: withoutAnime(results[0], results[1]) }, seen), slot);
            })
            .catch(function () {});
        }),
      );
    })
    .catch(function (err) {
      console.warn('Jellio: could not load home genre rows', err);
    });

  await Promise.all([recommendations, catalogs, genres]);
  // The live list: a community row that turns up later is in it too.
  return built;
}

export function preloadHomeSections() {
  if (!cheapSectionsPromise) {
    cheapSectionsPromise = buildCheapSections().catch(function (err) {
      console.warn('Jellio: could not build home sections', err);
      cheapSectionsPromise = null;
      return { sections: [], collections: null };
    });
    // Pre-warm the community watching cache in the background so it is ready when the reader scrolls down
    if (isCommunityRowEnabled()) {
      getCommunityWatching(getCommunityExcludedUsers()).catch(function () {});
    }
  }
  if (isHomeRowCacheEnabled()) {
    return cheapSectionsPromise.then(function (result) {
      return result.sections.concat(expensiveBuilt);
    });
  }
  startExpensiveSections();
  return Promise.all([cheapSectionsPromise, expensiveSectionsPromise]).then(function (results) {
    return results[0].sections.concat(results[1]);
  });
}

function startExpensiveSections() {
  if (!expensiveSectionsPromise) {
    expensiveSectionsPromise = buildExpensiveSections().catch(function (err) {
      console.warn('Jellio: could not build home sections', err);
      expensiveSectionsPromise = null;
      return [];
    });
  }
  return expensiveSectionsPromise;
}

function preloadExpensiveHomeSections() {
  return startExpensiveSections().then(function (expensive) {
    return cheapBuilt.concat(expensive);
  });
}

export function preloadHomeSectionsWithProgress(onSection) {
  const promise = preloadHomeSections();
  cheapBuilt.concat(expensiveBuilt).forEach(onSection);
  sectionListeners.push(onSection);
  return {
    promise: promise,
    unsubscribe: function () {
      sectionListeners = sectionListeners.filter(function (listener) {
        return listener !== onSection;
      });
    },
  };
}

function greetingFor(hour) {
  if (hour >= 5 && hour < 12) return t('home_greeting_morning');
  if (hour >= 12 && hour < 17) return t('home_greeting_afternoon');
  if (hour >= 17 && hour < 22) return t('home_greeting_evening');
  return t('home_greeting_night');
}

export async function renderHome(root, params) {
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-home';

  if (params && params.get('tab') === '1') {
    await renderWatchlist(root, params.get('list'));
    return undefined;
  }

  const hero = buildHeroCarousel({
    onFocusItem: function (item) {
      if (item && item.Id) warmItem(item.Id, true);
    },
  });
  root.appendChild(hero.element);

  const header = el('header', 'jellio-home-header');
  const greeting = greetingFor(new Date().getHours());
  const greetingEl = el('h1', 'jellio-home-greeting', greeting);
  header.appendChild(greetingEl);
  getCurrentUser()
    .then(function (user) {
      const name = user && user.Name;
      if (!name) return;
      const question = /\s?\?$/.exec(greeting);
      greetingEl.textContent = question
        ? greeting.slice(0, question.index) + ', ' + name + question[0]
        : greeting + ', ' + name;
    })
    .catch(function () {});

  let editMode = false;
  const customizeBar = buildHomeCustomizeBar(
    function onToggleEdit() {
      editMode = !editMode;
      updateHomeCustomizeBar(customizeBar, editMode);
      applyHomeCustomization(rows, editMode);
    },
    function onReset() {
      resetHomeCustomization();
      applyHomeCustomization(rows, editMode);
    },
  );
  updateHomeCustomizeBar(customizeBar, editMode);
  header.appendChild(customizeBar.bar);
  root.appendChild(header);

  const rows = el('div', 'jellio-rows');
  root.appendChild(rows);

  const skeleton = buildHomeSkeleton(4);
  rows.appendChild(skeleton);
  let skeletonRemoved = false;
  function removeSkeleton() {
    if (skeletonRemoved) return;
    skeletonRemoved = true;
    if (skeleton.parentNode) skeleton.parentNode.removeChild(skeleton);
  }

  let active = true;
  function placeSection(section) {
    if (!active) return;
    // A rebuilt row replaces the one already showing under the same key,
    // keeping how far the reader had scrolled it.
    const key = section.dataset.jellioRowKey;
    let scrolled = null;
    if (key) {
      const current = rows.querySelector('[data-jellio-row-key="' + CSS.escape(key) + '"]');
      if (current && current !== section) {
        scrolled = Array.from(current.querySelectorAll('.jellio-row-track')).map(function (track) {
          return track.scrollLeft;
        });
        current.remove();
      }
    }
    const order = Number(section.dataset.jellioHomeOrder || 0);
    const after = Array.from(rows.children).find(function (child) {
      return child !== section && child !== skeleton && Number(child.dataset.jellioHomeOrder || 0) > order;
    });
    const insertTarget = after || (skeleton.parentNode === rows ? skeleton : null);
    // Moving a row already in place would reset its scroll position.
    if (section.parentNode !== rows || section.nextSibling !== insertTarget) {
      rows.insertBefore(section, insertTarget);
    }
    if (scrolled && scrolled.some(Boolean)) {
      section.querySelectorAll('.jellio-row-track').forEach(function (track, i) {
        if (scrolled[i]) track.scrollLeft = scrolled[i];
      });
    }
    markHomeRowPainted();
    applyHomeCustomization(rows, editMode);

    if (!skeletonRemoved && skeleton.parentNode === rows) {
      const placeholders = skeleton.querySelectorAll('.jellio-home-skeleton-row');
      if (placeholders.length > 2) {
        placeholders[placeholders.length - 1].remove();
      }
    }
  }
  function settleRows(settledSections) {
    if (!active) return;
    // Lazy rows still to come below: their placeholders stay until then.
    if (!lazyRows || lazyRowsDone) removeSkeleton();
    const current = Array.isArray(settledSections) && settledSections.length
      ? settledSections
      : cheapBuilt.concat(expensiveBuilt);
    current.forEach(placeSection);
    Array.from(rows.children).forEach(function (child) {
      if (child === skeleton) return;
      const order = Number(child.dataset.jellioHomeOrder);
      if (order < EXPENSIVE_ORDER_BASE) {
        const inCurrent = current.some(function (sec) {
          return sec === child || (sec.dataset && child.dataset && sec.dataset.jellioRowKey && sec.dataset.jellioRowKey === child.dataset.jellioRowKey);
        });
        if (!inCurrent) child.remove();
      }
    });
  }
  // Row cache on: recommendation, catalog and genre rows load once the
  // screen gets near them, not all at once on mount.
  const lazyRows = isHomeRowCacheEnabled();
  let lazyRowsRequested = false;
  let lazyRowsDone = false;
  function requestLazyRows() {
    if (lazyRowsRequested || !active) return;
    lazyRowsRequested = true;
    preloadExpensiveHomeSections()
      .then(function (sections) {
        lazyRowsDone = true;
        settleRows(sections);
      })
      .catch(function () {
        lazyRowsDone = true;
        removeSkeleton();
      });
  }
  let lazyObserver = null;
  let lazyTimer = null;
  if (lazyRows) {
    const sentinel = el('div', 'jellio-home-lazy-sentinel');
    root.appendChild(sentinel);
    if (typeof IntersectionObserver === 'function') {
      lazyObserver = new IntersectionObserver(
        function (entries) {
          const visible = entries.some(function (entry) {
            return entry.isIntersecting;
          });
          window.clearTimeout(lazyTimer);
          // A pass straight through while the page settles doesn't count.
          if (visible) lazyTimer = window.setTimeout(requestLazyRows, 150);
        },
        { rootMargin: '0px 0px 800px 0px' },
      );
      lazyObserver.observe(sentinel);
    } else {
      lazyTimer = window.setTimeout(requestLazyRows, 1500);
    }
  }

  const subscription = preloadHomeSectionsWithProgress(placeSection);
  subscription.promise
    .then(settleRows)
    .then(function () {
      // Once the rows are on screen, so this never competes with them.
      window.setTimeout(function () {
        if (active) warmItems(homeWarmupIds);
      }, 800);
    })
    .catch(function (err) {
    console.warn('Jellio: home sections promise failed', err);
    removeSkeleton();
  });

  function refreshFromRowCache(all) {
    if (!active) return;
    preloadHomeSections().then(settleRows);
    if (all && lazyRowsRequested) preloadExpensiveHomeSections().then(settleRows);
  }
  rowCacheRefreshers.add(refreshFromRowCache);

  let userDataRefreshTimer = null;
  const unsubscribeUserData = onUserDataChange(function () {
    window.clearTimeout(userDataRefreshTimer);
    userDataRefreshTimer = window.setTimeout(function () {
      if (!active) return;
      invalidateHomeSections();
      preloadHomeSections().then(settleRows);
    }, 600);
  });

  return function cleanup() {
    active = false;
    rowCacheRefreshers.delete(refreshFromRowCache);
    if (lazyObserver) lazyObserver.disconnect();
    window.clearTimeout(lazyTimer);
    removeSkeleton();
    subscription.unsubscribe();
    window.clearTimeout(userDataRefreshTimer);
    unsubscribeUserData();
    hero.destroy();
  };
}
