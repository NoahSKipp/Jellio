// Mihon's Updates, reached from the Manga shelf (&updates=1): the
// chapters that turned up in the latest library refreshes, newest first,
// grouped by day. The server checks the sources on its own every few
// hours; opening this page asks again if the last check is an hour old.
import { getMangaUpdates, refreshMangaUpdates, getStreamCoverUrl, markReadingItems } from '../runtime/api.js';
import { formatRelativeTime } from '../runtime/format.js';
import { showToast } from '../components/toast.js';
import { navigateTo, setTitle } from '../runtime/router.js';
import { el } from '../runtime/dom.js';

const STALE_MS = 60 * 60 * 1000;

function dayLabel(ms) {
  const day = new Date(ms);
  const today = new Date();
  const start = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diff = Math.round((start(today) - start(day)) / 86400000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return day.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

export function renderMangaUpdates(root, params) {
  let cancelled = false;
  setTitle('Updates - Jellio');
  root.classList.add('jellio-screen-bookshelf', 'jellio-screen-manga-updates');

  const header = el('header', 'jellio-library-header jellio-manga-series-header');
  const back = el('button', 'jellio-discover-back');
  back.type = 'button';
  back.setAttribute('aria-label', 'Back to Manga');
  back.appendChild(el('span', 'material-icons arrow_back'));
  back.addEventListener('click', function () {
    const shelf = new URLSearchParams(params);
    shelf.delete('updates');
    navigateTo('#/books?' + shelf.toString());
  });
  header.appendChild(back);
  header.appendChild(el('h1', 'jellio-library-title', 'Updates'));
  const refresh = el('button', 'jellio-book-request-toggle jellio-manga-updates-refresh');
  refresh.type = 'button';
  refresh.appendChild(el('span', 'material-icons refresh'));
  refresh.appendChild(el('span', null, 'Check now'));
  header.appendChild(refresh);
  root.appendChild(header);

  const status = el('p', 'jellio-bookshelf-stats', 'Loading…');
  const list = el('div', 'jellio-manga-updates-list');
  root.appendChild(status);
  root.appendChild(list);

  function open(entry) {
    navigateTo('#/read?id=' + entry.Chapter.Id + '&manga=' + entry.MangaId);
  }

  function paint(data) {
    list.textContent = '';
    const items = (data && data.Items) || [];
    status.textContent = data && data.LastRefreshAt ? 'Last checked ' + formatRelativeTime(new Date(data.LastRefreshAt).toISOString()) + '.' : 'Not checked yet.';
    if (!items.length) {
      list.appendChild(
        el('p', 'jellio-bookshelf-stats', 'No new chapters yet. The server checks your library’s sources regularly, and new ones will show up here.'),
      );
      return;
    }
    let lastDay = '';
    items.forEach(function (entry) {
      const day = dayLabel(entry.SeenAt);
      if (day !== lastDay) {
        lastDay = day;
        list.appendChild(el('h2', 'jellio-manga-updates-day', day));
      }
      const row = el('div', 'jellio-manga-update' + (entry.Read ? ' jellio-manga-update-read' : ''));
      const main = el('button', 'jellio-manga-update-main');
      main.type = 'button';
      const cover = el('img', 'jellio-manga-update-cover');
      cover.alt = '';
      cover.loading = 'lazy';
      cover.src = getStreamCoverUrl(entry.MangaId);
      cover.addEventListener('error', () => cover.classList.add('jellio-manga-update-cover-missing'));
      main.appendChild(cover);
      const text = el('span', 'jellio-manga-update-text');
      text.appendChild(el('span', 'jellio-manga-update-series', entry.SeriesTitle));
      text.appendChild(el('span', 'jellio-manga-update-chapter', entry.Chapter.Name));
      text.appendChild(
        el('span', 'jellio-manga-update-meta', [entry.Chapter.Scanlator, formatRelativeTime(new Date(entry.SeenAt).toISOString())].filter(Boolean).join(' · ')),
      );
      main.appendChild(text);
      main.addEventListener('click', () => open(entry));
      row.appendChild(main);
      const mark = el('button', 'jellio-manga-update-mark');
      mark.type = 'button';
      mark.setAttribute('aria-label', entry.Read ? 'Mark as unread' : 'Mark as read');
      mark.appendChild(el('span', 'material-icons ' + (entry.Read ? 'check_circle' : 'radio_button_unchecked')));
      mark.addEventListener('click', function () {
        const read = !entry.Read;
        markReadingItems([entry.Chapter.Id], read)
          .then(function () {
            entry.Read = read;
            paint(data);
          })
          .catch(() => showToast('Couldn’t update that chapter'));
      });
      row.appendChild(mark);
      list.appendChild(row);
    });
  }

  function check() {
    refresh.disabled = true;
    status.textContent = 'Checking your sources…';
    return refreshMangaUpdates()
      .then(function (data) {
        if (!cancelled) paint(data);
      })
      .catch(function () {
        if (!cancelled) status.textContent = 'Couldn’t check the sources right now.';
      })
      .then(function () {
        refresh.disabled = false;
      });
  }
  refresh.addEventListener('click', check);

  getMangaUpdates()
    .then(function (data) {
      if (cancelled) return;
      paint(data);
      if (!data.LastRefreshAt || Date.now() - data.LastRefreshAt > STALE_MS) check();
    })
    .catch(function () {
      if (!cancelled) status.textContent = 'Suwayomi isn’t answering right now.';
    });

  return function () {
    cancelled = true;
  };
}
