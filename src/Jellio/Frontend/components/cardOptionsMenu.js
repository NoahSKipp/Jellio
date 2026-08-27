// Quick actions on a poster card without leaving the row it lives in,
// ported in spirit from NuvioWeb's own posterOptionsMenu.js (its own
// screens open it on a held remote button, real Jellyfin.PlayedItems and
// FavoriteItems endpoints doing the actual state change either way,
// reimplemented for a mouse/keyboard/touch web target as a right click
// or a held pointer rather than a held focus key). Real feedback, two
// real Nuvio mobile screenshots: the menu's own real content is not one
// fixed set, a Continue Watching card offers Go to details/Play
// manually/Start from beginning/Remove, every other card offers
// Watchlist/Mark watched/Remove from Library, matched here rather than
// one generic list either context has to squint past.
import { setPlayed, setWatchlist, setItemRating, hideSeriesFromNextUp } from '../runtime/api.js';
import { navigateTo } from '../runtime/router.js';
import { openStreamPicker } from './streamPicker.js';
import { isGrouplistEnabled } from '../runtime/grouplistSettings.js';
import { ensureGrouplistIdsLoaded, isOnGrouplistSync, toggleGrouplist } from '../runtime/grouplistMembership.js';

const MENU_ID = 'jellioCardOptionsMenu';
const HOLD_MS = 500;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

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

// Jellyfin itself has no endpoint that clears a saved resume position
// on its own (confirmed against jellyfin-web's and the server's own
// real source before writing this): PlaystateController's own
// UpdatePlayedStatus is the only place PlaybackPositionTicks ever gets
// reset, and it is the exact same POST/DELETE PlayedItems call every
// ordinary Mark as watched/unwatched toggle already wraps. A Continue
// Watching card asking to leave that row is really asking for this
// same real call, just under whatever label/behaviour the caller
// actually wants there, not a second, invented endpoint. Shared by the
// dropdown's own Remove entry and components/card.js's own inline Mark
// Watched button, so both real call sites behave identically rather
// than drifting apart over time.
export function toggleWatched(item, options, onChanged) {
  const opts = options || {};
  const isPlayed = !!(item.UserData && item.UserData.Played);
  if (opts.continueWatching) {
    return setPlayed(item.Id, true).then(function (updated) {
      item.UserData = updated;
      if (opts.onRemoved) opts.onRemoved();
      return updated;
    });
  }
  const willBePlayed = !isPlayed;
  return setPlayed(item.Id, willBePlayed).then(function (updated) {
    item.UserData = updated;
    // An Up Next card is real Jellyfin NextUp state (the next real
    // unwatched episode of a show), not a badge to repaint in place:
    // marking that exact episode watched means it is real, immediately
    // no longer next up (whichever episode actually is now only shows
    // up on this row's own next real refetch), so leaving the card
    // sitting there under a checkmark instead of actually leaving the
    // row read live as marking watched not doing anything.
    if (opts.upNext && willBePlayed && opts.onRemoved) {
      opts.onRemoved();
    } else if (onChanged) {
      onChanged(item);
    }
    return updated;
  });
}

export function toggleWatchlist(item, onChanged) {
  const isWatchlisted = !!(item.UserData && item.UserData.IsFavorite);
  return setWatchlist(item.Id, !isWatchlisted).then(function (updated) {
    item.UserData = updated;
    if (onChanged) onChanged(item);
    return updated;
  });
}

// Tapping the thumb already showing sets it back to real neither
// (real Jellyfin's own UserData.Likes has three states, true/false/
// absent, not just the two either thumb alone can reach on its own),
// tapping the other one flips straight to it instead. screens/detail.js's
// own thumbs pair both call this, likes true from the up one, false
// from the down one.
export function toggleRating(item, likes, onChanged) {
  const current = item.UserData && item.UserData.Likes;
  const next = current === likes ? null : likes;
  return setItemRating(item.Id, next).then(function (updated) {
    item.UserData = updated;
    if (onChanged) onChanged(item);
    return updated;
  });
}

// Same real gap toggleWatched's own header above already documents:
// no endpoint clears PlaybackPositionTicks on its own, only ever a
// side effect of UpdatePlayedStatus. Marking played and immediately
// unplayed again resets that same real position back to 0 without
// leaving the title stuck flagged watched, the only two real calls
// this can be done with.
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

export function openCardOptionsMenu(item, anchorRect, onChanged, options) {
  closeMenu();
  const opts = options || {};

  const menu = document.createElement('div');
  menu.id = MENU_ID;
  menu.className = 'jellio-card-options-menu';
  menu.setAttribute('role', 'menu');
  positionMenu(menu, anchorRect);

  if (opts.continueWatching) {
    menu.appendChild(
      buildOption('Go to details', 'info', function () {
        navigateTo('#/item?id=' + item.Id);
      }),
    );
    menu.appendChild(
      buildOption('Play manually', 'play_arrow', function () {
        openStreamPicker(item, { forceChoice: true });
      }),
    );
    menu.appendChild(
      buildOption('Start from beginning', 'replay', function () {
        restartFromBeginning(item).catch(function (err) {
          console.warn('Jellio: could not start over', err);
        });
      }),
    );
    menu.appendChild(
      buildOption(
        'Remove from Continue Watching',
        'delete',
        function () {
          toggleWatched(item, opts, onChanged).catch(function (err) {
            console.warn('Jellio: could not remove from continue watching', err);
          });
        },
        true,
      ),
    );
  } else if (opts.upNext) {
    menu.appendChild(
      buildOption('Go to details', 'info', function () {
        navigateTo('#/item?id=' + item.Id);
      }),
    );
    // Real gap, documented above on toggleWatched itself: Jellyfin has
    // no endpoint that just hides one title from NextUp on its own,
    // marking the episode played is the only real call that also drops
    // it off this row, same mechanism Continue Watching's own Remove
    // already leans on above.
    menu.appendChild(
      buildOption(
        'Remove from Up Next',
        'delete',
        function () {
          toggleWatched(item, opts, onChanged).catch(function (err) {
            console.warn('Jellio: could not remove from up next', err);
          });
        },
        true,
      ),
    );
    // Real feedback live: "Remove from Up Next" above only ever marks
    // this one episode played, which just advances the same series to
    // its own next episode on the row's very next fetch, not actually
    // leaving it. This one hides the whole series server side instead
    // (Controllers/NextUpHiddenController.cs), a real series stays gone
    // across a reload rather than resurfacing under its next episode.
    if (item.SeriesId) {
      menu.appendChild(
        buildOption(
          'Remove Show from Up Next',
          'playlist_remove',
          function () {
            hideSeriesFromNextUp(item.SeriesId)
              .then(function () {
                if (opts.onRemoved) opts.onRemoved();
              })
              .catch(function (err) {
                console.warn('Jellio: could not remove show from up next', err);
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
        isWatchlisted ? 'Remove from Watchlist' : 'Add to Watchlist',
        isWatchlisted ? 'bookmark_added' : 'bookmark_add',
        function () {
          toggleWatchlist(item, onChanged).catch(function (err) {
            console.warn('Jellio: could not update watchlist state', err);
          });
        },
      ),
    );
    if (isGrouplistEnabled()) {
      ensureGrouplistIdsLoaded();
      const isGrouplisted = isOnGrouplistSync(item.Id);
      menu.appendChild(
        buildOption(
          isGrouplisted ? 'Remove from Grouplist' : 'Add to Grouplist',
          isGrouplisted ? 'playlist_add_check' : 'playlist_add',
          function () {
            toggleGrouplist(item.Id).catch(function (err) {
              console.warn('Jellio: could not update grouplist state', err);
            });
          },
        ),
      );
    }
    const isPlayed = !!(item.UserData && item.UserData.Played);
    menu.appendChild(
      buildOption(isPlayed ? 'Mark as unwatched' : 'Mark as watched', 'check', function () {
        toggleWatched(item, opts, onChanged).catch(function (err) {
          console.warn('Jellio: could not update watched state', err);
        });
      }),
    );
  }

  document.body.appendChild(menu);
  document.addEventListener('keydown', handleKeydown);
  // Registered as capturing rather than bubbling, and one tick late,
  // so the same pointerdown/contextmenu that just opened this menu does
  // not immediately close it again on its way through document.
  window.setTimeout(function () {
    document.addEventListener('pointerdown', handleOutsideClick, true);
  }, 0);

  const first = menu.querySelector('button');
  if (first) first.focus();
}

// A plain fade/shrink/blur, the one real fallback for a card with no
// decoded poster image to shatter (animateCardRemoval below needs a
// real <img> to slice into shards): still reads as "this left", real
// removal underneath either way.
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

// Real feedback: Nuvio's own Continue Watching removal is a spring
// collapse plus a haptic tick on a real touch device, neither one
// reachable on the web (no haptic channel, and a plain height collapse
// already looked too much like an ordinary list reflow to read as a
// deliberate real removal). Asked for directly instead: a real Thanos
// snap, the poster's own decoded image sliced into a real grid of
// shards, each one fading, drifting and rotating away with a staggered
// left to right delay, not a uniform wave (a touch of real per-shard
// randomness inside each column reads far closer to the reference than
// a mechanical column by column sweep did in testing).
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
      shard.style.backgroundImage = 'url(' + image.currentSrc + ')';
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

// Right click opens the menu directly; a held pointer (touch, or a
// mouse without a right button) mirrors that same held-remote-button
// gesture the original screens key off. A drag or a real click before
// HOLD_MS elapses cancels it, same as a normal press-and-release.
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
