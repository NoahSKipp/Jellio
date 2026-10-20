import { t } from '../runtime/i18n.js';
// The Manga shelf's "find a series" sheet, shared by the shelf and
// Discover. Two ways to get a series, whichever the server has set up:
// - Chapters, from Suwayomi (Controllers/MangaRequestController.cs): its
//   sources are searched in parallel, results grouped by source, and Read
//   opens the series, read straight from the source like Mihon's Browse
//   (downloaded too if the admin keeps requests on the server). Covers
//   manhwa and manhua, which rarely exist as published volumes.
// - Volumes, from Chaptarr: the book request panel, a real request for
//   the series' published volumes.
import {
  invalidateStreamLibrary,
  getMangaRequestStatus,
  streamMangaSources,
  bestMangaMatch,
  requestMangaSeries,
  migrateMangaSeries,
} from '../runtime/api.js';
import { getServerAddress, getAccessToken } from '../runtime/auth.js';
import { buildBookRequestPanel } from './bookRequest.js';
import { mangaSeriesKey } from './mangaSeries.js';
import { el } from '../runtime/dom.js';

function thumbnailSrc(path) {
  return getServerAddress() + path + '?ApiKey=' + encodeURIComponent(getAccessToken() || '');
}

// Why a search came back empty, in the words the fix needs.
function emptyReason(query, response) {
  const wanted = response.Languages.filter((lang) => lang !== 'all').join(', ') || 'en';
  if (!response.Searched) {
    if (!response.TotalSources) {
      return 'The Suwayomi at the URL in Jellio’s plugin settings reports no sources. If you installed extensions, check that URL points at that same Suwayomi instance.';
    }
    if (response.NsfwSources >= response.TotalSources) {
      return (
        'All ' + response.TotalSources + ' of Suwayomi’s sources are flagged NSFW (common for general manga sites), so they were skipped. ' +
        'An admin can turn on “Include NSFW Suwayomi sources” in Jellio’s plugin settings.'
      );
    }
    return (
      'None of your Suwayomi sources are in ' + wanted + ' (installed: ' + response.InstalledLanguages.join(', ') +
      '). Change the source languages in Jellio’s plugin settings, or install sources in ' + wanted + '.'
    );
  }
  if (response.Failed >= response.Searched) {
    return 'All ' + response.Searched + ' Suwayomi sources failed or timed out. Check that they work in Suwayomi itself (some need Cloudflare solving).';
  }
  const failed = response.Failed ? ' (' + response.Failed + ' of ' + response.Searched + ' sources failed)' : '';
  return 'No source has “' + query + '”' + failed + '. Try another title, or add more Suwayomi extensions.';
}

function statusLabel(status) {
  return { ONGOING: 'Ongoing', COMPLETED: 'Completed', PUBLISHING_FINISHED: 'Finished', ON_HIATUS: 'On hiatus', CANCELLED: 'Cancelled' }[status] || '';
}

// options: query (series title), altQuery (another title to try when the
// first finds nothing), heading, suwayomi and chaptarr (which backends are
// set up), openSeries(key) (opens a series page; Read calls it). Returns a
// function that closes the sheet.
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
  head.appendChild(el('h2', 'jellio-row-title', opts.heading || 'Find manga'));
  const closeButton = el('button', 'jellio-discover-back');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', t('action_close'));
  closeButton.appendChild(el('span', 'material-icons close'));
  closeButton.addEventListener('click', close);
  head.appendChild(closeButton);
  panel.appendChild(head);

  const tabs = el('div', 'jellio-manga-tabs');
  const body = el('div', 'jellio-manga-sheet-body');
  panel.appendChild(tabs);
  panel.appendChild(body);

  const panes = [];
  if (opts.suwayomi) panes.push({ key: 'chapters', label: 'Read online', build: buildChaptersPane });
  if (opts.chaptarr) panes.push({ key: 'volumes', label: 'Request volumes', build: buildVolumesPane });
  if (!panes.length) {
    body.appendChild(el('p', 'jellio-bookshelf-stats', t('manga_not_configured')));
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
          warnings.appendChild(el('p', 'jellio-manga-warning', t('manga_suwayomi_unreachable')));
          return;
        }
        if (!status.DownloadAsCbz) {
          warnings.appendChild(
            el('p', 'jellio-manga-warning', t('manga_cbz_warning')),
          );
        }
      })
      .catch(function () {});

    const form = el('form', 'jellio-book-request-form jellio-manga-search');
    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'jellio-book-request-input';
    input.placeholder = t('manga_series_title');
    input.value = opts.query || '';
    const submit = el('button', 'jellio-book-request-submit', t('action_search'));
    submit.type = 'submit';
    form.appendChild(input);
    form.appendChild(submit);
    pane.appendChild(form);
    const status = el('p', 'jellio-book-request-status');
    pane.appendChild(status);
    const results = el('div', 'jellio-manga-sources');
    pane.appendChild(results);

    let token = 0;
    let abort = null;
    // Each source's results show as it answers, best match first, with
    // how many are still searching and which are skipped for now.
    function search(query, fallback) {
      const mine = ++token;
      if (abort) abort.abort();
      abort = new AbortController();
      results.textContent = '';
      status.textContent = t('manga_searching_sources');
      submit.disabled = true;
      let shown = 0;
      function place(source) {
        const group = buildSource(source);
        const match = bestMangaMatch(source);
        group.dataset.match = String(match);
        const after = Array.from(results.children).find(function (child) {
          return Number(child.dataset.match || 0) < match;
        });
        results.insertBefore(group, after || null);
        shown++;
      }
      function unavailableNote(summary) {
        return summary.Unavailable.length ? 'Unavailable for now: ' + summary.Unavailable.join(', ') + '.' : '';
      }
      streamMangaSources(
        query,
        function (event) {
          if (mine !== token) return;
          const source = event.source;
          if (event.type === 'source' && source && source.Results.length && (source.Status === 'Ok' || source.Status === 'Cached')) {
            place(source);
          }
          const summary = event.summary;
          if (summary.Pending > 0) {
            status.textContent =
              (shown ? 'Found on ' + shown + (shown === 1 ? ' source' : ' sources') + ' so far. ' : '') +
              'Still searching ' + summary.Pending + (summary.Pending === 1 ? ' source…' : ' sources…') +
              (unavailableNote(summary) ? ' ' + unavailableNote(summary) : '');
          }
        },
        abort.signal,
      )
        .then(function (response) {
          if (mine !== token) return;
          if (!shown) response.Sources.forEach(place);
          if (!shown && fallback && response.Searched > response.Failed) {
            input.value = fallback;
            search(fallback, null);
            return;
          }
          const note = unavailableNote(response);
          status.textContent = shown
            ? 'Found on ' + shown + (shown === 1 ? ' source.' : ' sources.') + ' Pick one to read.' + (note ? ' ' + note : '')
            : emptyReason(query, response) + (note ? ' ' + note : '');
        })
        .catch(function () {
          if (mine !== token) return;
          status.textContent = t('manga_suwayomi_check_url');
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
    button.appendChild(el('span', 'material-icons menu_book'));
    const text = el('span', null, t('action_read'));
    button.appendChild(text);
    // Like opening a series in Mihon's Browse: Suwayomi loads its chapters
    // and the series page opens. It joins the reader's shelf when they
    // read it (or tap the heart), not before.
    // The library has this title from another source: open that one,
    // switch to this source keeping progress, or add this one as well.
    function askDuplicate(existing) {
      button.hidden = true;
      const choice = el('div', 'jellio-book-request-duplicate');
      choice.appendChild(
        el('p', 'jellio-book-request-byline', t('manga_already_in_library', { title: existing.Title })),
      );
      const open = el('button', 'jellio-book-request-action', t('manga_open_it'));
      open.type = 'button';
      open.addEventListener('click', function () {
        if (opts.openSeries) {
          close();
          opts.openSeries(existing.Key);
        }
      });
      const move = el('button', 'jellio-book-request-action', t('manga_switch_source'));
      move.type = 'button';
      move.addEventListener('click', function () {
        move.disabled = true;
        move.textContent = t('action_switching');
        migrateMangaSeries(existing.MangaId, manga.MangaId)
          .then(function (result) {
            invalidateStreamLibrary();
            if (opts.openSeries) {
              close();
              opts.openSeries(result.Key);
            } else {
              choice.textContent = t('manga_switched_progress');
            }
          })
          .catch(function () {
            move.disabled = false;
            move.textContent = t('manga_couldnt_switch');
          });
      });
      const both = el('button', 'jellio-book-request-action', t('manga_add_anyway'));
      both.type = 'button';
      both.addEventListener('click', function () {
        choice.remove();
        button.hidden = false;
        button.disabled = true;
        text.textContent = t('action_opening');
        requestMangaSeries(manga.MangaId, manga.Title, false, true)
          .then(function () {
            invalidateStreamLibrary();
            if (opts.openSeries) {
              close();
              opts.openSeries(mangaSeriesKey(manga.Title));
            }
          })
          .catch(function () {
            text.textContent = t('manga_couldnt_open');
            button.disabled = false;
          });
      });
      [open, move, both].forEach((b) => choice.appendChild(b));
      actions.appendChild(choice);
    }
    button.addEventListener('click', function () {
      button.disabled = true;
      text.textContent = t('action_opening');
      requestMangaSeries(manga.MangaId, manga.Title, false)
        .then(function (response) {
          invalidateStreamLibrary();
          if (response && response.Status === 'duplicate') {
            askDuplicate(response.Existing);
            return;
          }
          if (!response || (response.Status !== 'added' && response.Status !== 'exists')) {
            text.textContent = (response && response.Message) || 'Couldn’t open it';
            button.disabled = false;
            button.classList.add('jellio-book-request-action-error');
            return;
          }
          if (opts.openSeries) {
            close();
            opts.openSeries(mangaSeriesKey(manga.Title));
            return;
          }
          text.textContent = response.TotalChapters + (response.TotalChapters === 1 ? ' chapter' : ' chapters') + ' ready';
          button.classList.add('jellio-book-request-action-done');
        })
        .catch(function () {
          text.textContent = t('manga_couldnt_open');
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
    if (!opts.suwayomi) {
      const hint = el('div', 'jellio-manga-warnings');
      hint.appendChild(
        el(
          'p',
          'jellio-manga-warning',
          'Only published volumes are searched here, which most manhwa and manhua don’t have. For chapters, an admin can add a Suwayomi URL in Jellio’s plugin settings.',
        ),
      );
      pane.appendChild(hint);
    }
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
