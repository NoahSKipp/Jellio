import { t } from '../runtime/i18n.js';
import { removeFromReadingList, searchBooksByTitle, loadFriends, friendsSupported, getFriendsSnapshot } from '../runtime/api.js';
import { getServerAddress, getAccessToken } from '../runtime/auth.js';
import { readingCoverSrc, readingEntryRoute, readingKindLabelKey, readingCardItem, sameTitle } from '../runtime/readingListHelpers.js';
import { shareReadingTarget } from './readingListControls.js';
import { navigateTo } from '../runtime/router.js';
import { attachCardOptionsTrigger, animateCardRemoval } from './cardOptionsMenu.js';
import { buildAddedByBadge } from './card.js';
import { getMangaShelfHash } from './navShared.js';
import { showToast } from './toast.js';
import { el } from '../runtime/dom.js';

const KIND_ICON = { ebook: 'menu_book', audiobook: 'headphones', manga: 'collections_bookmark' };

// The reading-list entry as the share target the friend picker sends.
function shareTarget(entry) {
  const target = { Key: entry.Key, Kind: entry.Kind, Title: entry.Title };
  if (entry.ItemId) target.ItemId = entry.ItemId;
  if (entry.Author) target.Author = entry.Author;
  if (entry.CoverUrl) target.CoverUrl = entry.CoverUrl;
  if (entry.MangaId) target.MangaId = entry.MangaId;
  return target;
}

// A book that is not a library item opens its library copy once there is
// one (found by title); until then it says so.
function openWork(entry) {
  searchBooksByTitle(entry.Title)
    .catch(function () {
      return [];
    })
    .then(function (found) {
      const type = entry.Kind === 'audiobook' ? 'AudioBook' : 'Book';
      const match = (found || []).find(function (item) {
        return item.Type === type && sameTitle(item.Name, entry.Title);
      });
      if (match) navigateTo('#/item?id=' + match.Id);
      else showToast(t('reading_not_in_library', { title: entry.Title }));
    });
}

function openEntry(entry) {
  const route = readingEntryRoute(entry);
  if (route.type === 'item') {
    navigateTo(route.hash);
  } else if (route.type === 'series') {
    getMangaShelfHash().then(function (shelf) {
      if (shelf) navigateTo(shelf + '&series=' + encodeURIComponent(route.seriesKey));
    });
  } else {
    openWork(entry);
  }
}

// A card for one reading-list entry on the Watchlist screen: cover, title,
// author, a kind badge, who added it and a remove action. onRemoved runs
// after the server has dropped it.
export function buildReadingCard(entry, onRemoved) {
  const item = readingCardItem(entry);
  const card = el('div', 'jellio-card');
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', entry.Title || '');

  const imageWrap = el('div', 'jellio-card-image-wrap');
  const src = readingCoverSrc(entry.Cover, getServerAddress(), getAccessToken());
  function placeholder() {
    const empty = el('div', 'jellio-card-image jellio-card-image-empty jellio-reading-card-empty');
    empty.appendChild(el('span', 'material-icons ' + KIND_ICON[entry.Kind]));
    imageWrap.insertBefore(empty, imageWrap.firstChild);
  }
  if (src) {
    const img = document.createElement('img');
    img.className = 'jellio-card-image';
    img.src = src;
    img.alt = entry.Title || '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', function () {
      img.remove();
      placeholder();
    });
    imageWrap.appendChild(img);
  } else {
    placeholder();
  }

  imageWrap.appendChild(el('span', 'jellio-card-kind-badge', t(readingKindLabelKey(entry.Kind))));
  if (item.AddedBy) imageWrap.appendChild(buildAddedByBadge(item.AddedBy));

  function remove() {
    removeFromReadingList(entry.Key).then(
      function () {
        animateCardRemoval(card);
        showToast(t('reading_toast_removed'));
        if (onRemoved) onRemoved(entry);
      },
      function (err) {
        console.warn('Jellio: could not remove from the reading list', err);
        showToast(t('reading_toast_error'));
      },
    );
  }

  const bar = el('div', 'jellio-card-actions');
  const removeButton = el('button', 'jellio-card-action jellio-card-action-watchlist jellio-card-action-active');
  removeButton.type = 'button';
  removeButton.setAttribute('aria-label', t('reading_remove_item', { title: entry.Title || '' }));
  removeButton.title = t('reading_remove');
  removeButton.appendChild(el('span', 'material-icons bookmark_added'));
  removeButton.addEventListener('click', function (event) {
    event.stopPropagation();
    remove();
  });
  bar.appendChild(removeButton);
  imageWrap.appendChild(bar);
  card.appendChild(imageWrap);

  card.appendChild(el('div', 'jellio-card-title', entry.Title || ''));
  if (entry.Author) card.appendChild(el('div', 'jellio-card-subtitle', entry.Author));

  card.addEventListener('click', function () {
    openEntry(entry);
  });
  card.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openEntry(entry);
    }
  });

  attachCardOptionsTrigger(card, item, null, {
    onlyExtra: true,
    extraOptions: function () {
      const options = [{ label: t('reading_remove'), icon: 'bookmark_added', onClick: remove }];
      if (friendsSupported() !== false) {
        const friends = getFriendsSnapshot();
        if (!friends) loadFriends().catch(function () {});
        else if (friends.Friends.length) {
          options.push({
            label: t('reading_menu_add_to_friend'),
            icon: 'person_add',
            onClick: function () {
              shareReadingTarget(shareTarget(entry), card).catch(function (err) {
                console.warn('Jellio: could not open the friend picker', err);
              });
            },
          });
        }
      }
      return options;
    },
  });
  return card;
}
