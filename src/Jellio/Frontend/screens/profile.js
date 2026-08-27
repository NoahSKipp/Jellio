// The profile page, from the reference table: AniList-style banner,
// bio, badge showcase, activity feed. Own route (#/profile?id=X, own
// signed in user's own id when the query is bare), reached from
// Settings' own "View profile" row for now. Badges/activity come off
// Controllers/AchievementsController.cs's own {userId} route, which
// already carries the Privacy toggle's own gate baked in
// (getForUserId's own header explains why) so this file only ever
// needs to check the one IsPrivate field that answer comes back with,
// never re-derive who is allowed to see what itself.
import {
  getUserById,
  getUserImageUrl,
  getProfileForUser,
  setProfileBio,
  getBannerUrl,
  setProfileBannerFromFile,
  getAchievementsForUser,
} from '../runtime/api.js';
import { getCurrentUserId } from '../runtime/auth.js';
import { renderLoading, renderRetry } from '../components/networkState.js';
import { describeNetworkFailure } from '../runtime/network.js';
import { navigateTo } from '../runtime/router.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const BIO_MAX_LENGTH = 240;

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

// AchievementsController.cs's own real ActivityGrouping.Group: a binge
// (same series, same UTC day) comes back as one entry with
// EpisodeCount > 1 instead of one row per episode, same real grouping
// screens/feed.js's own describeActivity already applies.
function describeActivity(entry) {
  if (entry.ItemType === 'Episode' && entry.EpisodeCount > 1) {
    const season = entry.SeasonNumber != null ? 'Season ' + entry.SeasonNumber + ', ' : '';
    const range =
      entry.FirstEpisodeNumber != null && entry.LastEpisodeNumber != null
        ? 'Episodes ' + entry.FirstEpisodeNumber + '-' + entry.LastEpisodeNumber
        : entry.EpisodeCount + ' episodes';
    return 'Finished ' + entry.SeriesName + ' — ' + season + range;
  }
  const noun = entry.ItemType === 'Episode' && entry.SeriesName ? entry.SeriesName + ' — ' + entry.ItemName : entry.ItemName;
  return 'Finished ' + noun;
}

function buildBanner(userId, isOwner, onChanged) {
  const banner = el('div', 'jellio-profile-banner');
  const img = document.createElement('img');
  img.className = 'jellio-profile-banner-img';
  img.alt = '';
  img.src = getBannerUrl(userId) + '?t=' + Date.now();
  img.addEventListener('error', function () {
    banner.classList.add('jellio-profile-banner-empty');
    img.remove();
  });
  banner.appendChild(img);

  if (isOwner) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.className = 'jellio-profile-banner-input';

    const editButton = el('button', 'jellio-profile-banner-edit', 'Change banner');
    editButton.type = 'button';
    editButton.addEventListener('click', function () {
      input.click();
    });

    input.addEventListener('change', function () {
      const file = input.files && input.files[0];
      if (!file) return;
      editButton.disabled = true;
      editButton.textContent = 'Uploading…';
      setProfileBannerFromFile(file)
        .then(function () {
          onChanged();
        })
        .catch(function (err) {
          console.warn('Jellio: could not upload banner', err);
        })
        .finally(function () {
          editButton.disabled = false;
          editButton.textContent = 'Change banner';
        });
    });

    banner.appendChild(editButton);
    banner.appendChild(input);
  }

  return banner;
}

function buildBioSection(userId, bio, isOwner, onChanged) {
  const wrap = el('div', 'jellio-profile-bio-wrap');

  function renderView() {
    wrap.textContent = '';
    wrap.appendChild(el('p', 'jellio-profile-bio', bio || (isOwner ? 'Add a short bio.' : '')));
    if (isOwner) {
      const editButton = el('button', 'jellio-profile-bio-edit', 'Edit bio');
      editButton.type = 'button';
      editButton.addEventListener('click', renderEdit);
      wrap.appendChild(editButton);
    }
  }

  function renderEdit() {
    wrap.textContent = '';
    const textarea = document.createElement('textarea');
    textarea.className = 'jellio-profile-bio-input';
    textarea.maxLength = BIO_MAX_LENGTH;
    textarea.value = bio || '';
    wrap.appendChild(textarea);

    const actions = el('div', 'jellio-profile-bio-actions');
    const save = el('button', 'jellio-settings-button', 'Save');
    save.type = 'button';
    const cancel = el('button', 'jellio-profile-bio-cancel', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', renderView);
    save.addEventListener('click', function () {
      save.disabled = true;
      setProfileBio(textarea.value.trim())
        .then(function (settings) {
          bio = settings.Bio;
          onChanged();
          renderView();
        })
        .catch(function (err) {
          console.warn('Jellio: could not update bio', err);
          save.disabled = false;
        });
    });
    actions.appendChild(save);
    actions.appendChild(cancel);
    wrap.appendChild(actions);
    textarea.focus();
  }

  renderView();
  return wrap;
}

function buildLockedPanel() {
  const panel = el('div', 'jellio-profile-locked');
  panel.appendChild(el('span', 'material-icons jellio-profile-locked-icon', 'visibility_off'));
  panel.appendChild(el('p', 'jellio-profile-locked-text', 'This profile is private.'));
  return panel;
}

function buildBadgesSection(badges) {
  const section = el('section', 'jellio-profile-section');
  const unlockedCount = badges.filter(function (b) { return b.Unlocked; }).length;
  section.appendChild(el('h2', 'jellio-row-title', 'Badges (' + unlockedCount + '/' + badges.length + ')'));
  const grid = el('div', 'jellio-profile-badges');
  badges.forEach(function (badge) {
    const tile = el('article', 'jellio-profile-badge');
    tile.dataset.rarity = badge.Rarity.toLowerCase();
    tile.dataset.unlocked = String(badge.Unlocked);
    const icon = el('span', 'material-icons jellio-profile-badge-icon', badge.Unlocked ? 'military_tech' : 'lock');
    tile.appendChild(icon);
    tile.appendChild(el('span', 'jellio-profile-badge-name', badge.Name));
    tile.title = badge.Description;
    grid.appendChild(tile);
  });
  section.appendChild(grid);
  return section;
}

function buildActivitySection(entries) {
  const section = el('section', 'jellio-profile-section');
  section.appendChild(el('h2', 'jellio-row-title', 'Recent activity'));
  if (!entries.length) {
    section.appendChild(el('p', 'jellio-profile-empty', 'Nothing watched yet.'));
    return section;
  }
  const list = el('ul', 'jellio-profile-activity');
  entries.forEach(function (entry) {
    const item = el('li', 'jellio-profile-activity-item');
    item.appendChild(el('span', 'jellio-profile-activity-text', describeActivity(entry)));
    item.appendChild(el('span', 'jellio-profile-activity-time', formatRelativeTime(entry.CompletedAtUtc)));
    list.appendChild(item);
  });
  section.appendChild(list);
  return section;
}

export async function renderProfile(root, params) {
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-profile';

  const currentUserId = getCurrentUserId();
  const userId = params.get('id') || currentUserId;
  if (!userId) return;
  const isOwner = userId === currentUserId;

  renderLoading(root);

  let user;
  let profile;
  let achievements;
  try {
    [user, profile, achievements] = await Promise.all([
      getUserById(userId),
      getProfileForUser(userId),
      getAchievementsForUser(userId),
    ]);
  } catch (err) {
    console.warn('Jellio: could not load profile', err);
    renderRetry(root, describeNetworkFailure('this profile', err), function () {
      renderProfile(root, params);
    }, { onBack: function () { navigateTo('#/home'); }, backLabel: 'Back to Home' });
    return;
  }

  root.textContent = '';

  root.appendChild(
    buildBanner(userId, isOwner, function () {
      renderProfile(root, params);
    }),
  );

  const header = el('div', 'jellio-profile-header');
  const imageTag = user.PrimaryImageTag;
  const avatar = document.createElement('img');
  avatar.className = 'jellio-profile-avatar';
  avatar.alt = '';
  avatar.src = getUserImageUrl(userId, imageTag, { maxWidth: 200 });
  header.appendChild(avatar);

  const identity = el('div', 'jellio-profile-identity');
  const nameRow = el('div', 'jellio-profile-name-row');
  nameRow.appendChild(el('h1', 'jellio-profile-name', user.Name || ''));
  if (isOwner && profile.IsPrivate) {
    nameRow.appendChild(el('span', 'jellio-profile-private-chip', 'Private'));
  }
  identity.appendChild(nameRow);
  identity.appendChild(
    buildBioSection(userId, profile.Bio, isOwner, function () {
      /* bio already updated in place, nothing else to refresh */
    }),
  );
  header.appendChild(identity);
  root.appendChild(header);

  const body = el('div', 'jellio-profile-body');
  if (achievements.IsPrivate) {
    body.appendChild(buildLockedPanel());
  } else {
    const stats = el('div', 'jellio-profile-stats');
    [
      ['Movies', achievements.MoviesCompleted],
      ['Episodes', achievements.EpisodesCompleted],
      ['Total watched', achievements.TotalCompleted],
      ['Best binge', achievements.BestBingeStreak],
    ].forEach(function (pair) {
      const stat = el('div', 'jellio-profile-stat');
      stat.appendChild(el('span', 'jellio-profile-stat-value', String(pair[1])));
      stat.appendChild(el('span', 'jellio-profile-stat-label', pair[0]));
      stats.appendChild(stat);
    });
    body.appendChild(stats);
    body.appendChild(buildBadgesSection(achievements.Badges));
    body.appendChild(buildActivitySection(achievements.RecentActivity));
  }
  root.appendChild(body);
}
