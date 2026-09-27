// One manga series from the Manga shelf (screens/bookshelf.js, reached
// with &series=<key>): its cover, how far the reader is, a button that
// picks up where they left off, and every chapter in reading order with
// its read state.
import { getBookshelfItems, getAllReadingProgress, getImageUrl } from '../runtime/api.js';
import { groupMangaSeries, chapterState, resumePoint, useSeriesCover } from '../components/mangaSeries.js';
import { buildDownloadButton, downloadBook } from '../components/downloads.js';
import { findAnyDownload } from '../runtime/offline.js';
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

  Promise.all([getBookshelfItems(parentId, 'manga', params.get('mangaLibrary') === '1'), getAllReadingProgress().catch(() => ({}))])
    .then(function (results) {
      if (cancelled) return;
      const group = groupMangaSeries(results[0]).series.find((series) => series.key === key);
      const progress = results[1];
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

    const order = el('button', 'jellio-manga-series-order');
    order.type = 'button';
    actions.appendChild(order);
    info.appendChild(actions);
    hero.appendChild(info);
    body.appendChild(hero);

    const list = el('ol', 'jellio-manga-chapter-list');
    body.appendChild(list);

    function renderList() {
      order.textContent = '';
      order.appendChild(el('span', 'material-icons ' + (descending ? 'arrow_downward' : 'arrow_upward')));
      order.appendChild(el('span', null, descending ? 'Newest first' : 'Oldest first'));
      list.textContent = '';
      const ordered = descending ? chapters.slice().reverse() : chapters;
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
        const download = buildDownloadButton(item, { bookKind: 'manga', compact: true, className: 'jellio-manga-chapter-download' });
        if (download) row.appendChild(download);
        list.appendChild(row);
      });
    }
    order.addEventListener('click', function () {
      descending = !descending;
      renderList();
    });
    renderList();

    const upNext = list.querySelector('.jellio-manga-chapter-next');
    if (upNext && resume.index > 3) upNext.scrollIntoView({ block: 'center' });
  }

  return function () {
    cancelled = true;
  };
}
