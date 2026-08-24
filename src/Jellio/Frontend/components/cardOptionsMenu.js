// Quick actions on a poster card without leaving the row it lives in,
// ported in spirit from NuvioWeb's own posterOptionsMenu.js (its own
// screens open it on a held remote button, real Jellyfin.PlayedItems and
// FavoriteItems endpoints doing the actual state change either way,
// reimplemented for a mouse/keyboard/touch web target as a right click
// or a held pointer rather than a held focus key).
import { setPlayed, setWatchlist } from '../runtime/api.js';
import { navigateTo } from '../runtime/router.js';

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

function buildOption(label, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'jellio-card-options-item';
  button.textContent = label;
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

export function openCardOptionsMenu(item, anchorRect, onChanged, options) {
  closeMenu();
  const opts = options || {};

  const menu = document.createElement('div');
  menu.id = MENU_ID;
  menu.className = 'jellio-card-options-menu';
  menu.setAttribute('role', 'menu');
  positionMenu(menu, anchorRect);

  menu.appendChild(
    buildOption('Go to details', function () {
      navigateTo('#/item?id=' + item.Id);
    }),
  );

  // Jellyfin itself has no endpoint that clears a saved resume
  // position on its own (confirmed against jellyfin-web's and the
  // server's own real source before writing this): PlaystateController's
  // own UpdatePlayedStatus is the only place PlaybackPositionTicks ever
  // gets reset, and it is the exact same POST/DELETE PlayedItems call
  // setPlayed() below already wraps for the ordinary Mark as
  // watched/unwatched toggle everywhere else. A Continue Watching card
  // asking to leave that row is really asking for this same real
  // call, just under the label that actually describes what a reader
  // wants there, not a second, invented endpoint.
  const userData = item.UserData || {};
  const isPlayed = !!userData.Played;
  if (opts.continueWatching) {
    const removeOption = buildOption('Remove from Continue Watching', function () {
      setPlayed(item.Id, true)
        .then(function (updated) {
          item.UserData = updated;
          if (opts.onRemoved) opts.onRemoved();
        })
        .catch(function (err) {
          console.warn('Jellio: could not remove from continue watching', err);
        });
    });
    menu.appendChild(removeOption);
  } else {
    const playedOption = buildOption(isPlayed ? 'Mark as unwatched' : 'Mark as watched', function () {
      const willBePlayed = !isPlayed;
      setPlayed(item.Id, willBePlayed)
        .then(function (updated) {
          item.UserData = updated;
          // An Up Next card is real Jellyfin NextUp state (the next
          // real unwatched episode of a show), not a badge to repaint
          // in place: marking that exact episode watched means it is
          // real, immediately no longer next up (whichever episode
          // actually is now only shows up on this row's own next real
          // refetch), so leaving the card sitting there under a
          // checkmark instead of actually leaving the row read live as
          // marking watched not doing anything.
          if (opts.upNext && willBePlayed && opts.onRemoved) {
            opts.onRemoved();
          } else if (onChanged) {
            onChanged(item);
          }
        })
        .catch(function (err) {
          console.warn('Jellio: could not update watched state', err);
        });
    });
    menu.appendChild(playedOption);
  }

  const isWatchlisted = !!userData.IsFavorite;
  const watchlistOption = buildOption(
    isWatchlisted ? 'Remove from Watchlist' : 'Add to Watchlist',
    function () {
      setWatchlist(item.Id, !isWatchlisted)
        .then(function (updated) {
          item.UserData = updated;
          if (onChanged) onChanged(item);
        })
        .catch(function (err) {
          console.warn('Jellio: could not update watchlist state', err);
        });
    },
  );
  menu.appendChild(watchlistOption);

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

// Nuvio's own real removal animation on its Continue Watching action
// sheet (a spring-collapse plus a haptic tick, confirmed against its
// real source before writing this) has nothing to fire a haptic
// through on the web, so a real visible dissolve stands in for it
// here: the card fades, shrinks and blurs out in place, then leaves
// the row's own flex layout to close the gap itself once it is
// actually gone, rather than just repainting a badge over a card that
// is still sitting there once the reader already asked for it to
// leave.
function animateCardRemoval(card) {
  card.classList.add('jellio-card-removing');
  function finish() {
    card.removeEventListener('transitionend', finish);
    if (card.parentNode) card.parentNode.removeChild(card);
  }
  card.addEventListener('transitionend', finish);
  // A transitionend can be dropped (a parent re-layout mid transition,
  // a reader switching tabs), same reasoning every other timer backed
  // fallback in this codebase already uses rather than leaving a
  // half faded card stuck in the row forever.
  window.setTimeout(finish, 400);
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
