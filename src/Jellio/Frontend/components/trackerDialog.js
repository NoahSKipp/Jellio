// Mihon's tracking, for AniList: connect the reader's account (the token
// goes to the server and stays there), link this series to an AniList
// entry, and set its status and score. Chapters read are written to
// AniList as they're finished (runtime/api.js syncTracker).
import {
  getTrackerStatus,
  connectTracker,
  disconnectTracker,
  searchTracker,
  getTrackerLink,
  setTrackerLink,
  removeTrackerLink,
  setTrackerEntry,
  syncTracker,
} from '../runtime/api.js';
import { showToast } from './toast.js';
import { el } from '../runtime/dom.js';

const OVERLAY_ID = 'jellioTracker';
const STATUSES = [
  { value: 'CURRENT', label: 'Reading' },
  { value: 'PLANNING', label: 'Plan to read' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'PAUSED', label: 'On hold' },
  { value: 'DROPPED', label: 'Dropped' },
  { value: 'REPEATING', label: 'Rereading' },
];

function close() {
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();
  document.removeEventListener('keydown', onKeydown);
}

function onKeydown(event) {
  if (event.key === 'Escape') close();
}

function button(label, className, onClick) {
  const b = el('button', className, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

// options: { key: series shelf key, mangaId, episode, mediaType, title, onChange(link|null) }
export function openTrackerDialog(options) {
  close();
  const isAnime = options.mediaType === 'ANIME';
  const overlay = el('div', 'jellio-avatar-picker-overlay');
  overlay.id = OVERLAY_ID;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Tracking');
  overlay.addEventListener('click', function (event) {
    if (event.target === overlay) close();
  });
  document.addEventListener('keydown', onKeydown);

  const panel = el('div', 'jellio-avatar-picker-panel jellio-shelf-categories-panel jellio-tracker-panel');
  const closeButton = el('button', 'jellio-group-watch-close');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Close');
  closeButton.appendChild(el('span', 'material-icons close'));
  closeButton.addEventListener('click', close);
  panel.appendChild(closeButton);
  panel.appendChild(el('h2', 'jellio-avatar-picker-title', 'Tracking'));
  const body = el('div', 'jellio-tracker-body');
  panel.appendChild(body);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  function message(text) {
    body.textContent = '';
    body.appendChild(el('p', 'jellio-avatar-picker-status', text));
  }

  function connectView(status) {
    body.textContent = '';
    body.appendChild(
      el(
        'p',
        'jellio-avatar-picker-status',
        isAnime
          ? 'Link your AniList account to keep the episodes you watch in step with your list.'
          : 'Link your AniList account to keep the chapters you read in step with your list.',
      ),
    );
    const authorize =
      'https://anilist.co/api/v2/oauth/authorize?client_id=' + encodeURIComponent(status.ClientId) + '&response_type=token';
    const open = el('a', 'jellio-chapter-settings-action jellio-tracker-link', 'Open AniList and authorise');
    open.href = authorize;
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    body.appendChild(open);
    body.appendChild(el('p', 'jellio-avatar-picker-status', 'Then paste the token AniList gives you:'));
    const input = document.createElement('input');
    input.type = 'password';
    input.className = 'jellio-tracker-input';
    input.placeholder = 'AniList token';
    input.autocomplete = 'off';
    body.appendChild(input);
    const note = el('p', 'jellio-avatar-picker-status');
    body.appendChild(note);
    const save = button('Connect', 'jellio-shelf-categories-save', function () {
      save.disabled = true;
      note.textContent = 'Checking…';
      connectTracker(input.value)
        .then(load)
        .catch(function (err) {
          save.disabled = false;
          note.textContent = (err && err.message) || 'AniList didn’t accept that token.';
        });
    });
    body.appendChild(save);
    input.focus();
  }

  function searchView() {
    body.textContent = '';
    body.appendChild(el('p', 'jellio-avatar-picker-status', 'Find this series on AniList.'));
    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'jellio-tracker-input';
    input.value = options.title || '';
    body.appendChild(input);
    const results = el('div', 'jellio-tracker-results');
    body.appendChild(results);
    let token = 0;
    function run() {
      const mine = ++token;
      results.textContent = '';
      if (!input.value.trim()) return;
      results.appendChild(el('p', 'jellio-avatar-picker-status', 'Searching…'));
      searchTracker(input.value.trim(), options.mediaType || 'MANGA')
        .then(function (found) {
          if (mine !== token) return;
          results.textContent = '';
          if (!found.length) results.appendChild(el('p', 'jellio-avatar-picker-status', 'Nothing found.'));
          found.forEach(function (media) {
            const row = el('button', 'jellio-tracker-result');
            row.type = 'button';
            if (media.CoverUrl) {
              const img = el('img', 'jellio-tracker-cover');
              img.alt = '';
              img.src = media.CoverUrl;
              row.appendChild(img);
            }
            const text = el('span', 'jellio-tracker-result-text');
            text.appendChild(el('span', 'jellio-tracker-result-title', media.Title));
            if (media.Year) text.appendChild(el('span', 'jellio-tracker-result-year', String(media.Year)));
            row.appendChild(text);
            row.addEventListener('click', function () {
              setTrackerLink(options.key, media)
                .then(function () {
                  if (options.onChange) options.onChange({ MediaId: media.Id, Title: media.Title });
                  return syncTracker(options.key, options.mangaId, options.episode);
                })
                .then(load)
                .catch(() => showToast('Couldn’t link that series'));
            });
            results.appendChild(row);
          });
        })
        .catch(function () {
          if (mine === token) {
            results.textContent = '';
            results.appendChild(el('p', 'jellio-avatar-picker-status', 'AniList can’t be reached right now.'));
          }
        });
    }
    let timer = null;
    input.addEventListener('input', function () {
      window.clearTimeout(timer);
      timer = window.setTimeout(run, 400);
    });
    run();
    input.focus();
  }

  function linkedView(status, link, entry) {
    body.textContent = '';
    body.appendChild(el('p', 'jellio-avatar-picker-status', 'Signed in as ' + (status.UserName || 'AniList') + '.'));
    const title = el('a', 'jellio-tracker-linked-title', link.Title || 'AniList entry');
    title.href = (isAnime ? 'https://anilist.co/anime/' : 'https://anilist.co/manga/') + link.MediaId;
    title.target = '_blank';
    title.rel = 'noopener noreferrer';
    body.appendChild(title);

    if (!entry) {
      body.appendChild(el('p', 'jellio-avatar-picker-status', 'AniList isn’t answering, so its status can’t be shown right now.'));
    } else {
      const statusLabel = el('label', 'jellio-tracker-field');
      statusLabel.appendChild(el('span', null, 'Status'));
      const select = document.createElement('select');
      const none = document.createElement('option');
      none.value = '';
      none.textContent = 'Not on your list';
      none.disabled = true;
      select.appendChild(none);
      const statuses = isAnime
        ? [
            { value: 'CURRENT', label: 'Watching' },
            { value: 'PLANNING', label: 'Plan to watch' },
            { value: 'COMPLETED', label: 'Completed' },
            { value: 'PAUSED', label: 'On hold' },
            { value: 'DROPPED', label: 'Dropped' },
            { value: 'REPEATING', label: 'Rewatching' },
          ]
        : STATUSES;
      statuses.forEach(function (option) {
        const o = document.createElement('option');
        o.value = option.value;
        o.textContent = option.label;
        select.appendChild(o);
      });
      select.value = entry.Status || '';
      select.addEventListener('change', function () {
        setTrackerEntry(options.key, { Status: select.value }).catch(() => showToast('Couldn’t change the status'));
      });
      statusLabel.appendChild(select);
      body.appendChild(statusLabel);

      const scoreLabel = el('label', 'jellio-tracker-field');
      scoreLabel.appendChild(el('span', null, 'Score (0 to 10)'));
      const score = document.createElement('input');
      score.type = 'number';
      score.min = '0';
      score.max = '10';
      score.step = '0.5';
      score.value = entry.ScoreRaw ? String(entry.ScoreRaw / 10) : '';
      score.addEventListener('change', function () {
        const value = Math.min(10, Math.max(0, Number(score.value) || 0));
        setTrackerEntry(options.key, { ScoreRaw: Math.round(value * 10) }).catch(() => showToast('Couldn’t save the score'));
      });
      scoreLabel.appendChild(score);
      body.appendChild(scoreLabel);

      const countLabel = isAnime ? 'Episodes watched' : 'Chapters read';
      body.appendChild(
        el('p', 'jellio-avatar-picker-status', countLabel + ' on AniList: ' + entry.Progress + (entry.Total ? ' of ' + entry.Total : '') + '.'),
      );
    }

    const actions = el('div', 'jellio-shelf-categories-actions');
    actions.appendChild(
      button('Sync now', 'jellio-chapter-settings-action', function () {
        syncTracker(options.key, options.mangaId, options.episode).then(function (result) {
          showToast(result && result.Synced ? 'AniList is up to date.' : 'Nothing new to send.');
          load();
        });
      }),
    );
    actions.appendChild(
      button('Unlink', 'jellio-chapter-settings-action', function () {
        removeTrackerLink(options.key).then(function () {
          if (options.onChange) options.onChange(null);
          load();
        });
      }),
    );
    actions.appendChild(
      button('Sign out of AniList', 'jellio-chapter-settings-action', function () {
        disconnectTracker().then(load);
      }),
    );
    body.appendChild(actions);
  }

  function load() {
    message('Loading…');
    getTrackerStatus()
      .then(function (status) {
        if (!status.Available) {
          message('An admin can turn tracking on by adding an AniList client ID in Jellio’s plugin settings.');
          return null;
        }
        if (!status.Connected) {
          connectView(status);
          return null;
        }
        return getTrackerLink(options.key).then(function (result) {
          if (!result.Link) searchView();
          else linkedView(status, result.Link, result.Entry);
        });
      })
      .catch(() => message('Couldn’t reach the server.'));
  }
  load();
}
