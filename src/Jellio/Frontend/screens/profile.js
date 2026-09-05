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
  getCurrentUser,
  deleteActivityEntry,
  lockBadgeForUser,
  resetAchievementsForUser,
} from '../runtime/api.js';
import { getCurrentUserId } from '../runtime/auth.js';
import { renderLoading, renderRetry } from '../components/networkState.js';
import { describeNetworkFailure } from '../runtime/network.js';
import { navigateTo } from '../runtime/router.js';
import { formatRelativeTime } from '../runtime/format.js';
import { el } from '../runtime/dom.js';

const BIO_MAX_LENGTH = 240;

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
  // Real feedback, live: "scrolling is painfully slow" traced back to
  // an oversized banner. ProfileBannerController.cs now resizes one
  // down server side on upload, but this reader's own browser still
  // has to decode whatever is already stored (an upload from before
  // that real fix shipped, most of all). async keeps this file's own
  // real decode off the main thread rather than blocking a scroll on
  // it, cheap and safe regardless, not a substitute for that real fix.
  img.decoding = 'async';
  img.src = getBannerUrl(userId) + '&t=' + Date.now();
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

    const status = el('p', 'jellio-profile-banner-status');
    status.hidden = true;

    input.addEventListener('change', function () {
      const file = input.files && input.files[0];
      if (!file) return;
      status.hidden = true;
      editButton.disabled = true;
      editButton.textContent = 'Uploading…';
      setProfileBannerFromFile(file)
        .then(function () {
          onChanged();
        })
        .catch(function (err) {
          console.warn('Jellio: could not upload banner', err);
          status.textContent = (err && err.message) || 'Could not upload that banner.';
          status.hidden = false;
        })
        .finally(function () {
          editButton.disabled = false;
          editButton.textContent = 'Change banner';
        });
    });

    banner.appendChild(editButton);
    banner.appendChild(status);
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

// isAdmin/userId/onChanged only ever passed for someone else's own
// profile (renderProfile below gates that): an admin correcting a
// mistaken credit needs a way to relock a badge that already unlocked,
// same real Steam-moderation shape "reset the progress" was asked for
// alongside. Controllers/AchievementsController.cs's own LockBadge
// keeps it locked afterward (SuppressedBadgeIds), not just hidden
// until the next real completed movie or episode quietly re-adds it.
function buildBadgesSection(badges, isAdmin, userId, onChanged) {
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
    if (isAdmin && badge.Unlocked) {
      const lockButton = el('button', 'jellio-profile-admin-lock', 'Lock again');
      lockButton.type = 'button';
      lockButton.addEventListener('click', function (event) {
        event.stopPropagation();
        if (!window.confirm('Lock "' + badge.Name + '" again for this user?')) return;
        lockButton.disabled = true;
        lockBadgeForUser(userId, badge.Id)
          .then(onChanged)
          .catch(function (err) {
            console.warn('Jellio: could not lock badge', err);
            lockButton.disabled = false;
          });
      });
      tile.appendChild(lockButton);
    }
    grid.appendChild(tile);
  });
  section.appendChild(grid);
  return section;
}

function buildActivitySection(entries, isAdmin, userId, onChanged) {
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
    if (isAdmin) {
      const deleteButton = el('button', 'jellio-profile-admin-delete', 'Delete');
      deleteButton.type = 'button';
      deleteButton.addEventListener('click', function () {
        if (!window.confirm('Delete this activity entry? This cannot be undone.')) return;
        deleteButton.disabled = true;
        deleteActivityEntry(userId, entry.ItemId, entry.CompletedAtUtc)
          .then(onChanged)
          .catch(function (err) {
            console.warn('Jellio: could not delete activity entry', err);
            deleteButton.disabled = false;
          });
      });
      item.appendChild(deleteButton);
    }
    list.appendChild(item);
  });
  section.appendChild(list);
  return section;
}

// The one whole-user "start over" hammer, deliberately separate from
// (and more prominent than) the two per row/per badge actions above:
// AchievementsController.cs's own ResetProgress header covers why a
// single badge's own progress can't be rolled back in isolation when
// several badges share one counter, so this is the only real way
// "reset the progress" (real feedback's own words) can safely mean
// anything at all.
function buildAdminDangerZone(userId, onChanged) {
  const section = el('section', 'jellio-profile-section jellio-profile-danger-zone');
  section.appendChild(el('h2', 'jellio-row-title', 'Admin'));
  const resetButton = el('button', 'jellio-profile-admin-reset', 'Reset all progress');
  resetButton.type = 'button';
  resetButton.addEventListener('click', function () {
    if (!window.confirm('Reset every counter, badge and activity entry for this user? This cannot be undone.')) return;
    resetButton.disabled = true;
    resetAchievementsForUser(userId)
      .then(onChanged)
      .catch(function (err) {
        console.warn('Jellio: could not reset achievements', err);
        resetButton.disabled = false;
      });
  });
  section.appendChild(resetButton);
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
  let viewer;
  try {
    [user, profile, achievements, viewer] = await Promise.all([
      getUserById(userId),
      getProfileForUser(userId),
      getAchievementsForUser(userId),
      isOwner ? Promise.resolve(null) : getCurrentUser().catch(function () { return null; }),
    ]);
  } catch (err) {
    console.warn('Jellio: could not load profile', err);
    renderRetry(root, describeNetworkFailure('this profile', err), function () {
      renderProfile(root, params);
    }, { onBack: function () { navigateTo('#/home'); }, backLabel: 'Back to Home' });
    return;
  }

  root.textContent = '';

  // Admin controls (delete an activity entry, relock a badge, reset a
  // user's whole progress) only ever show on someone else's own
  // profile: viewer.Policy.IsAdministrator is the one real gate
  // screens/settings.js's own "Open admin dashboard" row already uses,
  // matched here rather than inventing a second one.
  const isAdmin = !isOwner && !!(viewer && viewer.Policy && viewer.Policy.IsAdministrator);

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
    const refresh = function () {
      renderProfile(root, params);
    };
    body.appendChild(buildBadgesSection(achievements.Badges, isAdmin, userId, refresh));
    body.appendChild(buildActivitySection(achievements.RecentActivity, isAdmin, userId, refresh));
    if (isAdmin) {
      body.appendChild(buildAdminDangerZone(userId, refresh));
    }
  }
  root.appendChild(body);
}
