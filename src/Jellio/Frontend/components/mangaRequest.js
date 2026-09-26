// The Manga shelf's request sheet, shared by the shelf and Discover. Two
// ways to get a series, whichever the server has set up:
// - Chapters, from Suwayomi (Controllers/MangaRequestController.cs): its
//   sources are searched in parallel, results grouped by source, and a
//   pick adds the series and downloads every chapter. Covers manhwa and
//   manhua, which rarely exist as published volumes.
// - Volumes, from Chaptarr: the book request panel, searching for the
//   series' published volumes.
import {
  getMangaRequestStatus,
  searchMangaSources,
  requestMangaSeries,
} from '../runtime/api.js';
import { getServerAddress, getAccessToken } from '../runtime/auth.js';
import { buildBookRequestPanel } from './bookRequest.js';
import { el } from '../runtime/dom.js';

function thumbnailSrc(path) {
  return getServerAddress() + path + '?ApiKey=' + encodeURIComponent(getAccessToken() || '');
}

function statusLabel(status) {
  return { ONGOING: 'Ongoing', COMPLETED: 'Completed', PUBLISHING_FINISHED: 'Finished', ON_HIATUS: 'On hiatus', CANCELLED: 'Cancelled' }[status] || '';
}

// options: query (series title), altQuery (another title to try when the
// first finds nothing), heading, suwayomi and chaptarr (which backends are
// set up). Returns a function that closes the sheet.
export function openMangaRequestSheet(root, options) {
  const opts = options || {};
  const sheet = el('div', 'jellio-manga-sheet');
  const panel = el('div', 'jellio-manga-sheet-panel');
  sheet.appendChild(panel);

  function close() {
    sheet.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(event) {
    if (event.key === 'Escape') close();
  }
  sheet.addEventListener('click', function (event) {
    if (event.target === sheet) close();
  });
  document.addEventListener('keydown', onKey);

  const head = el('div', 'jellio-manga-sheet-head');
  head.appendChild(el('h2', 'jellio-row-title', opts.heading || 'Request manga'));
  const closeButton = el('button', 'jellio-discover-back');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Close');
  closeButton.appendChild(el('span', 'material-icons close'));
  closeButton.addEventListener('click', close);
  head.appendChild(closeButton);
  panel.appendChild(head);

  const tabs = el('div', 'jellio-manga-tabs');
  const body = el('div', 'jellio-manga-sheet-body');
  panel.appendChild(tabs);
  panel.appendChild(body);

  const panes = [];
  if (opts.suwayomi) panes.push({ key: 'chapters', label: 'Chapters · Suwayomi', build: buildChaptersPane });
  if (opts.chaptarr) panes.push({ key: 'volumes', label: 'Volumes · Chaptarr', build: buildVolumesPane });
  if (!panes.length) {
    body.appendChild(el('p', 'jellio-bookshelf-stats', 'Manga requests aren’t set up on this server.'));
  }

  const built = {};
  function show(key) {
    tabs.querySelectorAll('.jellio-manga-tab').forEach(function (tab) {
      tab.classList.toggle('jellio-manga-tab-active', tab.dataset.key === key);
      tab.setAttribute('aria-selected', tab.dataset.key === key ? 'true' : 'false');
    });
    Object.keys(built).forEach(function (paneKey) {
      built[paneKey].hidden = paneKey !== key;
    });
    if (!built[key]) {
      const pane = panes.find((candidate) => candidate.key === key).build();
      built[key] = pane;
      body.appendChild(pane);
    }
  }
  if (panes.length > 1) {
    panes.forEach(function (pane) {
      const tab = el('button', 'jellio-manga-tab', pane.label);
      tab.type = 'button';
      tab.dataset.key = pane.key;
      tab.setAttribute('role', 'tab');
      tab.addEventListener('click', function () {
        show(pane.key);
      });
      tabs.appendChild(tab);
    });
  } else {
    tabs.hidden = true;
  }

  function buildChaptersPane() {
    const pane = el('div', 'jellio-manga-pane');
    const warnings = el('div', 'jellio-manga-warnings');
    pane.appendChild(warnings);
    getMangaRequestStatus()
      .then(function (status) {
        if (!status || !status.Reachable) {
          warnings.appendChild(el('p', 'jellio-manga-warning', 'Suwayomi isn’t reachable right now.'));
          return;
        }
        if (!status.DownloadAsCbz) {
          warnings.appendChild(
            el('p', 'jellio-manga-warning', 'Suwayomi saves chapters as image folders. Turn on “Download as CBZ” in its settings so Jellyfin can read them.'),
          );
        }
        if (!status.AutoDownloadNewChapters) {
          warnings.appendChild(
            el('p', 'jellio-manga-warning', 'New chapters won’t download on their own. Turn on automatic downloads of new chapters in Suwayomi to follow ongoing series.'),
          );
        }
      })
      .catch(function () {});

    const form = el('form', 'jellio-book-request-form jellio-manga-search');
    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'jellio-book-request-input';
    input.placeholder = 'Series title';
    input.value = opts.query || '';
    const submit = el('button', 'jellio-book-request-submit', 'Search');
    submit.type = 'submit';
    form.appendChild(input);
    form.appendChild(submit);
    pane.appendChild(form);
    const status = el('p', 'jellio-book-request-status');
    pane.appendChild(status);
    const results = el('div', 'jellio-manga-sources');
    pane.appendChild(results);

    let token = 0;
    function search(query, fallback) {
      const mine = ++token;
      results.textContent = '';
      status.textContent = 'Searching your Suwayomi sources…';
      submit.disabled = true;
      searchMangaSources(query)
        .then(function (sources) {
          if (mine !== token) return;
          if (!sources.length && fallback) {
            input.value = fallback;
            search(fallback, null);
            return;
          }
          status.textContent = sources.length
            ? 'Found on ' + sources.length + (sources.length === 1 ? ' source.' : ' sources.') + ' Pick the best match.'
            : 'No source has “' + query + '”. Try another title, or add more Suwayomi extensions.';
          sources.forEach(function (source) {
            results.appendChild(buildSource(source));
          });
        })
        .catch(function () {
          if (mine !== token) return;
          status.textContent = 'Suwayomi search failed. Try again in a moment.';
        })
        .finally(function () {
          if (mine === token) submit.disabled = false;
        });
    }
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      const query = input.value.trim();
      if (query) search(query, null);
    });
    if (opts.query) search(opts.query, opts.altQuery && opts.altQuery !== opts.query ? opts.altQuery : null);
    else window.setTimeout(() => input.focus(), 0);
    return pane;
  }

  function buildSource(source) {
    const group = el('section', 'jellio-manga-source');
    const title = el('div', 'jellio-manga-source-name');
    title.appendChild(el('span', null, source.SourceName));
    if (source.Lang && source.Lang !== 'all') title.appendChild(el('span', 'jellio-manga-source-lang', source.Lang.toUpperCase()));
    group.appendChild(title);
    source.Results.forEach(function (manga) {
      group.appendChild(buildMangaRow(manga));
    });
    return group;
  }

  function buildMangaRow(manga) {
    const row = el('div', 'jellio-book-request-result');
    const cover = el('div', 'jellio-book-request-cover');
    const img = document.createElement('img');
    img.src = thumbnailSrc(manga.ThumbnailUrl);
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', function () {
      img.replaceWith(el('span', 'material-icons collections_bookmark'));
    });
    cover.appendChild(img);
    row.appendChild(cover);
    const info = el('div', 'jellio-book-request-info');
    info.appendChild(el('div', 'jellio-book-request-title', manga.Title));
    const byline = [manga.Author, statusLabel(manga.Status)].filter(Boolean).join(' · ');
    if (byline) info.appendChild(el('div', 'jellio-book-request-byline', byline));
    const actions = el('div', 'jellio-book-request-actions');
    const button = el('button', 'jellio-book-request-action');
    button.type = 'button';
    button.appendChild(el('span', 'material-icons download'));
    const text = el('span', null, manga.InLibrary ? 'In Suwayomi · get missing' : 'Add & download');
    button.appendChild(text);
    button.addEventListener('click', function () {
      button.disabled = true;
      text.textContent = 'Adding…';
      requestMangaSeries(manga.MangaId, manga.Title)
        .then(function (response) {
          if (response && response.Status === 'added') {
            text.textContent = 'Downloading ' + response.QueuedChapters + (response.QueuedChapters === 1 ? ' chapter' : ' chapters');
          } else if (response && response.Status === 'exists') {
            text.textContent = response.Message || 'All ' + response.TotalChapters + ' chapters already downloaded';
          } else {
            text.textContent = (response && response.Message) || 'Request failed';
            button.disabled = false;
            button.classList.add('jellio-book-request-action-error');
            return;
          }
          button.classList.add('jellio-book-request-action-done');
        })
        .catch(function () {
          text.textContent = 'Request failed';
          button.disabled = false;
          button.classList.add('jellio-book-request-action-error');
        });
    });
    actions.appendChild(button);
    info.appendChild(actions);
    row.appendChild(info);
    return row;
  }

  function buildVolumesPane() {
    const pane = el('div', 'jellio-manga-pane');
    pane.appendChild(
      buildBookRequestPanel('ebook', {
        label: 'Search volumes',
        placeholder: 'Series and volume, e.g. Berserk Vol. 1',
        initialQuery: opts.query || '',
        ebookLabel: 'Request',
      }),
    );
    return pane;
  }

  if (panes.length) show(panes[0].key);
  root.appendChild(sheet);
  return close;
}
