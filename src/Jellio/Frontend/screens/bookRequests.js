// The Books and Audiobooks Requests page (&requests=1 on the shelf): every
// book asked of Chaptarr and where it stands, from searching through
// downloading to waiting for Jellyfin's scan, refreshed while it's open.
// Each one can be searched for again or removed
// (Controllers/BookLibraryController.cs).
import { getBookRequests, searchBookAgain, removeBookFromLibrary } from '../runtime/api.js';
import { getAccessToken, getServerAddress } from '../runtime/auth.js';
import { formatRelativeTime } from '../runtime/format.js';
import { showToast } from '../components/toast.js';
import { navigateTo, setTitle } from '../runtime/router.js';
import { el } from '../runtime/dom.js';

const REFRESH_MS = 15000;

const STATES = {
  searching: { label: 'Searching', icon: 'search', detail: 'Chaptarr is looking for a release.' },
  queued: { label: 'Queued', icon: 'schedule', detail: 'Waiting for the download client.' },
  downloading: { label: 'Downloading', icon: 'cloud_download' },
  importing: { label: 'Importing', icon: 'move_to_inbox', detail: 'Downloaded, Chaptarr is moving it into the library.' },
  blocked: { label: 'Needs attention', icon: 'error_outline' },
  failed: { label: 'Failed', icon: 'error_outline' },
  scanning: { label: 'Waiting for Jellyfin', icon: 'sync', detail: 'On the server, it shows up once Jellyfin scans the library.' },
  available: { label: 'In library', icon: 'check_circle' },
  missing: { label: 'Not tracked', icon: 'help_outline' },
};

function coverSrc(url) {
  if (!url) return '';
  if (url.indexOf('/Jellio/') !== 0) return url;
  return getServerAddress() + url + '&ApiKey=' + encodeURIComponent(getAccessToken() || '');
}

export function renderBookRequests(root, params, kind) {
  const isAudiobook = kind === 'audiobook';
  let cancelled = false;
  let timer = null;
  setTitle('Requests - Jellio');
  root.classList.add('jellio-screen-bookshelf', 'jellio-screen-book-requests');

  const header = el('header', 'jellio-library-header jellio-manga-series-header');
  const back = el('button', 'jellio-discover-back');
  back.type = 'button';
  back.setAttribute('aria-label', 'Back to ' + (isAudiobook ? 'Audiobooks' : 'Books'));
  back.appendChild(el('span', 'material-icons arrow_back'));
  back.addEventListener('click', function () {
    const shelf = new URLSearchParams(params);
    shelf.delete('requests');
    navigateTo('#/books?' + shelf.toString());
  });
  header.appendChild(back);
  header.appendChild(el('h1', 'jellio-library-title', 'Requests'));
  const refresh = el('button', 'jellio-book-request-toggle jellio-manga-updates-refresh');
  refresh.type = 'button';
  refresh.appendChild(el('span', 'material-icons refresh'));
  refresh.appendChild(el('span', null, 'Refresh'));
  header.appendChild(refresh);
  root.appendChild(header);

  const status = el('p', 'jellio-bookshelf-stats', 'Loading…');
  const list = el('div', 'jellio-book-requests-list');
  root.appendChild(status);
  root.appendChild(list);

  function actionButton(icon, label, onClick, danger) {
    const button = el('button', 'jellio-book-requests-action' + (danger ? ' jellio-book-requests-action-danger' : ''));
    button.type = 'button';
    button.appendChild(el('span', 'material-icons ' + icon));
    button.appendChild(el('span', null, label));
    button.addEventListener('click', function () {
      onClick(button);
    });
    return button;
  }

  function remove(entry, button) {
    const question =
      entry.State === 'available'
        ? 'Remove “' + entry.Title + '” from your library? If nobody else has it, it is deleted from the server.'
        : 'Cancel the request for “' + entry.Title + '”? If nobody else asked for it, Chaptarr stops looking and anything downloaded is deleted.';
    if (!window.confirm(question)) return;
    button.disabled = true;
    removeBookFromLibrary(kind, entry.ItemId ? { ItemId: entry.ItemId } : { ChaptarrBookId: entry.ChaptarrBookId, Title: entry.Title })
      .then(function (result) {
        showToast(
          result && result.Mode === 'personal'
            ? 'Removed from your library. Others still have it, so it stays on the server.'
            : 'Removed “' + entry.Title + '”.',
        );
        load();
      })
      .catch(function (err) {
        console.warn('Jellio: could not remove the book', err);
        showToast('Couldn’t remove it. Try again.');
        button.disabled = false;
      });
  }

  function paint(data) {
    list.textContent = '';
    if (data && data.Configured === false) {
      status.textContent = 'Chaptarr isn’t set up, so there’s nothing to show yet.';
      return;
    }
    const items = (data && data.Items) || [];
    const active = items.filter((entry) => entry.State !== 'available').length;
    status.textContent = items.length
      ? active + (active === 1 ? ' request in progress' : ' requests in progress') + ' · updates every few seconds'
      : 'No requests yet. Search the shelf to add ' + (isAudiobook ? 'audiobooks' : 'books') + '.';

    items.forEach(function (entry) {
      const state = STATES[entry.State] || STATES.searching;
      const row = el('div', 'jellio-book-requests-item jellio-book-requests-' + entry.State);

      const cover = el('div', 'jellio-book-requests-cover');
      if (entry.CoverUrl) {
        const img = document.createElement('img');
        img.alt = '';
        img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        img.src = coverSrc(entry.CoverUrl);
        img.addEventListener('error', () => img.replaceWith(el('span', 'material-icons ' + (isAudiobook ? 'headphones' : 'menu_book'))));
        cover.appendChild(img);
      } else {
        cover.appendChild(el('span', 'material-icons ' + (isAudiobook ? 'headphones' : 'menu_book')));
      }
      row.appendChild(cover);

      const info = el('div', 'jellio-book-requests-info');
      info.appendChild(el('div', 'jellio-book-requests-title', entry.Title));
      if (entry.Author) info.appendChild(el('div', 'jellio-book-requests-byline', entry.Author));

      const badge = el('div', 'jellio-book-requests-state');
      badge.appendChild(el('span', 'material-icons ' + state.icon));
      let label = state.label;
      if (entry.State === 'downloading' && typeof entry.Progress === 'number') label += ' · ' + Math.round(entry.Progress * 100) + '%';
      if (entry.TimeLeft && entry.State === 'downloading') label += ' · ' + entry.TimeLeft.replace(/\.\d+$/, '') + ' left';
      badge.appendChild(el('span', null, label));
      info.appendChild(badge);

      if (entry.State === 'downloading' && typeof entry.Progress === 'number') {
        const bar = el('div', 'jellio-book-requests-progress');
        const fill = el('div', 'jellio-book-requests-progress-fill');
        fill.style.width = Math.round(entry.Progress * 100) + '%';
        bar.appendChild(fill);
        info.appendChild(bar);
      }

      const detail = entry.Message || state.detail;
      if (detail) info.appendChild(el('div', 'jellio-book-requests-detail', detail));

      const who = [];
      if (entry.RequestedBy && entry.RequestedBy.length) who.push('Requested by ' + entry.RequestedBy.join(', '));
      else who.push('Added in Chaptarr');
      if (entry.RequestedAt) who.push(formatRelativeTime(new Date(entry.RequestedAt).toISOString()));
      info.appendChild(el('div', 'jellio-book-requests-byline', who.join(' · ')));

      const actions = el('div', 'jellio-book-requests-actions');
      if (entry.State === 'available' && entry.ItemId) {
        actions.appendChild(
          actionButton(isAudiobook ? 'headphones' : 'menu_book', isAudiobook ? 'Listen' : 'Read', function () {
            navigateTo('#/' + (isAudiobook ? 'listen' : 'read') + '?id=' + entry.ItemId);
          }),
        );
      }
      if (entry.ChaptarrBookId > 0 && ['searching', 'failed', 'blocked', 'missing'].indexOf(entry.State) !== -1) {
        actions.appendChild(
          actionButton('refresh', 'Search again', function (button) {
            button.disabled = true;
            searchBookAgain(entry.ChaptarrBookId)
              .then(() => showToast('Chaptarr is searching for “' + entry.Title + '” again.'))
              .catch(() => showToast('Chaptarr couldn’t start a search.'))
              .then(function () {
                button.disabled = false;
              });
          }),
        );
      }
      actions.appendChild(
        actionButton('delete', entry.State === 'available' ? 'Remove' : 'Cancel', function (button) {
          remove(entry, button);
        }, true),
      );
      info.appendChild(actions);
      row.appendChild(info);
      list.appendChild(row);
    });
  }

  function schedule() {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(load, REFRESH_MS);
  }

  function load() {
    if (cancelled) return;
    refresh.disabled = true;
    getBookRequests(kind)
      .then(function (data) {
        if (!cancelled) paint(data);
      })
      .catch(function (err) {
        console.warn('Jellio: could not load requests', err);
        if (!cancelled) status.textContent = 'Chaptarr isn’t answering right now.';
      })
      .then(function () {
        refresh.disabled = false;
        if (!cancelled) schedule();
      });
  }
  refresh.addEventListener('click', load);
  load();

  return function () {
    cancelled = true;
    if (timer) window.clearTimeout(timer);
  };
}
