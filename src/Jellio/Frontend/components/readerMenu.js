import { t } from '../runtime/i18n.js';
import { showToast } from './toast.js';
import { clearAudiobookResume, invalidateStreamLibrary, markAudiobookListened, markReadingItems, removeBookFromLibrary } from '../runtime/apiBooks.js';
import { invalidateUserDataRows } from '../runtime/api.js';
import { dismissSeriesContinue, invalidateShelf, setInLibrary } from '../runtime/shelf.js';
import { readingMenuOptions } from './readingListControls.js';
import { isMangaItem, readingTargetForItem } from '../runtime/readingListHelpers.js';
import { mangaSeriesTitle } from './mangaSeries.js';
import { chapterSeriesKey } from './continueRows.js';

// The card menu of a book, an audiobook or a manga chapter, the same on
// every screen that shows one: read state, reading list, taking it out of
// Continue reading and out of the library.

export function readerKindOf(item) {
  if (item && item.Type === 'AudioBook') return 'audiobook';
  return isMangaItem(item) ? 'manga' : 'ebook';
}

export function markOption(kind, read, run) {
  const audio = kind === 'audiobook';
  const key = audio
    ? read ? 'reader_menu_mark_listened' : 'reader_menu_mark_unlistened'
    : read ? 'reader_menu_mark_read' : 'reader_menu_mark_unread';
  return { label: t(key), icon: read ? 'done_all' : 'remove_done', onClick: run };
}

export function removeContinueOption(kind, run) {
  return {
    label: t(kind === 'audiobook' ? 'reader_menu_remove_continue_listening' : 'reader_menu_remove_continue_reading'),
    icon: 'playlist_remove',
    danger: true,
    onClick: run,
  };
}

export function removeLibraryOption(kind, run) {
  return { label: t('reader_menu_remove_library'), icon: kind === 'manga' ? 'heart_broken' : 'delete', danger: true, onClick: run };
}

export function confirmRemoval(kind, title) {
  return window.confirm(t(kind === 'manga' ? 'reader_remove_confirm_manga' : 'bookshelf_remove_confirm', { title: title }));
}

// The toast for what the server did: only this reader's copy ("personal"),
// or the book itself ("full"), whose files may have stayed.
export function announceRemoval(result, title) {
  if (result && result.Mode === 'personal') showToast(t('reader_removed_personal'));
  else if (result && result.LibraryOnly > 0) showToast(t('reader_removed_files_kept', { title: title }));
  else showToast(t('reader_removed_server', { title: title }));
}

// Removes a book or audiobook from this reader's library (the server keeps
// it when others have it). Resolves with the server's answer.
export function removeBook(kind, item, title) {
  return removeBookFromLibrary(kind, { ItemId: item.Id }).then(function (result) {
    invalidateShelf();
    invalidateUserDataRows();
    announceRemoval(result, title);
    return result;
  });
}

// Takes it out of Continue reading or listening for good: a book's progress
// cleared, an audiobook's resume position zeroed, a manga series dismissed
// until it is read again (kept on the server, so on every device).
export function clearContinue(kind, item, seriesKey, lastReadAt) {
  if (kind === 'audiobook') return clearAudiobookResume(item);
  if (kind === 'manga' && seriesKey) return dismissSeriesContinue(seriesKey, lastReadAt);
  return markReadingItems([item.Id], false);
}

// The options for one card. ctx: continueRow (the card is on a Continue
// row), onRemoved (the card left the screen), onChanged (its state moved).
export function readerItemOptions(item, ctx) {
  const c = ctx || {};
  const kind = readerKindOf(item);
  const title = item.Name || '';
  const data = item.UserData || {};
  const finished = !!data.Played || (kind !== 'audiobook' && data.PlayedPercentage >= 98);
  const read = !finished;
  const options = [];

  options.push(
    markOption(kind, read, function () {
      const done = kind === 'audiobook' ? markAudiobookListened(item, read) : markReadingItems([item.Id], read);
      done
        .then(function () {
          item.UserData = Object.assign({}, item.UserData, { Played: read, PlayedPercentage: read ? 100 : 0 });
          if (c.continueRow && c.onRemoved) c.onRemoved();
          else if (c.onChanged) c.onChanged(item);
        })
        .catch(function (err) {
          console.warn('Jellio: could not update read state', err);
          showToast(t('reader_update_failed'));
        });
    }),
  );

  options.push(...readingMenuOptions(readingTargetForItem(item, kind === 'manga')));

  const seriesKey = kind === 'manga' ? chapterSeriesKey(item) : '';
  if (c.continueRow) {
    options.push(
      removeContinueOption(kind, function () {
        clearContinue(kind, item, seriesKey, item.JellioUpdatedAt)
          .then(function () {
            invalidateUserDataRows();
            if (c.onRemoved) c.onRemoved();
          })
          .catch(function (err) {
            console.warn('Jellio: could not remove from continue reading', err);
            showToast(t('reader_update_failed'));
          });
      }),
    );
  }

  if (kind !== 'manga' || seriesKey) {
    options.push(
      removeLibraryOption(kind, function () {
        const name = kind === 'manga' ? mangaSeriesTitle(item) || title : title;
        if (!confirmRemoval(kind, name)) return;
        const done =
          kind === 'manga'
            ? (invalidateStreamLibrary(), setInLibrary(seriesKey, false).then(invalidateUserDataRows))
            : removeBook(kind, item, name);
        done
          .then(function () {
            if (c.onRemoved) c.onRemoved();
          })
          .catch(function (err) {
            console.warn('Jellio: could not remove from the library', err);
            showToast(t(kind === 'manga' ? 'toast_remove_library_error' : 'toast_remove_error'));
          });
      }),
    );
  }
  return options;
}
