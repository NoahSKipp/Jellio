// One manga series from the Manga shelf (screens/bookshelf.js, reached
// with &series=<key>): its cover, how far the reader is, a button that
// picks up where they left off, and every chapter in reading order with
// its read state.
import { getBookshelfItems, getAllReadingProgress, getImageUrl } from '../runtime/api.js';
import { groupMangaSeries, chapterState, resumePoint, useSeriesCover } from '../components/mangaSeries.js';
import { buildDownloadButton, downloadBook } from '../components/downloads.js';
import { findAnyDownload, removeDownload } from '../runtime/offline.js';
import { loadShelf, onShelfChange, saveSeriesPrefs, seriesShelfKey, isBookmarked, setBookmark, categoriesOf } from '../runtime/shelf.js';
import { openCategoryPicker } from '../components/shelfCategories.js';
import { showToast } from '../components/toast.js';
import { navigateTo, setTitle } from '../runtime/router.js';
import { el } from '../runtime/dom.js';

function openChapter(item) {
  navigateTo('#/read?id=' + item.Id);
}

export function renderMangaSeries(root, params, parentId) {
  const key = params.get('series') || '';
  let cancelled = false;
  let descending = false;
  let shelf = { Categories: [], Series: {}, Bookmarks: [] };
  const shelfKey = seriesShelfKey(key);
  root.classList.add('jellio-screen-bookshelf', 'jellio-screen-manga-series');

  const header = el('header', 'jellio-library-header jellio-manga-series-header');
  const back = el('button', 'jellio-discover-back');
  back.type = 'button';
  back.setAttribute('aria-label', 'Back to Manga');
  back.appendChild(el('span', 'material-icons arrow_back'));
  back.addEventListener('click', function () {
    const shelf = new URLSearchParams(params);
    shelf.delete('series');
    navigateTo('#/books?' + shelf.toString());
  });
  header.appendChild(back);
  root.appendChild(header);

  const body = el('div', 'jellio-manga-series-body');
  root.appendChild(body);
  body.appendChild(el('p', 'jellio-bookshelf-stats', 'Loading…'));

  Promise.all([
    getBookshelfItems(parentId, 'manga', params.get('mangaLibrary') === '1'),
    getAllReadingProgress().catch(() => ({})),
    loadShelf('manga'),
  ])
    .then(function (results) {
      if (cancelled) return;
      const group = groupMangaSeries(results[0]).series.find((series) => series.key === key);
      const progress = results[1];
      shelf = results[2];
      body.textContent = '';
      if (!group) {
        body.appendChild(el('p', 'jellio-service-empty', 'This series isn’t on the shelf any more.'));
        return;
      }
      setTitle(group.title + ' - Jellio');
      render(group, progress);
    })
    .catch(function (err) {
      if (cancelled) return;
      console.warn('Jellio: could not load the series', err);
      body.textContent = '';
      body.appendChild(el('p', 'jellio-service-empty', 'Could not load this series. Try again in a moment.'));
    });

  function render(group, progress) {
    const chapters = group.chapters;
    const resume = resumePoint(chapters, progress);
    const prefs = Object.assign({}, shelf.Series[shelfKey]);
    descending = !!prefs.ChapterDescending;
    let filter = prefs.ChapterFilter || 'all';

    const hero = el('section', 'jellio-manga-series-hero');
    const cover = el('div', 'jellio-manga-series-cover');
    const coverItem = chapters.find((item) => item.ImageTags && item.ImageTags.Primary) || chapters[0];
    const img = document.createElement('img');
    img.alt = '';
    if (coverItem.ImageTags && coverItem.ImageTags.Primary) {
      img.setAttribute('src', getImageUrl(coverItem.Id, 'Primary', { tag: coverItem.ImageTags.Primary, maxWidth: 400 }));
    }
    cover.appendChild(img);
    useSeriesCover(img, chapters[0], function () {
      img.replaceWith(el('span', 'material-icons collections_bookmark'));
    });
    hero.appendChild(cover);

    const info = el('div', 'jellio-manga-series-info');
    info.appendChild(el('h1', 'jellio-library-title', group.title));
    info.appendChild(
      el(
        'p',
        'jellio-bookshelf-stats',
        chapters.length + ' chapters' + (resume.readCount ? ' · ' + resume.readCount + ' read' : ''),
      ),
    );
    const bar = el('div', 'jellio-manga-series-progress');
    const fill = el('div', 'jellio-manga-series-progress-fill');
    fill.style.width = Math.round((resume.readCount / chapters.length) * 100) + '%';
    bar.appendChild(fill);
    info.appendChild(bar);

    const actions = el('div', 'jellio-manga-series-actions');
    const next = resume.chapter || chapters[0];
    const primary = el('button', 'jellio-manga-series-continue');
    primary.type = 'button';
    primary.appendChild(el('span', 'material-icons ' + (resume.finished ? 'replay' : 'menu_book')));
    const label = resume.finished
      ? 'Read again'
      : resume.readCount || chapterState(next, progress).started
        ? 'Continue · ' + next.Name
        : 'Start reading';
    primary.appendChild(el('span', null, label));
    primary.addEventListener('click', function () {
      openChapter(next);
    });
    actions.appendChild(primary);

    // Everything not read yet, for reading offline (components/downloads.js).
    const unread = chapters.filter((chapter) => !chapterState(chapter, progress).read);
    if (unread.length) {
      const save = el('button', 'jellio-manga-series-order');
      save.type = 'button';
      save.appendChild(el('span', 'material-icons download'));
      save.appendChild(el('span', null, 'Download unread (' + unread.length + ')'));
      save.addEventListener('click', async function () {
        save.disabled = true;
        let queued = 0;
        for (const chapter of unread) {
          const existing = await findAnyDownload(chapter.Id);
          if (existing && existing.Status !== 'error') continue;
          try {
            await downloadBook(chapter, 'manga');
            queued += 1;
          } catch (err) {
            console.warn('Jellio: could not queue a chapter', err);
          }
        }
        showToast(queued ? 'Downloading ' + queued + (queued === 1 ? ' chapter.' : ' chapters.') : 'Unread chapters are already downloaded.');
        save.disabled = false;
      });
      actions.appendChild(save);
    }

    // Every downloaded chapter of this series off the device at once.
    const removeDownloads = el('button', 'jellio-manga-series-order');
    removeDownloads.type = 'button';
    removeDownloads.hidden = true;
    removeDownloads.appendChild(el('span', 'material-icons delete_sweep'));
    const removeLabel = el('span');
    removeDownloads.appendChild(removeLabel);
    let downloaded = [];
    Promise.all(chapters.map((chapter) => findAnyDownload(chapter.Id).catch(() => null))).then(function (found) {
      downloaded = found.filter(Boolean);
      if (cancelled || !downloaded.length) return;
      removeLabel.textContent = 'Remove downloads (' + downloaded.length + ')';
      removeDownloads.hidden = false;
    });
    removeDownloads.addEventListener('click', async function () {
      if (!window.confirm('Remove all ' + downloaded.length + ' downloaded chapters of “' + group.title + '” from this device?')) return;
      removeDownloads.disabled = true;
      for (const record of downloaded) {
        await removeDownload(record.Id).catch((err) => console.warn('Jellio: could not remove a download', err));
      }
      showToast('Removed ' + downloaded.length + ' chapters from this device.');
      removeDownloads.hidden = true;
    });
    actions.appendChild(removeDownloads);

    const categoriesButton = el('button', 'jellio-manga-series-order');
    categoriesButton.type = 'button';
    categoriesButton.appendChild(el('span', 'material-icons label'));
    const categoriesLabel = el('span');
    categoriesButton.appendChild(categoriesLabel);
    function paintCategories() {
      const names = categoriesOf(shelf, shelfKey).map((category) => category.Name);
      categoriesLabel.textContent = names.length ? names.join(', ') : 'Categories';
    }
    paintCategories();
    categoriesButton.addEventListener('click', () => openCategoryPicker('manga', [shelfKey], group.title));
    actions.appendChild(categoriesButton);
    info.appendChild(actions);

    // Mihon's per-series reading mode; the reader starts in it.
    const modes = [
      { label: 'Default', layout: '', direction: '' },
      { label: 'Right to left', layout: 'single', direction: 'rtl' },
      { label: 'Left to right', layout: 'single', direction: 'ltr' },
      { label: 'Vertical', layout: 'vertical', direction: '' },
    ];
    const modeRow = el('div', 'jellio-manga-series-mode');
    modeRow.appendChild(el('span', 'jellio-manga-series-mode-label', 'Reading mode'));
    function paintModes() {
      modeRow.querySelectorAll('button').forEach((button) => button.remove());
      modes.forEach(function (mode) {
        const active =
          (prefs.ComicLayout || '') === mode.layout && (mode.layout !== 'single' || (prefs.ComicDirection || '') === mode.direction);
        const chip = el('button', 'jellio-manga-series-chip' + (active ? ' jellio-manga-series-chip-active' : ''), mode.label);
        chip.type = 'button';
        chip.setAttribute('aria-pressed', active ? 'true' : 'false');
        chip.addEventListener('click', function () {
          prefs.ComicLayout = mode.layout || null;
          prefs.ComicDirection = mode.direction || null;
          paintModes();
          saveSeriesPrefs(shelfKey, { ComicLayout: mode.layout, ComicDirection: mode.direction }).catch(function (err) {
            console.warn('Jellio: could not save the reading mode', err);
          });
        });
        modeRow.appendChild(chip);
      });
    }
    paintModes();
    info.appendChild(modeRow);

    // Mihon's per-series notes.
    const note = el('div', 'jellio-manga-series-note');
    function paintNote(editing) {
      note.textContent = '';
      if (editing) {
        const area = document.createElement('textarea');
        area.maxLength = 4000;
        area.rows = 3;
        area.placeholder = 'Anything to remember about this series';
        area.value = prefs.Note || '';
        const save = el('button', 'jellio-manga-series-chip jellio-manga-series-chip-active', 'Save note');
        save.type = 'button';
        save.addEventListener('click', function () {
          prefs.Note = area.value.trim() || null;
          paintNote(false);
          saveSeriesPrefs(shelfKey, { Note: area.value }).catch(function (err) {
            console.warn('Jellio: could not save the note', err);
          });
        });
        note.appendChild(area);
        note.appendChild(save);
        area.focus();
        return;
      }
      if (prefs.Note) note.appendChild(el('p', 'jellio-manga-series-note-text', prefs.Note));
      const edit = el('button', 'jellio-manga-series-chip');
      edit.type = 'button';
      edit.appendChild(el('span', 'material-icons ' + (prefs.Note ? 'edit_note' : 'note_add')));
      edit.appendChild(el('span', null, prefs.Note ? 'Edit note' : 'Add note'));
      edit.addEventListener('click', () => paintNote(true));
      note.appendChild(edit);
    }
    paintNote(false);
    info.appendChild(note);
    hero.appendChild(info);
    body.appendChild(hero);

    const listTools = el('div', 'jellio-manga-series-tools');
    const filters = el('div', 'jellio-manga-series-filters');
    [
      { value: 'all', label: 'All' },
      { value: 'unread', label: 'Unread' },
      { value: 'bookmarked', label: 'Bookmarked' },
    ].forEach(function (option) {
      const chip = el('button', 'jellio-manga-series-chip', option.label);
      chip.type = 'button';
      chip.dataset.filter = option.value;
      chip.addEventListener('click', function () {
        filter = option.value;
        renderList();
        saveSeriesPrefs(shelfKey, { ChapterFilter: filter }).catch(function (err) {
          console.warn('Jellio: could not save the chapter filter', err);
        });
      });
      filters.appendChild(chip);
    });
    listTools.appendChild(filters);
    const order = el('button', 'jellio-manga-series-order');
    order.type = 'button';
    listTools.appendChild(order);
    body.appendChild(listTools);

    const list = el('ol', 'jellio-manga-chapter-list');
    body.appendChild(list);

    function renderList() {
      order.textContent = '';
      order.appendChild(el('span', 'material-icons ' + (descending ? 'arrow_downward' : 'arrow_upward')));
      order.appendChild(el('span', null, descending ? 'Newest first' : 'Oldest first'));
      list.textContent = '';
      filters.querySelectorAll('button').forEach(function (chip) {
        const active = chip.dataset.filter === filter;
        chip.classList.toggle('jellio-manga-series-chip-active', active);
        chip.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      const ordered = (descending ? chapters.slice().reverse() : chapters).filter(function (item) {
        if (filter === 'unread') return !chapterState(item, progress).read;
        if (filter === 'bookmarked') return isBookmarked(shelf, item.Id);
        return true;
      });
      if (!ordered.length) {
        list.appendChild(el('li', 'jellio-manga-chapter-empty', filter === 'bookmarked' ? 'No bookmarked chapters.' : 'Nothing left to read.'));
      }
      ordered.forEach(function (item) {
        const state = chapterState(item, progress);
        const row = el('li', 'jellio-manga-chapter' + (state.read ? ' jellio-manga-chapter-read' : ''));
        if (item === resume.chapter) row.classList.add('jellio-manga-chapter-next');
        const button = el('button', 'jellio-manga-chapter-button');
        button.type = 'button';
        button.appendChild(el('span', 'jellio-manga-chapter-name', item.Name));
        let status = '';
        if (state.read) status = 'Read';
        else if (state.started) {
          const pages = state.record.TotalPages;
          const page = /^page:(\d+)$/.exec(state.record.Locator || '');
          status = page && pages ? 'Page ' + page[1] + ' of ' + pages : Math.round(state.record.Progress * 100) + '%';
        } else if (item === resume.chapter) status = 'Up next';
        if (status) button.appendChild(el('span', 'jellio-manga-chapter-status', status));
        if (state.read) button.appendChild(el('span', 'material-icons check'));
        button.addEventListener('click', function () {
          openChapter(item);
        });
        row.appendChild(button);
        const marked = isBookmarked(shelf, item.Id);
        const bookmark = el('button', 'jellio-manga-chapter-bookmark' + (marked ? ' jellio-manga-chapter-bookmarked' : ''));
        bookmark.type = 'button';
        bookmark.setAttribute('aria-label', marked ? 'Remove bookmark' : 'Bookmark chapter');
        bookmark.title = marked ? 'Remove bookmark' : 'Bookmark chapter';
        bookmark.appendChild(el('span', 'material-icons ' + (marked ? 'bookmark' : 'bookmark_border')));
        bookmark.addEventListener('click', function () {
          const key = String(item.Id).replace(/-/g, '').toLowerCase();
          if (marked) shelf.Bookmarks = shelf.Bookmarks.filter((id) => id !== key);
          else shelf.Bookmarks = shelf.Bookmarks.concat([key]);
          renderList();
          setBookmark(item.Id, !marked).catch(function (err) {
            console.warn('Jellio: could not save the bookmark', err);
          });
        });
        row.appendChild(bookmark);
        const download = buildDownloadButton(item, { bookKind: 'manga', compact: true, className: 'jellio-manga-chapter-download' });
        if (download) row.appendChild(download);
        list.appendChild(row);
      });
    }
    order.addEventListener('click', function () {
      descending = !descending;
      renderList();
      saveSeriesPrefs(shelfKey, { ChapterDescending: descending }).catch(function (err) {
        console.warn('Jellio: could not save the chapter order', err);
      });
    });
    renderList();

    stopShelf = onShelfChange(function () {
      loadShelf('manga').then(function (next) {
        if (cancelled) return;
        shelf = Object.assign({}, next, { Bookmarks: shelf.Bookmarks });
        paintCategories();
      });
    });

    const upNext = list.querySelector('.jellio-manga-chapter-next');
    if (upNext && resume.index > 3) upNext.scrollIntoView({ block: 'center' });
  }

  let stopShelf = null;

  return function () {
    cancelled = true;
    if (stopShelf) stopShelf();
  };
}
