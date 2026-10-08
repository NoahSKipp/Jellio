// The general activity feed, from the reference table: "a dedicated Feed
// tab... showcasing [everyone's] recent actions." Server wide rather than
// a real friends graph this plugin has no concept of at all, backed by
// Controllers/FeedController.cs's own real merge of every non-private
// user's own RecentActivity and badge unlocks (screens/profile.js's own
// per user version of the same real watch data). A private user's own
// entries, watch or badge, are already gone by the time this file sees
// them, server side, nothing to filter here.
import {
  getActivityFeed,
  getUserImageUrl,
  getImageUrl,
  getBookCoverUrl,
  getMangaSeriesCoverUrl,
  getCurrentUser,
  deleteActivityEntry,
  hideFeedBadge,
} from '../runtime/api.js';
import { getCurrentUserId } from '../runtime/auth.js';
import { renderLoading, renderRetry } from '../components/networkState.js';
import { describeNetworkFailure } from '../runtime/network.js';
import { navigateTo } from '../runtime/router.js';
import { openActivity } from '../components/activityLink.js';
import { formatRelativeTime, isReadingActivity, describeReading } from '../runtime/format.js';
import { el } from '../runtime/dom.js';

// AniList's own real activity card shape (screenshot checked before
// writing this): cover art leading the row, a "Watched episode 1-4 of
// [Title]" line with the title itself the one coloured/clickable part,
// not the whole sentence. FeedController.cs's own real
// ActivityGrouping.Group is what makes a binge (same series, same UTC
// day) arrive as one entry with EpisodeCount > 1 instead of one row
// per episode here, real feedback specifically asked not to drown the
// rest of this feed out under a single sitting.
function appendWatchDescription(container, entry) {
  if (isReadingActivity(entry)) {
    const reading = describeReading(entry);
    container.appendChild(document.createTextNode(reading.lead));
    container.appendChild(el('span', 'jellio-feed-title', reading.title));
    if (reading.series) {
      container.appendChild(document.createTextNode(' of '));
      container.appendChild(el('span', 'jellio-feed-title', reading.series));
    }
    if (reading.detail) container.appendChild(el('div', 'jellio-feed-badge-desc', reading.detail));
    return;
  }
  if (entry.ItemType === 'Episode' && entry.SeriesName) {
    container.appendChild(document.createTextNode('Watched '));
    if (entry.EpisodeCount > 1) {
      const season = entry.SeasonNumber != null ? 'Season ' + entry.SeasonNumber + ', ' : '';
      const range =
        entry.FirstEpisodeNumber != null && entry.LastEpisodeNumber != null
          ? 'Episodes ' + entry.FirstEpisodeNumber + '-' + entry.LastEpisodeNumber
          : entry.EpisodeCount + ' episodes';
      container.appendChild(document.createTextNode(season + range + ' of '));
    } else if (entry.FirstEpisodeNumber != null) {
      const season = entry.SeasonNumber != null ? 'Season ' + entry.SeasonNumber + ', ' : '';
      container.appendChild(document.createTextNode(season + 'Episode ' + entry.FirstEpisodeNumber + ' of '));
    }
    container.appendChild(el('span', 'jellio-feed-title', entry.SeriesName));
  } else {
    container.appendChild(document.createTextNode('Watched '));
    container.appendChild(el('span', 'jellio-feed-title', entry.ItemName));
  }
}

// Badge unlocks ride the same feed rather than their own section:
// FeedController.cs's own header explains why one merged, re-sorted
// list beats two separate ones. Same real Privacy gate as watch rows,
// applied server side before either kind ever reaches this file.
function appendBadgeDescription(container, entry) {
  container.appendChild(document.createTextNode('Unlocked '));
  const title = el('span', 'jellio-feed-title', entry.BadgeName);
  title.style.color = 'var(--jellio-rarity-' + (entry.BadgeRarity || 'common').toLowerCase() + ')';
  container.appendChild(title);
  if (entry.BadgeDescription) {
    const sub = el('div', 'jellio-feed-badge-desc', entry.BadgeDescription);
    container.appendChild(sub);
  }
}

// What an entry opens: the show (not the season or episode), the manga
// series (not the chapter), else the item itself. Badges, and anything
// without an item, open the person's profile.
async function openEntry(entry) {
  if (!(await openActivity(entry))) navigateTo('#/profile?id=' + entry.UserId);
}

function buildFeedRow(entry) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'jellio-feed-row';
  row.addEventListener('click', function () {
    openEntry(entry);
  });

  if (entry.Kind === 'Badge') {
    const tile = el('span', 'jellio-feed-badge-tile', null);
    tile.dataset.rarity = (entry.BadgeRarity || 'common').toLowerCase();
    const icon = el('span', 'material-icons', 'military_tech');
    icon.setAttribute('aria-hidden', 'true');
    tile.appendChild(icon);
    row.appendChild(tile);
  } else {
    const poster = document.createElement('img');
    poster.className = 'jellio-feed-poster';
    poster.alt = '';
    const chapterImage = getImageUrl(entry.SeriesId || entry.ItemId, 'Primary', { maxWidth: 200, quality: 85 });
    let triedChapterImage = entry.ItemType !== 'Manga';
    poster.src = triedChapterImage ? chapterImage : getMangaSeriesCoverUrl(entry.ItemId);
    // Books rarely have Jellyfin art; fall back to their Chaptarr cover.
    let triedBookCover = false;
    poster.addEventListener('error', function () {
      if (!triedChapterImage) {
        triedChapterImage = true;
        poster.src = chapterImage;
        return;
      }
      if (isReadingActivity(entry) && !triedBookCover) {
        triedBookCover = true;
        poster.src = getBookCoverUrl(entry.ItemId);
        return;
      }
      poster.replaceWith(el('span', 'material-icons ' + (isReadingActivity(entry) ? 'menu_book' : 'movie') + ' jellio-feed-poster-empty'));
    });
    row.appendChild(poster);
  }

  const body = el('div', 'jellio-feed-body');

  const meta = el('div', 'jellio-feed-meta');
  const avatar = document.createElement('img');
  avatar.className = 'jellio-feed-avatar';
  avatar.alt = '';
  avatar.src = getUserImageUrl(entry.UserId, null, { maxWidth: 60 });
  avatar.addEventListener('error', function () {
    avatar.replaceWith(el('span', 'material-icons person jellio-feed-avatar-empty'));
  });
  // The person (avatar and name) still opens their profile.
  const person = el('span', 'jellio-feed-person');
  person.setAttribute('role', 'link');
  person.title = entry.UserName + '’s profile';
  person.appendChild(avatar);
  person.appendChild(el('span', 'jellio-feed-user', entry.UserName));
  person.addEventListener('click', function (event) {
    event.stopPropagation();
    navigateTo('#/profile?id=' + entry.UserId);
  });
  meta.appendChild(person);
  meta.appendChild(el('span', 'jellio-feed-time', formatRelativeTime(entry.OccurredAtUtc)));
  body.appendChild(meta);

  const desc = el('div', 'jellio-feed-desc');
  if (entry.Kind === 'Badge') {
    appendBadgeDescription(desc, entry);
  } else {
    appendWatchDescription(desc, entry);
  }
  body.appendChild(desc);

  row.appendChild(body);
  return row;
}

// Content type filter chips: every type shows by default; a chip that's
// switched off stays visible, struck through, so it's clear what's hidden.
const FEED_TYPES = [
  { key: 'movies', label: 'Movies', icon: 'movie' },
  { key: 'shows', label: 'Shows', icon: 'tv' },
  { key: 'books', label: 'Books', icon: 'menu_book' },
  { key: 'manga', label: 'Manga', icon: 'collections_bookmark' },
  { key: 'audiobooks', label: 'Audiobooks', icon: 'headphones' },
  { key: 'badges', label: 'Badges', icon: 'emoji_events' },
];
const FEED_HIDDEN_KEY = 'jellio-feed-hidden-types';

function feedType(entry) {
  if (entry.Kind === 'Badge') return 'badges';
  switch (entry.ItemType) {
    case 'Movie':
      return 'movies';
    case 'Episode':
    case 'Series':
    case 'Season':
      return 'shows';
    case 'Book':
      return 'books';
    case 'Manga':
      return 'manga';
    case 'AudioBook':
      return 'audiobooks';
    default:
      return 'movies';
  }
}

function readHiddenTypes() {
  try {
    const saved = JSON.parse(localStorage.getItem(FEED_HIDDEN_KEY) || '[]');
    return new Set(Array.isArray(saved) ? saved : []);
  } catch (err) {
    return new Set();
  }
}

function saveHiddenTypes(hidden) {
  try {
    localStorage.setItem(FEED_HIDDEN_KEY, JSON.stringify(Array.from(hidden)));
  } catch (err) {
    // Kept for this visit only.
  }
}

export async function renderFeed(root) {
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-feed';

  const header = el('header', 'jellio-settings-header');
  header.appendChild(el('h1', 'jellio-settings-title', 'Feed'));
  root.appendChild(header);

  renderLoading(root);

  let entries;
  try {
    entries = await getActivityFeed();
  } catch (err) {
    console.warn('Jellio: could not load activity feed', err);
    renderRetry(root, describeNetworkFailure('the activity feed', err), function () {
      renderFeed(root);
    }, { onBack: function () { navigateTo('#/home'); }, backLabel: 'Back to Home' });
    return;
  }

  root.textContent = '';
  root.appendChild(header);

  if (!entries.length) {
    root.appendChild(el('p', 'jellio-profile-empty', 'Nothing here yet.'));
    return;
  }

  // A reader can remove their own entries; an admin anyone's.
  const viewer = await getCurrentUser().catch(() => null);
  const isAdmin = !!(viewer && viewer.Policy && viewer.Policy.IsAdministrator);
  const me = String(getCurrentUserId() || '').replace(/-/g, '');

  const hidden = readHiddenTypes();
  const list = el('div', 'jellio-feed-list');
  const empty = el('p', 'jellio-profile-empty', 'Nothing to show with these filters.');

  function applyFilters() {
    let shown = 0;
    Array.from(list.children).forEach(function (child) {
      const off = hidden.has(child.dataset.feedType);
      child.hidden = off;
      if (!off) shown++;
    });
    empty.hidden = shown > 0;
  }

  const filters = el('div', 'jellio-feed-filters');
  filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', 'Show in the feed');
  // Every type, even ones with nothing in the feed yet, so a reader can
  // set them up ahead of time.
  FEED_TYPES.forEach(function (type) {
    const chip = el('button', 'jellio-feed-filter-chip');
    chip.type = 'button';
    chip.appendChild(el('span', 'material-icons ' + type.icon));
    chip.appendChild(el('span', null, type.label));
    function paint() {
      const off = hidden.has(type.key);
      chip.classList.toggle('jellio-feed-filter-chip-off', off);
      chip.setAttribute('aria-pressed', off ? 'false' : 'true');
      chip.title = off ? 'Show ' + type.label.toLowerCase() : 'Hide ' + type.label.toLowerCase();
    }
    paint();
    chip.addEventListener('click', function () {
      if (hidden.has(type.key)) hidden.delete(type.key);
      else hidden.add(type.key);
      saveHiddenTypes(hidden);
      paint();
      applyFilters();
    });
    filters.appendChild(chip);
  });
  root.appendChild(filters);

  entries.forEach(function (entry) {
    const row = buildFeedRow(entry);
    const own = String(entry.UserId).replace(/-/g, '') === me;
    if (!own && !isAdmin) {
      row.dataset.feedType = feedType(entry);
      list.appendChild(row);
      return;
    }
    const item = el('div', 'jellio-feed-item');
    item.dataset.feedType = feedType(entry);
    item.appendChild(row);
    item.appendChild(buildRemoveButton(entry, own, item));
    list.appendChild(item);
  });
  root.appendChild(list);
  root.appendChild(empty);
  applyFilters();
}

function buildRemoveButton(entry, own, item) {
  const button = el('button', 'jellio-feed-remove');
  button.type = 'button';
  const label = entry.Kind === 'Badge' ? 'Remove this badge from the feed' : 'Remove this activity';
  button.setAttribute('aria-label', label);
  button.title = own ? label : label + ' (admin)';
  button.appendChild(el('span', 'material-icons close'));
  button.addEventListener('click', function () {
    const question =
      entry.Kind === 'Badge'
        ? 'Remove this badge from the feed? The badge stays unlocked.'
        : 'Remove this activity from the feed and ' + (own ? 'your' : entry.UserName + '’s') + ' profile?';
    if (!window.confirm(question)) return;
    button.disabled = true;
    const removal =
      entry.Kind === 'Badge'
        ? hideFeedBadge(entry.UserId, entry.BadgeId)
        : deleteActivityEntry(entry.UserId, entry.ItemId, entry.OccurredAtUtc);
    removal
      .then(function () {
        item.remove();
      })
      .catch(function (err) {
        console.warn('Jellio: could not remove the feed entry', err);
        button.disabled = false;
      });
  });
  return button;
}
