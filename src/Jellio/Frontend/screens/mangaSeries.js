// One manga series from the Manga shelf (screens/bookshelf.js, reached
// with &series=<key>): its cover, how far the reader is, a button that
// picks up where they left off, and every chapter in reading order with
// its read state. Chapters stream from the source (MangaStreamController)
// unless they've been saved to the server.
import {
  getBookshelfItems,
  getAllReadingProgress,
  getImageUrl,
  getStreamLibrary,
  getStreamSeries,
  findStreamSeries,
  saveStreamSeries,
  markReadingItems,
  setPlayed,
} from '../runtime/api.js';
import { openCardOptionsMenu } from '../components/cardOptionsMenu.js';
import {
  groupMangaSeries,
  chapterState,
  resumePoint,
  useSeriesCover,
  mergeStreamChapters,
  mangaSeriesTitle,
  mangaSeriesKey,
  chapterNumberOf,
  listScanlators,
  applyScanlatorFilter,
  withDuplicateReads,
  chapterSettings,
  passesChapterFilters,
  sortChapters,
  chapterLabelFor,
} from '../components/mangaSeries.js';
import { openScanlatorFilter } from '../components/scanlatorFilter.js';
import { openChapterSettings } from '../components/chapterSettings.js';
import { buildDownloadButton, downloadBook } from '../components/downloads.js';
import { findAnyDownload, removeDownload } from '../runtime/offline.js';
import { loadShelf, onShelfChange, setInLibrary, isInLibrary, saveSeriesPrefs, saveSeriesDefaults, seriesShelfKey, isBookmarked, setBookmark, categoriesOf } from '../runtime/shelf.js';
import { openCategoryPicker } from '../components/shelfCategories.js';
import { showToast } from '../components/toast.js';
import { navigateTo, setTitle } from '../runtime/router.js';
import { el } from '../runtime/dom.js';

function openChapter(item) {
  navigateTo('#/read?id=' + item.Id + (item.Stream && item.Stream.MangaId ? '&manga=' + item.Stream.MangaId : ''));
}

export function renderMangaSeries(root, params, parentId) {
  const key = params.get('series') || '';
  let cancelled = false;
  // Set across a repaint (marking chapters read) so the page keeps its place.
  let keptView = null;
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
    getStreamLibrary(),
  ])
    .then(async function (results) {
      if (cancelled) return;
      const library = groupMangaSeries(results[0]);
      const saved = library.series.find((series) => series.key === key) || null;
      const loose = saved ? [] : library.singles.filter((item) => mangaSeriesKey(mangaSeriesTitle(item)) === key);
      const progress = results[1];
      shelf = results[2];
      const summary =
        (results[3] || []).find((series) => series.Key === key) || (await findStreamSeries(key).catch(() => null));
      const streamed = summary ? await getStreamSeries(summary.MangaId).catch(() => null) : null;
      if (cancelled) return;
      body.textContent = '';
      const savedChapters = saved ? saved.chapters : loose;
      if (!savedChapters.length && !(streamed && streamed.Chapters.length)) {
        body.appendChild(
          el(
            'p',
            'jellio-service-empty',
            summary ? 'Couldn’t load this series’ chapters from its source. Try again in a moment.' : 'This series isn’t on the shelf any more.',
          ),
        );
        return;
      }
      const group = {
        key: key,
        title: saved ? saved.title : streamed ? streamed.Title : mangaSeriesTitle(loose[0]),
        chapters: mergeStreamChapters(savedChapters, streamed),
        stream: summary,
      };
      setTitle(group.title + ' - Jellio');
      render(group, progress);
    })
    .catch(function (err) {
      if (cancelled) return;
      console.warn('Jellio: could not load the series', err);
      body.textContent = '';
      body.appendChild(el('p', 'jellio-service-empty', 'Could not load this series. Try again in a moment.'));
    });

  function bookmarked(item) {
    return isBookmarked(shelf, item.Id) || (!!item.StreamId && isBookmarked(shelf, item.StreamId));
  }

  function render(group, rawProgress) {
    // This reader's saved scanlator filter for the series: chapters from
    // hidden groups are left out everywhere below, and (unless turned
    // off) a chapter number read from one group counts as read for all.
    const prefs = Object.assign({}, shelf.Series[shelfKey]);
    const allChapters = group.chapters;
    const chapters = applyScanlatorFilter(allChapters, prefs.ExcludedScanlators);
    const duplicatesAsOne = prefs.DuplicatesAsOne !== false;
    const progress = duplicatesAsOne ? withDuplicateReads(chapters, rawProgress) : rawProgress;
    const scanlators = listScanlators(allChapters);

    // Marks chapters read or unread, here at once and then on the server.
    function setRead(list, read) {
      // Unreading one copy has to unread the same number from the other
      // groups too, or it would still read as read through them.
      let targets = list;
      if (duplicatesAsOne && !read) {
        const numbers = new Set(list.map(chapterNumberOf).filter((number) => number >= 0));
        if (numbers.size) targets = chapters.filter((chapter) => list.indexOf(chapter) !== -1 || numbers.has(chapterNumberOf(chapter)));
      }
      const ids = [];
      targets.forEach(function (chapter) {
        ids.push(chapter.Id);
        if (chapter.StreamId) ids.push(chapter.StreamId);
      });
      const now = new Date().toISOString();
      ids.forEach(function (id) {
        const key = String(id).replace(/-/g, '');
        if (read) rawProgress[key] = { Locator: 'page:1', Progress: 1, TotalPages: null, UpdatedAt: now };
        else delete rawProgress[key];
      });
      if (stopShelf) stopShelf();
      keptView = { kept: true };
      const scrollY = window.scrollY;
      body.textContent = '';
      render(group, rawProgress);
      window.scrollTo(0, scrollY);
      markReadingItems(ids, read)
        .then(function () {
          if (read) return null;
          // A chapter marked watched before would still count as read.
          return Promise.all(
            targets.filter((chapter) => chapter.UserData && chapter.UserData.Played).map((chapter) => setPlayed(chapter.Id, false).catch(() => null)),
          );
        })
        .catch(function (err) {
          console.warn('Jellio: could not update read state', err);
          showToast('Could not save the read state. Try again.');
        });
    }

    // Right-click or long-press on a chapter, Mihon style.
    function openChapterMenu(item, anchor) {
      const read = chapterState(item, progress).read;
      const index = chapters.indexOf(item);
      const before = chapters.slice(0, index).filter((chapter) => !chapterState(chapter, progress).read);
      const options = [
        {
          label: read ? 'Mark as unread' : 'Mark as read',
          icon: read ? 'remove_done' : 'done',
          onClick: () => setRead([item], !read),
        },
      ];
      if (before.length) {
        options.push({ label: 'Mark previous as read', icon: 'done_all', onClick: () => setRead(before, true) });
      }
      openCardOptionsMenu(item, anchor.getBoundingClientRect(), null, { onlyExtra: true, extraOptions: options });
    }
    const resume = resumePoint(chapters, progress);
    const repaint = keptView;
    keptView = null;
    const cs = chapterSettings(prefs, shelf.SeriesDefaults);

    function rerender() {
      if (stopShelf) stopShelf();
      keptView = { kept: true };
      const scrollY = window.scrollY;
      body.textContent = '';
      render(group, rawProgress);
      window.scrollTo(0, scrollY);
    }

    // The settings as the server stores them ("" clears one).
    function settingsForServer(settings) {
      return {
        ChapterDescending: settings.descending,
        ChapterSort: settings.sort,
        ChapterDisplay: settings.display,
        FilterUnread: settings.unread || '',
        FilterBookmarked: settings.bookmarked || '',
        FilterDownloaded: settings.downloaded || '',
      };
    }

    // A change to the chapter settings: shown at once, then remembered.
    function applySettings(patch) {
      // From what is saved now, not this render's copy: the dialog stays
      // open across the repaints its own changes cause.
      const next = Object.assign({}, chapterSettings(shelf.Series[shelfKey], shelf.SeriesDefaults), patch);
      const server = settingsForServer(next);
      server.ChapterFilter = 'all';
      const local = Object.assign({}, shelf.Series[shelfKey]);
      Object.keys(server).forEach((key) => (local[key] = server[key] === '' ? null : server[key]));
      shelf.Series[shelfKey] = local;
      rerender();
      saveSeriesPrefs(shelfKey, server).catch(function (err) {
        console.warn('Jellio: could not save the chapter settings', err);
        showToast('Could not save the chapter settings. Try again.');
      });
    }

    function openScanlators() {
      openScanlatorFilter({
        available: scanlators,
        excluded: prefs.ExcludedScanlators || [],
        duplicatesAsOne: duplicatesAsOne,
        onSave: function (choice) {
          shelf.Series[shelfKey] = Object.assign({}, shelf.Series[shelfKey], {
            ExcludedScanlators: choice.excluded,
            DuplicatesAsOne: choice.duplicatesAsOne,
          });
          rerender();
          saveSeriesPrefs(shelfKey, { ExcludedScanlators: choice.excluded, DuplicatesAsOne: choice.duplicatesAsOne }).catch(function (err) {
            console.warn('Jellio: could not save the scanlator filter', err);
            showToast('Could not save the scanlator filter. Try again.');
          });
        },
      });
    }

    const hero = el('section', 'jellio-manga-series-hero');
    const cover = el('div', 'jellio-manga-series-cover');
    const coverItem = chapters.find((item) => item.ImageTags && item.ImageTags.Primary) || chapters[0];
    const img = document.createElement('img');
    img.alt = '';
    if (coverItem.ImageTags && coverItem.ImageTags.Primary) {
      img.setAttribute('src', getImageUrl(coverItem.Id, 'Primary', { tag: coverItem.ImageTags.Primary, maxWidth: 400 }));
    }
    cover.appendChild(img);
    useSeriesCover(
      img,
      chapters[0],
      function () {
        img.replaceWith(el('span', 'material-icons collections_bookmark'));
      },
      group.stream && group.stream.MangaId,
    );
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

    const markAll = el('button', 'jellio-manga-series-order');
    markAll.type = 'button';
    markAll.appendChild(el('span', 'material-icons ' + (unread.length ? 'done_all' : 'remove_done')));
    markAll.appendChild(el('span', null, unread.length ? 'Mark all as read' : 'Mark all as unread'));
    markAll.addEventListener('click', function () {
      if (unread.length) setRead(unread, true);
      else if (window.confirm('Mark every chapter of “' + group.title + '” as unread?')) setRead(chapters, false);
    });
    actions.appendChild(markAll);
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

    // Streamed chapters into the library, to keep on the server.
    const unsaved = chapters.filter((chapter) => chapter.Stream);
    if (group.stream && unsaved.length) {
      const keep = el('button', 'jellio-manga-series-order');
      keep.type = 'button';
      keep.appendChild(el('span', 'material-icons cloud_download'));
      keep.appendChild(el('span', null, 'Save to server (' + unsaved.length + ')'));
      keep.title = 'Download these chapters into the library, so they don’t depend on the source';
      keep.addEventListener('click', async function () {
        if (!window.confirm('Download ' + unsaved.length + ' chapters of “' + group.title + '” to the server?')) return;
        keep.disabled = true;
        try {
          const result = await saveStreamSeries(
            group.stream.MangaId,
            unsaved.map((chapter) => chapter.Stream.ChapterId),
          );
          showToast('Saving ' + ((result && result.Queued) || 0) + ' chapters to the server. They move to the library as they finish.');
        } catch (err) {
          console.warn('Jellio: could not save the series', err);
          showToast('Could not save this series to the server. Try again in a moment.');
          keep.disabled = false;
        }
      });
      actions.appendChild(keep);
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

    // Mihon's "In library": on this reader's Manga shelf or not.
    const libraryButton = el('button', 'jellio-manga-series-order');
    libraryButton.type = 'button';
    const libraryIcon = el('span', 'material-icons');
    const libraryLabel = el('span');
    libraryButton.appendChild(libraryIcon);
    libraryButton.appendChild(libraryLabel);
    function paintLibrary() {
      const on = isInLibrary(shelf, shelfKey);
      libraryIcon.className = 'material-icons ' + (on ? 'favorite' : 'favorite_border');
      libraryLabel.textContent = on ? 'In library' : 'Add to library';
      libraryButton.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    paintLibrary();
    libraryButton.addEventListener('click', function () {
      const on = !isInLibrary(shelf, shelfKey);
      shelf.Library = (shelf.Library || []).filter((key) => key !== shelfKey).concat(on ? [shelfKey] : []);
      paintLibrary();
      setInLibrary(shelfKey, on).catch(function (err) {
        console.warn('Jellio: could not update the library', err);
      });
    });
    actions.appendChild(libraryButton);

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
      { label: 'Paged (right to left)', layout: 'single', direction: 'rtl' },
      { label: 'Paged (left to right)', layout: 'single', direction: 'ltr' },
      { label: 'Paged (vertical)', layout: 'paged-vertical', direction: '' },
      { label: 'Long strip', layout: 'vertical', direction: '' },
      { label: 'Long strip with gaps', layout: 'vertical-gaps', direction: '' },
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
      const only = (key) => ({ unread: null, bookmarked: null, downloaded: null, [key]: 'include' });
      const active =
        option.value === 'all'
          ? !cs.unread && !cs.bookmarked && !cs.downloaded
          : option.value === 'unread'
            ? cs.unread === 'include' && !cs.bookmarked && !cs.downloaded
            : cs.bookmarked === 'include' && !cs.unread && !cs.downloaded;
      chip.classList.toggle('jellio-manga-series-chip-active', active);
      chip.setAttribute('aria-pressed', active ? 'true' : 'false');
      chip.addEventListener('click', function () {
        applySettings(option.value === 'all' ? only('none') : only(option.value));
      });
      filters.appendChild(chip);
    });
    // Mihon's scanlator filter, remembered per series.
    if (scanlators.length > 1) {
      const shownGroups = scanlators.filter((entry) => chapters.some((chapter) => chapter.Scanlator === entry.name)).length;
      const filtered = shownGroups < scanlators.length;
      const groups = el('button', 'jellio-manga-series-chip' + (filtered ? ' jellio-manga-series-chip-active' : ''));
      groups.type = 'button';
      groups.textContent = filtered ? 'Scanlators · ' + shownGroups + ' of ' + scanlators.length : 'Scanlators';
      groups.addEventListener('click', openScanlators);
      filters.appendChild(groups);
    }
    const sheet = el('button', 'jellio-manga-series-chip');
    sheet.type = 'button';
    sheet.appendChild(el('span', 'material-icons tune'));
    sheet.appendChild(el('span', null, 'Filter & sort'));
    sheet.addEventListener('click', function () {
      openChapterSettings({
        settings: cs,
        scanlators: scanlators,
        shownGroups: scanlators.filter((entry) => chapters.some((chapter) => chapter.Scanlator === entry.name)).length,
        onChange: applySettings,
        onScanlators: openScanlators,
        onSetDefault: function (applyToLibrary) {
          saveSeriesDefaults(settingsForServer(chapterSettings(shelf.Series[shelfKey], shelf.SeriesDefaults)), applyToLibrary)
            .then(() => showToast(applyToLibrary ? 'Saved as the default, and applied to your shelf.' : 'Saved as the default for new series.'))
            .catch(function (err) {
              console.warn('Jellio: could not save the default chapter settings', err);
              showToast('Could not save the default. Try again.');
            });
        },
        onReset: function () {
          shelf.Series[shelfKey] = Object.assign({}, shelf.Series[shelfKey], {
            ChapterDescending: null,
            ChapterFilter: null,
            FilterDownloaded: null,
            FilterUnread: null,
            FilterBookmarked: null,
            ChapterSort: null,
            ChapterDisplay: null,
          });
          rerender();
          saveSeriesPrefs(shelfKey, { Reset: true }).catch(function (err) {
            console.warn('Jellio: could not reset the chapter settings', err);
            showToast('Could not reset. Try again.');
          });
        },
      });
    });
    filters.appendChild(sheet);
    listTools.appendChild(filters);
    const order = el('button', 'jellio-manga-series-order');
    order.type = 'button';
    listTools.appendChild(order);
    body.appendChild(listTools);

    const list = el('ol', 'jellio-manga-chapter-list');
    body.appendChild(list);

    function renderList() {
      order.textContent = '';
      order.appendChild(el('span', 'material-icons ' + (cs.descending ? 'arrow_downward' : 'arrow_upward')));
      order.appendChild(el('span', null, cs.descending ? 'Newest first' : 'Oldest first'));
      list.textContent = '';
      const ordered = sortChapters(chapters, cs).filter((item) =>
        passesChapterFilters(item, cs, chapterState(item, progress).read, bookmarked(item)),
      );
      if (!ordered.length) {
        const filtering = cs.unread || cs.bookmarked || cs.downloaded;
        list.appendChild(
          el(
            'li',
            'jellio-manga-chapter-empty',
            !filtering ? 'No chapters.' : cs.bookmarked === 'include' && !cs.unread && !cs.downloaded ? 'No bookmarked chapters.' : cs.unread === 'include' && !cs.bookmarked && !cs.downloaded ? 'Nothing left to read.' : 'No chapters match these filters.',
          ),
        );
      }
      ordered.forEach(function (item) {
        const state = chapterState(item, progress);
        const row = el('li', 'jellio-manga-chapter' + (state.read ? ' jellio-manga-chapter-read' : ''));
        if (item === resume.chapter) row.classList.add('jellio-manga-chapter-next');
        const button = el('button', 'jellio-manga-chapter-button');
        button.type = 'button';
        const label = el('span', 'jellio-manga-chapter-label');
        label.appendChild(el('span', 'jellio-manga-chapter-name', chapterLabelFor(item, cs)));
        const uploaded = item.DateCreated ? new Date(item.DateCreated) : null;
        const sub = [
          uploaded && !Number.isNaN(uploaded.getTime()) ? uploaded.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '',
          item.Scanlator && scanlators.length > 1 ? item.Scanlator : '',
        ].filter(Boolean);
        if (sub.length) label.appendChild(el('span', 'jellio-manga-chapter-scanlator', sub.join(' · ')));
        button.appendChild(label);
        let status = '';
        if (state.read) status = 'Read';
        else if (state.started) {
          const pages = state.record.TotalPages;
          const page = /^page:(\d+)$/.exec(state.record.Locator || '');
          status = page && pages ? 'Page ' + page[1] + ' of ' + pages : Math.round(state.record.Progress * 100) + '%';
        } else if (item === resume.chapter) status = 'Up next';
        if (status) button.appendChild(el('span', 'jellio-manga-chapter-status', status));
        if (state.read) button.appendChild(el('span', 'material-icons check'));
        let held = false;
        let holdTimer = null;
        button.addEventListener('click', function () {
          if (held) {
            held = false;
            return;
          }
          openChapter(item);
        });
        button.addEventListener('contextmenu', function (event) {
          event.preventDefault();
          openChapterMenu(item, button);
        });
        button.addEventListener('pointerdown', function (event) {
          if (event.pointerType === 'mouse') return;
          held = false;
          holdTimer = window.setTimeout(function () {
            held = true;
            openChapterMenu(item, button);
          }, 500);
        });
        ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (type) {
          button.addEventListener(type, function () {
            window.clearTimeout(holdTimer);
          });
        });
        row.appendChild(button);
        const readToggle = el('button', 'jellio-manga-chapter-bookmark' + (state.read ? ' jellio-manga-chapter-bookmarked' : ''));
        readToggle.type = 'button';
        readToggle.setAttribute('aria-label', state.read ? 'Mark as unread' : 'Mark as read');
        readToggle.title = state.read ? 'Mark as unread' : 'Mark as read';
        readToggle.appendChild(el('span', 'material-icons ' + (state.read ? 'remove_done' : 'done')));
        readToggle.addEventListener('click', function () {
          setRead([item], !state.read);
        });
        row.appendChild(readToggle);
        const marked = bookmarked(item);
        const bookmark = el('button', 'jellio-manga-chapter-bookmark' + (marked ? ' jellio-manga-chapter-bookmarked' : ''));
        bookmark.type = 'button';
        bookmark.setAttribute('aria-label', marked ? 'Remove bookmark' : 'Bookmark chapter');
        bookmark.title = marked ? 'Remove bookmark' : 'Bookmark chapter';
        bookmark.appendChild(el('span', 'material-icons ' + (marked ? 'bookmark' : 'bookmark_border')));
        bookmark.addEventListener('click', function () {
          const ids = [item.Id].concat(item.StreamId ? [item.StreamId] : []).map((id) => String(id).replace(/-/g, '').toLowerCase());
          if (marked) shelf.Bookmarks = shelf.Bookmarks.filter((id) => ids.indexOf(id) === -1);
          else shelf.Bookmarks = shelf.Bookmarks.concat([ids[0]]);
          renderList();
          const saves = marked ? ids.map((id) => setBookmark(id, false)) : [setBookmark(ids[0], true)];
          Promise.all(saves).catch(function (err) {
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
      applySettings({ descending: !cs.descending });
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
    if (!repaint && upNext && resume.index > 3) upNext.scrollIntoView({ block: 'center' });
  }

  let stopShelf = null;

  return function () {
    cancelled = true;
    if (stopShelf) stopShelf();
  };
}
