import { t } from '../runtime/i18n.js';
import { setPlayed, setWatchlist, setItemRating, hideSeriesFromNextUp, scanIntroCreditsForItem } from '../runtime/api.js';
import { navigateTo } from '../runtime/router.js';
import { isGrouplistEnabled } from '../runtime/grouplistSettings.js';
import { ensureGrouplistIdsLoaded, isOnGrouplistSync, toggleGrouplist } from '../runtime/grouplistMembership.js';
import { isAdminSync } from '../runtime/adminStatus.js';
import { isSkipIntroCreditsMenuEnabled } from '../runtime/introCreditsMenuSetting.js';
import { showToast } from './toast.js';
import { shareItem } from '../runtime/shareLink.js';
import { canDownload } from './downloadSupport.js';
import { el } from '../runtime/dom.js';
import { cssUrl } from '../runtime/safeUrl.js';

const MENU_ID = 'jellioCardOptionsMenu';
const HOLD_MS = 500;

function closeMenu() {
  const existing = document.getElementById(MENU_ID);
  if (existing) existing.remove();
  document.removeEventListener('keydown', handleKeydown);
  document.removeEventListener('pointerdown', handleOutsideClick, true);
}

function handleKeydown(event) {
  if (event.key === 'Escape') closeMenu();
}

function handleOutsideClick(event) {
  const menu = document.getElementById(MENU_ID);
  if (menu && !menu.contains(event.target)) closeMenu();
}

function buildOption(label, iconName, onClick, danger) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'jellio-card-options-item' + (danger ? ' jellio-card-options-item-danger' : '');
  button.appendChild(el('span', 'jellio-card-options-item-label', label));
  button.appendChild(el('span', 'material-icons jellio-card-options-item-icon ' + iconName));
  button.addEventListener('click', function () {
    closeMenu();
    onClick();
  });
  return button;
}

function positionMenu(menu, anchorRect) {
  const menuWidth = 220;
  let left = anchorRect.left;
  if (left + menuWidth > window.innerWidth - 16) {
    left = window.innerWidth - menuWidth - 16;
  }
  let top = anchorRect.bottom + 6;
  menu.style.left = Math.max(16, left) + 'px';
  menu.style.top = top + 'px';
}

export function toggleWatched(item, options, onChanged) {
  const opts = options || {};
  const prevUserData = item.UserData ? Object.assign({}, item.UserData) : undefined;
  const isPlayed = !!(item.UserData && item.UserData.Played);
  if (opts.continueWatching) {
    item.UserData = Object.assign({}, item.UserData, { Played: true });
    if (opts.onRemoved) opts.onRemoved();
    return setPlayed(item.Id, true).then(
      function (updated) {
        if (updated && typeof updated === 'object') {
          item.UserData = Object.assign({}, item.UserData, updated);
        }
        return item.UserData;
      },
      function (err) {
        item.UserData = prevUserData;
        throw err;
      },
    );
  }
  const willBePlayed = !isPlayed;
  item.UserData = Object.assign({}, item.UserData, { Played: willBePlayed });
  if (opts.upNext && willBePlayed && opts.onRemoved) {
    opts.onRemoved();
  } else if (onChanged) {
    onChanged(item);
  }
  return setPlayed(item.Id, willBePlayed).then(
    function (updated) {
      if (updated && typeof updated === 'object') {
        item.UserData = Object.assign({}, item.UserData, updated);
      }
      return item.UserData;
    },
    function (err) {
      item.UserData = prevUserData;
      if (onChanged) onChanged(item);
      throw err;
    },
  );
}

export function toggleWatchlist(item, onChanged) {
  const prevUserData = item.UserData ? Object.assign({}, item.UserData) : undefined;
  const isWatchlisted = !!(item.UserData && item.UserData.IsFavorite);
  item.UserData = Object.assign({}, item.UserData, { IsFavorite: !isWatchlisted });
  if (onChanged) onChanged(item);
  return setWatchlist(item.Id, !isWatchlisted).then(
    function (updated) {
      if (updated && typeof updated === 'object') {
        item.UserData = Object.assign({}, item.UserData, updated);
      }
      return item.UserData;
    },
    function (err) {
      item.UserData = prevUserData;
      if (onChanged) onChanged(item);
      throw err;
    },
  );
}

export function toggleRating(item, likes, onChanged) {
  const prevUserData = item.UserData ? Object.assign({}, item.UserData) : undefined;
  const current = item.UserData && item.UserData.Likes;
  const next = current === likes ? null : likes;
  item.UserData = Object.assign({}, item.UserData, { Likes: next });
  if (onChanged) onChanged(item);
  return setItemRating(item.Id, next).then(
    function (updated) {
      if (updated && typeof updated === 'object') {
        item.UserData = Object.assign({}, item.UserData, updated);
      }
      return item.UserData;
    },
    function (err) {
      item.UserData = prevUserData;
      if (onChanged) onChanged(item);
      throw err;
    },
  );
}

function restartFromBeginning(item) {
  return setPlayed(item.Id, true)
    .then(function () {
      return setPlayed(item.Id, false);
    })
    .then(function (updated) {
      item.UserData = updated;
      navigateTo('#/play?id=' + item.Id);
      return updated;
    });
}

export function findSkipTimestamps(itemId, itemName, useAnalyzerFallback) {
  showToast(t('skip_looking', { title: itemName || t('account_this_user') }));
  scanIntroCreditsForItem(itemId, useAnalyzerFallback)
    .then(function (result) {
      const communityHits = (result && result.CommunityHits) || 0;
      const analyzerHits = (result && result.AnalyzerHits) || 0;
      const scanned = (result && result.EpisodesScanned) || 1;
      showToast(t('skip_found_count', { hits: communityHits + analyzerHits, total: scanned }));
    })
    .catch(function (err) {
      console.warn('Jellio: could not scan for skip timestamps', err);
      showToast(t('toast_skip_timestamps_error'));
    });
}

export function openCardOptionsMenu(item, anchorRect, onChanged, options) {
  closeMenu();
  const opts = options || {};

  const menu = document.createElement('div');
  menu.id = MENU_ID;
  menu.className = 'jellio-card-options-menu';
  menu.setAttribute('role', 'menu');
  positionMenu(menu, anchorRect);

  // Screen-specific actions first (e.g. a shelf's Categories), and only
  // those for cards that aren't one playable item.
  const extraOptions = typeof opts.extraOptions === 'function' ? opts.extraOptions(item) : opts.extraOptions;
  (extraOptions || []).forEach(function (option) {
    menu.appendChild(buildOption(option.label, option.icon, option.onClick));
  });

  if (!opts.onlyExtra && item && item.Id) {
    menu.appendChild(
      buildOption(t('menu_share_link'), 'share', function () {
        shareItem(item)
          .then((result) => {
            if (result === 'copied') showToast(t('toast_link_copied'));
          })
          .catch(() => showToast(t('toast_copy_link_error')));
      }),
    );
  }

  if (opts.onlyExtra) {
    // Nothing item-specific applies.
  } else if (opts.continueWatching) {
    menu.appendChild(
      buildOption(t('menu_go_to_details'), 'info', function () {
        navigateTo('#/item?id=' + item.Id);
      }),
    );
    menu.appendChild(
      buildOption(t('menu_play_manually'), 'play_arrow', function () {
        import('./streamPicker.js')
          .then(function (m) {
            m.openStreamPicker(item, { forceChoice: true });
          })
          .catch(function (err) {
            console.warn('Jellio: could not open the stream picker', err);
          });
      }),
    );
    menu.appendChild(
      buildOption(t('menu_start_beginning'), 'replay', function () {
        restartFromBeginning(item).catch(function (err) {
          console.warn('Jellio: could not start over', err);
          showToast(t('toast_start_over_error'));
        });
      }),
    );
    menu.appendChild(
      buildOption(
        t('menu_remove_continue'),
        'delete',
        function () {
          toggleWatched(item, opts, onChanged).catch(function (err) {
            console.warn('Jellio: could not remove from continue watching', err);
            showToast(t('toast_remove_continue_error'));
          });
        },
        true,
      ),
    );
  } else if (opts.upNext) {
    menu.appendChild(
      buildOption(t('menu_go_to_details'), 'info', function () {
        navigateTo('#/item?id=' + item.Id);
      }),
    );
    menu.appendChild(
      buildOption(
        t('menu_remove_up_next'),
        'delete',
        function () {
          toggleWatched(item, opts, onChanged).catch(function (err) {
            console.warn('Jellio: could not remove from up next', err);
            showToast(t('toast_remove_upnext_error'));
          });
        },
        true,
      ),
    );
    if (item.SeriesId) {
      menu.appendChild(
        buildOption(
          t('menu_remove_show_up_next'),
          'playlist_remove',
          function () {
            hideSeriesFromNextUp(item.SeriesId)
              .then(function () {
                if (opts.onRemoved) opts.onRemoved();
              })
              .catch(function (err) {
                console.warn('Jellio: could not remove show from up next', err);
                showToast(t('toast_remove_upnext_error'));
              });
          },
          true,
        ),
      );
    }
  } else {
    const isWatchlisted = !!(item.UserData && item.UserData.IsFavorite);
    menu.appendChild(
      buildOption(
        isWatchlisted ? t('menu_remove_watchlist') : t('menu_add_watchlist'),
        isWatchlisted ? 'bookmark_added' : 'bookmark_add',
        function () {
          toggleWatchlist(item, onChanged).catch(function (err) {
            console.warn('Jellio: could not update watchlist state', err);
            showToast(t('toast_watchlist_error'));
          });
        },
      ),
    );
    if (isGrouplistEnabled()) {
      ensureGrouplistIdsLoaded();
      const isGrouplisted = isOnGrouplistSync(item.Id);
      menu.appendChild(
        buildOption(
          isGrouplisted ? t('menu_remove_grouplist') : t('menu_add_grouplist'),
          isGrouplisted ? 'playlist_add_check' : 'playlist_add',
          function () {
            toggleGrouplist(item.Id).catch(function (err) {
              console.warn('Jellio: could not update grouplist state', err);
              showToast(t('toast_grouplist_error'));
            });
          },
        ),
      );
    }
    const isPlayed = !!(item.UserData && item.UserData.Played);
    menu.appendChild(
      buildOption(isPlayed ? t('detail_mark_unwatched') : t('detail_mark_watched'), 'check', function () {
        toggleWatched(item, opts, onChanged).catch(function (err) {
          console.warn('Jellio: could not update watched state', err);
          showToast(t('toast_watched_error'));
        });
      }),
    );
    // Keep it on this device (components/downloads.js): an episode or
    // film asks for the quality, a season or series which episodes.
    if (canDownload(item)) {
      menu.appendChild(
        buildOption(item.Type === 'Series' || item.Type === 'Season' ? t('menu_download_episodes') : t('menu_download'), 'download', function () {
          import('./downloads.js')
            .then(function (m) {
              m.promptDownload(item, anchorRect);
            })
            .catch(function (err) {
              console.warn('Jellio: could not start the download', err);
            });
        }),
      );
    }
    if (isAdminSync() && isSkipIntroCreditsMenuEnabled() && item.Type === 'Movie') {
      menu.appendChild(
        buildOption(t('menu_find_skip'), 'search', function () {
          findSkipTimestamps(item.Id, item.Name, false);
        }),
      );
    } else if (isAdminSync() && isSkipIntroCreditsMenuEnabled() && item.Type === 'Series') {
      menu.appendChild(
        buildOption(t('menu_quick_skip'), 'bolt', function () {
          findSkipTimestamps(item.Id, item.Name, false);
        }),
      );
      menu.appendChild(
        buildOption(t('menu_deep_skip'), 'travel_explore', function () {
          findSkipTimestamps(item.Id, item.Name, true);
        }),
      );
    }
  }

  document.body.appendChild(menu);
  document.addEventListener('keydown', handleKeydown);
  window.setTimeout(function () {
    document.addEventListener('pointerdown', handleOutsideClick, true);
  }, 0);

  const first = menu.querySelector('button');
  if (first) first.focus();
}

function plainRemoval(card) {
  card.classList.add('jellio-card-removing');
  function finish() {
    card.removeEventListener('transitionend', finish);
    if (card.parentNode) card.parentNode.removeChild(card);
  }
  card.addEventListener('transitionend', finish);
  window.setTimeout(finish, 400);
}

const SNAP_COLUMNS = 7;
const SNAP_ROWS = 10;
const SNAP_SHARD_MS = 550;

export function animateCardRemoval(card) {
  const image = card.querySelector('.jellio-card-image');
  const canShatter = image && image.tagName === 'IMG' && image.currentSrc;
  if (!canShatter) {
    plainRemoval(card);
    return;
  }

  const rect = card.getBoundingClientRect();
  const overlay = document.createElement('div');
  overlay.className = 'jellio-card-snap-overlay';
  overlay.style.left = rect.left + 'px';
  overlay.style.top = rect.top + 'px';
  overlay.style.width = rect.width + 'px';
  overlay.style.height = rect.height + 'px';

  const shardWidth = rect.width / SNAP_COLUMNS;
  const shardHeight = rect.height / SNAP_ROWS;
  let maxDelayMs = 0;

  for (let row = 0; row < SNAP_ROWS; row++) {
    for (let col = 0; col < SNAP_COLUMNS; col++) {
      const shard = document.createElement('div');
      shard.className = 'jellio-card-snap-shard';
      shard.style.left = col * shardWidth + 'px';
      shard.style.top = row * shardHeight + 'px';
      shard.style.width = shardWidth + 'px';
      shard.style.height = shardHeight + 'px';
      shard.style.backgroundImage = cssUrl(image.currentSrc);
      shard.style.backgroundSize = rect.width + 'px ' + rect.height + 'px';
      shard.style.backgroundPosition = -(col * shardWidth) + 'px ' + -(row * shardHeight) + 'px';
      const delayMs = col * 45 + Math.random() * 90;
      shard.style.setProperty('--jellio-snap-drift-x', (Math.random() - 0.3) * 40 + 'px');
      shard.style.setProperty('--jellio-snap-drift-y', -(30 + Math.random() * 50) + 'px');
      shard.style.setProperty('--jellio-snap-rotate', (Math.random() - 0.5) * 50 + 'deg');
      shard.style.animationDelay = delayMs + 'ms';
      overlay.appendChild(shard);
      maxDelayMs = Math.max(maxDelayMs, delayMs);
    }
  }

  document.body.appendChild(overlay);
  card.style.visibility = 'hidden';

  window.setTimeout(
    function () {
      overlay.remove();
      if (card.parentNode) card.parentNode.removeChild(card);
    },
    maxDelayMs + SNAP_SHARD_MS + 50,
  );
}

export function attachCardOptionsTrigger(card, item, onChanged, options) {
  const opts = options || {};

  function trigger() {
    openCardOptionsMenu(
      item,
      card.getBoundingClientRect(),
      onChanged,
      Object.assign({}, opts, {
        onRemoved: function () {
          animateCardRemoval(card);
        },
      }),
    );
  }

  card.addEventListener('contextmenu', function (event) {
    event.preventDefault();
    trigger();
  });

  let holdTimer = null;

  function cancelHold() {
    if (holdTimer) {
      window.clearTimeout(holdTimer);
      holdTimer = null;
    }
  }

  card.addEventListener('pointerdown', function (event) {
    if (event.button !== 0) return;
    cancelHold();
    holdTimer = window.setTimeout(function () {
      holdTimer = null;
      trigger();
    }, HOLD_MS);
  });
  card.addEventListener('pointerup', cancelHold);
  card.addEventListener('pointerleave', cancelHold);
  card.addEventListener('pointercancel', cancelHold);
}
