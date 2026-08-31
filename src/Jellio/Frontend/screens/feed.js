// The general activity feed, from the reference table: "a dedicated Feed
// tab... showcasing [everyone's] recent actions." Server wide rather than
// a real friends graph this plugin has no concept of at all, backed by
// Controllers/FeedController.cs's own real merge of every non-private
// user's own RecentActivity and badge unlocks (screens/profile.js's own
// per user version of the same real watch data). A private user's own
// entries, watch or badge, are already gone by the time this file sees
// them, server side, nothing to filter here.
import { getActivityFeed, getUserImageUrl, getImageUrl } from '../runtime/api.js';
import { renderLoading, renderRetry } from '../components/networkState.js';
import { describeNetworkFailure } from '../runtime/network.js';
import { navigateTo } from '../runtime/router.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function formatRelativeTime(isoString) {
  const then = new Date(isoString).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return minutes + (minutes === 1 ? ' minute ago' : ' minutes ago');
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
  const days = Math.round(hours / 24);
  if (days < 30) return days + (days === 1 ? ' day ago' : ' days ago');
  const months = Math.round(days / 30);
  if (months < 12) return months + (months === 1 ? ' month ago' : ' months ago');
  const years = Math.round(months / 12);
  return years + (years === 1 ? ' year ago' : ' years ago');
}

// AniList's own real activity card shape (screenshot checked before
// writing this): cover art leading the row, a "Watched episode 1-4 of
// [Title]" line with the title itself the one coloured/clickable part,
// not the whole sentence. FeedController.cs's own real
// ActivityGrouping.Group is what makes a binge (same series, same UTC
// day) arrive as one entry with EpisodeCount > 1 instead of one row
// per episode here, real feedback specifically asked not to drown the
// rest of this feed out under a single sitting.
function appendWatchDescription(container, entry) {
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

function buildFeedRow(entry) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'jellio-feed-row';
  row.addEventListener('click', function () {
    navigateTo('#/profile?id=' + entry.UserId);
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
    poster.src = getImageUrl(entry.SeriesId || entry.ItemId, 'Primary', { maxWidth: 200, quality: 85 });
    poster.addEventListener('error', function () {
      poster.replaceWith(el('span', 'material-icons movie jellio-feed-poster-empty'));
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
  meta.appendChild(avatar);
  meta.appendChild(el('span', 'jellio-feed-user', entry.UserName));
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

  const list = el('div', 'jellio-feed-list');
  entries.forEach(function (entry) {
    list.appendChild(buildFeedRow(entry));
  });
  root.appendChild(list);
}
