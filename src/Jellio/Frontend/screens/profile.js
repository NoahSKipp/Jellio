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
import { formatRelativeTime, isReadingActivity, describeReading } from '../runtime/format.js';
import { el } from '../runtime/dom.js';
import { openAvatarPicker } from '../components/avatarPicker.js';
import { refreshProfileAvatar } from '../components/navShared.js';
import { openActivity, canOpenActivity } from '../components/activityLink.js';

const BIO_MAX_LENGTH = 240;

// "3h 20m", "45m", "0m".
function formatMinutes(minutes) {
  const total = Math.max(0, Math.floor(Number(minutes) || 0));
  const hours = Math.floor(total / 60);
  if (!hours) return total + 'm';
  return hours.toLocaleString() + 'h' + (total % 60 ? ' ' + (total % 60) + 'm' : '');
}

// AchievementsController.cs's own real ActivityGrouping.Group: a binge
// (same series, same UTC day) comes back as one entry with
// EpisodeCount > 1 instead of one row per episode, same real grouping
// screens/feed.js's own describeActivity already applies.
// The entry as text with its show, manga series or title as a link to it
// (components/activityLink.js).
function describeActivity(entry) {
  const container = el('span', 'jellio-profile-activity-text');
  function link(text) {
    if (!canOpenActivity(entry)) return el('span', null, text);
    const anchor = el('a', 'jellio-profile-activity-link', text);
    anchor.href = '#';
    anchor.addEventListener('click', function (event) {
      event.preventDefault();
      openActivity(entry);
    });
    return anchor;
  }
  function text(value) {
    container.appendChild(document.createTextNode(value));
  }
  if (isReadingActivity(entry)) {
    const reading = describeReading(entry);
    text(reading.lead);
    if (reading.series) {
      text(reading.title + ' of ');
      container.appendChild(link(reading.series));
    } else {
      container.appendChild(link(reading.title));
    }
    if (reading.detail) text(' · ' + reading.detail);
    return container;
  }
  text('Finished ');
  if (entry.ItemType === 'Episode' && entry.SeriesName) {
    container.appendChild(link(entry.SeriesName));
    if (entry.EpisodeCount > 1) {
      const season = entry.SeasonNumber != null ? 'Season ' + entry.SeasonNumber + ', ' : '';
      const range =
        entry.FirstEpisodeNumber != null && entry.LastEpisodeNumber != null
          ? 'Episodes ' + entry.FirstEpisodeNumber + '-' + entry.LastEpisodeNumber
          : entry.EpisodeCount + ' episodes';
      text(' — ' + season + range);
    } else {
      text(' — ' + entry.ItemName);
    }
    return container;
  }
  container.appendChild(link(entry.ItemName));
  return container;
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

// Real feedback: changing a profile picture only ever lived behind
// Settings' own "Change avatar" row, a real extra hop away from the one
// real page that already shows it full size. Same real picker
// components/avatarPicker.js already opens from there (a real full
// overlay of its own, upload or pick from presets), just triggered from
// here too now - onChanged refreshes both the sidebar/nav's own real
// avatar mounts (refreshProfileAvatar, the same real live nudge
// Settings' own row already needed since neither rail rebuilds on its
// own past its first real render) and this whole screen, so the new
// real picture actually shows here immediately rather than only after
// a real reload.
function buildAvatar(userId, imageTag, isOwner, onChanged) {
  const wrap = el('div', 'jellio-profile-avatar-wrap');
  const avatar = document.createElement('img');
  avatar.className = 'jellio-profile-avatar';
  avatar.alt = '';
  avatar.src = getUserImageUrl(userId, imageTag, { maxWidth: 200 });
  wrap.appendChild(avatar);

  if (isOwner) {
    const editButton = el('button', 'jellio-profile-avatar-edit');
    editButton.type = 'button';
    editButton.setAttribute('aria-label', 'Change profile picture');
    editButton.appendChild(el('span', 'material-icons jellio-profile-avatar-edit-icon photo_camera'));
    editButton.addEventListener('click', function () {
      openAvatarPicker(function () {
        refreshProfileAvatar();
        onChanged();
      });
    });
    wrap.appendChild(editButton);
  }

  return wrap;
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

  let filter = 'all';
  const filterBar = el('div', 'jellio-profile-filter-bar');
  const filters = [
    { key: 'all', label: 'All (' + badges.length + ')' },
    { key: 'unlocked', label: 'Unlocked (' + unlockedCount + ')' },
    { key: 'locked', label: 'Locked (' + (badges.length - unlockedCount) + ')' },
  ];

  const grid = el('div', 'jellio-profile-badges');

  function renderGrid() {
    grid.textContent = '';
    const filtered = badges.filter(function (badge) {
      if (filter === 'unlocked') return badge.Unlocked;
      if (filter === 'locked') return !badge.Unlocked;
      return true;
    });

    if (!filtered.length) {
      grid.appendChild(el('p', 'jellio-profile-empty', 'No badges in this category.'));
      return;
    }

    filtered.forEach(function (badge) {
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
          if (!window.confirm('Lock "' + badge.Name + '" again?')) return;
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
  }

  filters.forEach(function (f) {
    const chip = el('button', 'jellio-profile-filter-chip' + (f.key === filter ? ' jellio-profile-filter-chip-active' : ''), f.label);
    chip.type = 'button';
    chip.addEventListener('click', function () {
      filter = f.key;
      Array.prototype.forEach.call(filterBar.children, function (c) {
        c.classList.remove('jellio-profile-filter-chip-active');
      });
      chip.classList.add('jellio-profile-filter-chip-active');
      renderGrid();
    });
    filterBar.appendChild(chip);
  });

  section.appendChild(filterBar);
  section.appendChild(grid);
  renderGrid();
  return section;
}

function buildActivitySection(entries, canRemove, userId, onChanged) {
  const section = el('section', 'jellio-profile-section');
  section.appendChild(el('h2', 'jellio-row-title', 'Recent activity'));
  if (!entries.length) {
    section.appendChild(el('p', 'jellio-profile-empty', 'Nothing watched yet.'));
    return section;
  }

  let filter = 'all';
  const filterBar = el('div', 'jellio-profile-filter-bar');
  const filters = [
    { key: 'all', label: 'All (' + entries.length + ')' },
    { key: 'video', label: 'Movies & Episodes' },
    { key: 'reading', label: 'Books & Manga' },
    { key: 'audio', label: 'Audiobooks' },
  ];

  const list = el('ul', 'jellio-profile-activity');

  function renderList() {
    list.textContent = '';
    const filtered = entries.filter(function (entry) {
      if (filter === 'video') return entry.ItemType === 'Movie' || entry.ItemType === 'Episode';
      if (filter === 'reading') return entry.ItemType === 'Book' || entry.ItemType === 'Manga';
      if (filter === 'audio') return entry.ItemType === 'AudioBook';
      return true;
    });

    if (!filtered.length) {
      list.appendChild(el('li', 'jellio-profile-empty', 'No activity matching this filter.'));
      return;
    }

    filtered.forEach(function (entry) {
      const item = el('li', 'jellio-profile-activity-item');
      item.appendChild(describeActivity(entry));
      item.appendChild(el('span', 'jellio-profile-activity-time', formatRelativeTime(entry.CompletedAtUtc)));
      if (canRemove) {
        const deleteButton = el('button', 'jellio-profile-admin-delete', 'Remove');
        deleteButton.type = 'button';
        deleteButton.addEventListener('click', function () {
          if (!window.confirm('Remove this entry from the profile and the feed? Stats and badges stay as they are.')) return;
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
  }

  filters.forEach(function (f) {
    const chip = el('button', 'jellio-profile-filter-chip' + (f.key === filter ? ' jellio-profile-filter-chip-active' : ''), f.label);
    chip.type = 'button';
    chip.addEventListener('click', function () {
      filter = f.key;
      Array.prototype.forEach.call(filterBar.children, function (c) {
        c.classList.remove('jellio-profile-filter-chip-active');
      });
      chip.classList.add('jellio-profile-filter-chip-active');
      renderList();
    });
    filterBar.appendChild(chip);
  });

  section.appendChild(filterBar);
  section.appendChild(list);
  renderList();
  return section;
}

function buildLifetimeStats(achievements) {
  const container = el('div', 'jellio-profile-stats-lifetime-container');
  [
    [
      'Watching',
      [
        ['Movies', achievements.MoviesCompleted],
        ['Episodes', achievements.EpisodesCompleted],
        ['Total watched', achievements.TotalCompleted],
        ['Best binge', achievements.BestBingeStreak],
      ],
    ],
    [
      'Books',
      [
        ['Finished', achievements.BooksCompleted],
        ['Pages read', achievements.BookPagesRead],
        ['Time reading', formatMinutes(achievements.ReadingMinutes)],
      ],
    ],
    [
      'Manga · manhwa · manhua',
      [
        ['Finished', achievements.MangaVolumesCompleted],
        ['Pages read', achievements.MangaPagesRead],
        ['Time reading', formatMinutes(achievements.MangaReadingMinutes)],
      ],
    ],
    [
      'Audiobooks',
      [
        ['Finished', achievements.AudiobooksCompleted],
        ['Time listening', formatMinutes(achievements.ListenedMinutes)],
      ],
    ],
  ].forEach(function (group) {
    const section = el('section', 'jellio-profile-stat-group');
    section.appendChild(el('h3', 'jellio-profile-stat-group-title', group[0]));
    const stats = el('div', 'jellio-profile-stats');
    group[1].forEach(function (pair) {
      const stat = el('div', 'jellio-profile-stat');
      const value = typeof pair[1] === 'string' ? pair[1] : Number(pair[1] || 0).toLocaleString();
      stat.appendChild(el('span', 'jellio-profile-stat-value', value));
      stat.appendChild(el('span', 'jellio-profile-stat-label', pair[0]));
      stats.appendChild(stat);
    });
    section.appendChild(stats);
    container.appendChild(section);
  });
  return container;
}

function computeMonthlyData(recentActivity, targetYear, targetMonth) {
  const entries = recentActivity || [];
  const monthEntries = entries.filter(function (entry) {
    if (!entry.CompletedAtUtc) return false;
    const d = new Date(entry.CompletedAtUtc);
    return d.getFullYear() === targetYear && d.getMonth() === targetMonth;
  });

  let movies = 0;
  let episodes = 0;
  const days = new Set();
  const seriesMap = {};
  let books = 0;
  let bookPages = 0;
  let mangaVolumes = 0;
  let mangaPages = 0;
  let listenedTicks = 0;

  monthEntries.forEach(function (entry) {
    const d = new Date(entry.CompletedAtUtc);
    days.add(d.getDate());

    if (entry.ItemType === 'Movie') {
      movies += 1;
    } else if (entry.ItemType === 'Episode') {
      const count = entry.EpisodeCount || 1;
      episodes += count;
      if (entry.SeriesName) {
        seriesMap[entry.SeriesName] = (seriesMap[entry.SeriesName] || 0) + count;
      }
    } else if (entry.ItemType === 'Book') {
      if (entry.Finished) books += 1;
      if (entry.PagesRead) bookPages += entry.PagesRead;
    } else if (entry.ItemType === 'Manga') {
      if (entry.Finished) mangaVolumes += 1;
      if (entry.PagesRead) mangaPages += entry.PagesRead;
    } else if (entry.ItemType === 'AudioBook') {
      if (entry.ListenedTicks) listenedTicks += entry.ListenedTicks;
    }
  });

  let topSeriesName = null;
  let topSeriesCount = 0;
  Object.keys(seriesMap).forEach(function (name) {
    if (seriesMap[name] > topSeriesCount) {
      topSeriesCount = seriesMap[name];
      topSeriesName = name;
    }
  });

  return {
    movies: movies,
    episodes: episodes,
    totalWatched: movies + episodes,
    activeDays: days.size,
    topSeriesName: topSeriesName,
    topSeriesCount: topSeriesCount,
    books: books,
    bookPages: bookPages,
    mangaVolumes: mangaVolumes,
    mangaPages: mangaPages,
    listenedMinutes: Math.round(listenedTicks / (10000000 * 60)),
    hasActivity: monthEntries.length > 0,
  };
}

function buildMonthlyStats(achievements, selectedDate, onDateChange) {
  const container = el('div', 'jellio-profile-stats-monthly-container');

  const now = new Date();
  const year = selectedDate.getFullYear();
  const month = selectedDate.getMonth();
  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth();

  const navWrap = el('div', 'jellio-profile-stats-toggle-wrap');
  const nav = el('div', 'jellio-profile-month-nav');

  const prevBtn = el('button', 'jellio-profile-month-btn');
  prevBtn.type = 'button';
  prevBtn.setAttribute('aria-label', 'Previous month');
  prevBtn.appendChild(el('span', 'material-icons', 'chevron_left'));
  prevBtn.addEventListener('click', function () {
    onDateChange(new Date(year, month - 1, 1));
  });
  nav.appendChild(prevBtn);

  const monthLabel = el('div', 'jellio-profile-month-label');
  monthLabel.appendChild(el('span', 'material-icons', 'calendar_month'));
  const monthName = selectedDate.toLocaleString('default', { month: 'long', year: 'numeric' });
  monthLabel.appendChild(document.createTextNode(monthName));
  nav.appendChild(monthLabel);

  const nextBtn = el('button', 'jellio-profile-month-btn');
  nextBtn.type = 'button';
  nextBtn.setAttribute('aria-label', 'Next month');
  nextBtn.appendChild(el('span', 'material-icons', 'chevron_right'));
  if (isCurrentMonth) {
    nextBtn.disabled = true;
  } else {
    nextBtn.addEventListener('click', function () {
      onDateChange(new Date(year, month + 1, 1));
    });
  }
  nav.appendChild(nextBtn);

  if (!isCurrentMonth) {
    const jumpBtn = el('button', 'jellio-profile-month-jump', 'Current month');
    jumpBtn.type = 'button';
    jumpBtn.addEventListener('click', function () {
      onDateChange(new Date());
    });
    nav.appendChild(jumpBtn);
  }

  navWrap.appendChild(nav);
  container.appendChild(navWrap);

  const data = computeMonthlyData(achievements.RecentActivity, year, month);

  if (data.topSeriesName) {
    const spotlightWrap = el('div', 'jellio-profile-spotlight');
    const card = el('div', 'jellio-profile-spotlight-card');
    card.appendChild(el('span', 'material-icons jellio-profile-spotlight-icon', 'military_tech'));
    const content = el('div', 'jellio-profile-spotlight-content');
    content.appendChild(el('span', 'jellio-profile-spotlight-eyebrow', 'Monthly Top Show'));
    content.appendChild(el('span', 'jellio-profile-spotlight-title', data.topSeriesName));
    content.appendChild(el('span', 'jellio-profile-spotlight-sub', data.topSeriesCount + ' episodes watched in ' + selectedDate.toLocaleString('default', { month: 'short' })));
    card.appendChild(content);
    spotlightWrap.appendChild(card);
    container.appendChild(spotlightWrap);
  }

  if (!data.hasActivity) {
    container.appendChild(el('p', 'jellio-profile-empty', 'No activity recorded for ' + monthName + '.'));
    return container;
  }

  [
    [
      'Watching in ' + selectedDate.toLocaleString('default', { month: 'long' }),
      [
        ['Movies', data.movies],
        ['Episodes', data.episodes],
        ['Total watched', data.totalWatched],
        ['Active days', data.activeDays],
      ],
    ],
    [
      'Books in ' + selectedDate.toLocaleString('default', { month: 'long' }),
      [
        ['Finished', data.books],
        ['Pages read', data.bookPages],
      ],
    ],
    [
      'Manga in ' + selectedDate.toLocaleString('default', { month: 'long' }),
      [
        ['Finished', data.mangaVolumes],
        ['Pages read', data.mangaPages],
      ],
    ],
    [
      'Audiobooks in ' + selectedDate.toLocaleString('default', { month: 'long' }),
      [
        ['Time listening', formatMinutes(data.listenedMinutes)],
      ],
    ],
  ].forEach(function (group) {
    const section = el('section', 'jellio-profile-stat-group');
    section.appendChild(el('h3', 'jellio-profile-stat-group-title', group[0]));
    const stats = el('div', 'jellio-profile-stats');
    group[1].forEach(function (pair) {
      const stat = el('div', 'jellio-profile-stat');
      const value = typeof pair[1] === 'string' ? pair[1] : Number(pair[1] || 0).toLocaleString();
      stat.appendChild(el('span', 'jellio-profile-stat-value', value));
      stat.appendChild(el('span', 'jellio-profile-stat-label', pair[0]));
      stats.appendChild(stat);
    });
    section.appendChild(stats);
    container.appendChild(section);
  });

  return container;
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
  const isOwner = String(userId).replace(/-/g, '').toLowerCase() === String(currentUserId || '').replace(/-/g, '').toLowerCase();

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
      getCurrentUser().catch(function () { return null; }),
    ]);
  } catch (err) {
    console.warn('Jellio: could not load profile', err);
    renderRetry(root, describeNetworkFailure('this profile', err), function () {
      renderProfile(root, params);
    }, { onBack: function () { navigateTo('#/home'); }, backLabel: 'Back to Home' });
    return;
  }

  root.textContent = '';

  const isAdmin = !!(viewer && viewer.Policy && viewer.Policy.IsAdministrator);
  const canRemoveActivity = isOwner || isAdmin;

  root.appendChild(
    buildBanner(userId, isOwner, function () {
      renderProfile(root, params);
    }),
  );

  const header = el('div', 'jellio-profile-header');
  const imageTag = user.PrimaryImageTag;
  header.appendChild(
    buildAvatar(userId, imageTag, isOwner, function () {
      renderProfile(root, params);
    }),
  );

  const identity = el('div', 'jellio-profile-identity');
  const nameRow = el('div', 'jellio-profile-name-row');
  nameRow.appendChild(el('h1', 'jellio-profile-name', user.Name || ''));
  if (isOwner && profile.IsPrivate) {
    nameRow.appendChild(el('span', 'jellio-profile-private-chip', 'Private'));
  }
  identity.appendChild(nameRow);
  identity.appendChild(
    buildBioSection(userId, profile.Bio, isOwner, function () {
      /* bio already updated in place */
    }),
  );
  header.appendChild(identity);
  root.appendChild(header);

  const body = el('div', 'jellio-profile-body');
  if (achievements.IsPrivate) {
    body.appendChild(buildLockedPanel());
  } else {
    const refresh = function () {
      renderProfile(root, params);
    };

    const badges = achievements.Badges || [];
    const unlockedBadgesCount = badges.filter(function (b) { return b.Unlocked; }).length;
    const activities = achievements.RecentActivity || [];

    // Profile top navigation tabs
    let activeTab = 'stats'; // 'stats', 'badges', 'activity'
    const navTabs = el('div', 'jellio-profile-nav-tabs');
    const tabs = [
      { key: 'stats', label: 'Overview & Stats', icon: 'analytics' },
      { key: 'badges', label: 'Badges (' + unlockedBadgesCount + '/' + badges.length + ')', icon: 'military_tech' },
      { key: 'activity', label: 'Recent Activity (' + activities.length + ')', icon: 'history' },
    ];

    const tabContentContainer = el('div', 'jellio-profile-tab-content');

    // Stats View state: two-item toggle ('lifetime' or 'monthly')
    let activeStatMode = 'lifetime';
    let selectedMonthDate = new Date();

    function renderStatsTab() {
      tabContentContainer.textContent = '';

      // Two-item toggle menu buttons placed side-by-side
      const statsToggleWrap = el('div', 'jellio-profile-stats-toggle-wrap');
      const statsToggle = el('div', 'jellio-profile-stats-toggle');

      const lifetimeBtn = el('button', 'jellio-profile-stats-toggle-btn' + (activeStatMode === 'lifetime' ? ' jellio-profile-stats-toggle-btn-active' : ''), 'Lifetime Stats');
      lifetimeBtn.type = 'button';
      lifetimeBtn.addEventListener('click', function () {
        if (activeStatMode === 'lifetime') return;
        activeStatMode = 'lifetime';
        renderStatsTab();
      });
      statsToggle.appendChild(lifetimeBtn);

      const monthlyBtn = el('button', 'jellio-profile-stats-toggle-btn' + (activeStatMode === 'monthly' ? ' jellio-profile-stats-toggle-btn-active' : ''), 'Monthly Stats');
      monthlyBtn.type = 'button';
      monthlyBtn.addEventListener('click', function () {
        if (activeStatMode === 'monthly') return;
        activeStatMode = 'monthly';
        renderStatsTab();
      });
      statsToggle.appendChild(monthlyBtn);
      statsToggleWrap.appendChild(statsToggle);

      tabContentContainer.appendChild(statsToggleWrap);

      if (activeStatMode === 'lifetime') {
        tabContentContainer.appendChild(buildLifetimeStats(achievements));
      } else {
        tabContentContainer.appendChild(buildMonthlyStats(achievements, selectedMonthDate, function (newDate) {
          selectedMonthDate = newDate;
          renderStatsTab();
        }));
      }

      // Quick Badges showcase at the bottom of the stats overview
      if (badges.length) {
        tabContentContainer.appendChild(buildBadgesSection(badges, isAdmin, userId, refresh));
      }
    }

    function renderActiveTab() {
      Array.prototype.forEach.call(navTabs.children, function (btn) {
        btn.classList.toggle('jellio-profile-nav-tab-active', btn.dataset.tab === activeTab);
      });

      if (activeTab === 'stats') {
        renderStatsTab();
      } else if (activeTab === 'badges') {
        tabContentContainer.textContent = '';
        tabContentContainer.appendChild(buildBadgesSection(badges, isAdmin, userId, refresh));
      } else if (activeTab === 'activity') {
        tabContentContainer.textContent = '';
        tabContentContainer.appendChild(buildActivitySection(activities, canRemoveActivity, userId, refresh));
      }
    }

    tabs.forEach(function (tab) {
      const btn = el('button', 'jellio-profile-nav-tab' + (tab.key === activeTab ? ' jellio-profile-nav-tab-active' : ''));
      btn.type = 'button';
      btn.dataset.tab = tab.key;
      btn.appendChild(el('span', 'material-icons', tab.icon));
      btn.appendChild(document.createTextNode(tab.label));
      btn.addEventListener('click', function () {
        if (activeTab === tab.key) return;
        activeTab = tab.key;
        renderActiveTab();
      });
      navTabs.appendChild(btn);
    });

    body.appendChild(navTabs);
    body.appendChild(tabContentContainer);
    renderActiveTab();

    if (isAdmin) {
      body.appendChild(buildAdminDangerZone(userId, refresh));
    }
  }
  root.appendChild(body);
}
