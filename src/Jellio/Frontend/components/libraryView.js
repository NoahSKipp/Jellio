// Mihon's library filter and display options for the Manga shelf: which
// series show (unread, started, completed, downloaded; each off, only,
// or hidden), how the covers are laid out, and the unread badge. Kept on
// this device.
import { el } from '../runtime/dom.js';

const KEY = 'jellio-manga-library-view';
const OVERLAY_ID = 'jellioLibraryView';

export const FILTERS = [
  { key: 'unread', label: 'Unread' },
  { key: 'started', label: 'Started' },
  { key: 'completed', label: 'Completed' },
  { key: 'downloaded', label: 'Downloaded' },
];
const DISPLAYS = [
  { value: 'comfortable', label: 'Comfortable grid' },
  { value: 'compact', label: 'Compact grid' },
  { value: 'cover', label: 'Covers only' },
];

const DEFAULT_VIEW = { unread: '', started: '', completed: '', downloaded: '', display: 'comfortable', badges: true };

export function loadLibraryView() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null') || {};
    const view = Object.assign({}, DEFAULT_VIEW);
    FILTERS.forEach((filter) => (view[filter.key] = saved[filter.key] === 'include' || saved[filter.key] === 'exclude' ? saved[filter.key] : ''));
    view.display = DISPLAYS.some((option) => option.value === saved.display) ? saved.display : DEFAULT_VIEW.display;
    view.badges = saved.badges !== false;
    return view;
  } catch (err) {
    return Object.assign({}, DEFAULT_VIEW);
  }
}

function saveLibraryView(view) {
  try {
    localStorage.setItem(KEY, JSON.stringify(view));
  } catch (err) {
    // Remembering is a convenience only.
  }
}

export function activeFilterCount(view) {
  return FILTERS.filter((filter) => view[filter.key]).length;
}

// Whether a shelf entry passes the filters.
export function passesLibraryFilters(entry, view) {
  const stream = entry.seriesGroup && entry.seriesGroup.stream;
  const saved = entry.seriesGroup ? entry.seriesGroup.chapters.length : 0;
  const facts = {
    unread: entry.unread > 0,
    started: entry.readCount > 0,
    completed: entry.chapters > 0 && entry.unread <= 0,
    downloaded: (stream && stream.DownloadedCount > 0) || saved > 0,
  };
  return FILTERS.every(function (filter) {
    const mode = view[filter.key];
    if (!mode) return true;
    return mode === 'include' ? !!facts[filter.key] : !facts[filter.key];
  });
}

function close() {
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();
  document.removeEventListener('keydown', onKeydown);
}

function onKeydown(event) {
  if (event.key === 'Escape') close();
}

// onChange(view) runs after each change.
export function openLibraryView(view, onChange) {
  close();
  const overlay = el('div', 'jellio-avatar-picker-overlay');
  overlay.id = OVERLAY_ID;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Filter and display');
  overlay.addEventListener('click', function (event) {
    if (event.target === overlay) close();
  });
  document.addEventListener('keydown', onKeydown);

  const panel = el('div', 'jellio-avatar-picker-panel jellio-shelf-categories-panel');
  const closeButton = el('button', 'jellio-group-watch-close');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Close');
  closeButton.appendChild(el('span', 'material-icons close'));
  closeButton.addEventListener('click', close);
  panel.appendChild(closeButton);
  panel.appendChild(el('h2', 'jellio-avatar-picker-title', 'Filter and display'));
  const body = el('div', 'jellio-library-view-body');
  panel.appendChild(body);

  function changed() {
    saveLibraryView(view);
    onChange(view);
    paint();
  }

  function paint() {
    body.textContent = '';
    body.appendChild(el('h3', 'jellio-library-view-heading', 'Filter'));
    FILTERS.forEach(function (filter) {
      const mode = view[filter.key];
      const row = el('button', 'jellio-library-view-row');
      row.type = 'button';
      const icon = mode === 'include' ? 'check_box' : mode === 'exclude' ? 'indeterminate_check_box' : 'check_box_outline_blank';
      row.appendChild(el('span', 'material-icons ' + icon));
      row.appendChild(el('span', null, filter.label));
      row.appendChild(el('span', 'jellio-library-view-hint', mode === 'include' ? 'Only these' : mode === 'exclude' ? 'Hidden' : ''));
      row.addEventListener('click', function () {
        view[filter.key] = mode === '' ? 'include' : mode === 'include' ? 'exclude' : '';
        changed();
      });
      body.appendChild(row);
    });
    body.appendChild(el('h3', 'jellio-library-view-heading', 'Display'));
    DISPLAYS.forEach(function (option) {
      const row = el('button', 'jellio-library-view-row');
      row.type = 'button';
      row.appendChild(el('span', 'material-icons ' + (view.display === option.value ? 'radio_button_checked' : 'radio_button_unchecked')));
      row.appendChild(el('span', null, option.label));
      row.addEventListener('click', function () {
        view.display = option.value;
        changed();
      });
      body.appendChild(row);
    });
    body.appendChild(el('h3', 'jellio-library-view-heading', 'Badges'));
    const badge = el('button', 'jellio-library-view-row');
    badge.type = 'button';
    badge.appendChild(el('span', 'material-icons ' + (view.badges ? 'check_box' : 'check_box_outline_blank')));
    badge.appendChild(el('span', null, 'Unread chapters'));
    badge.addEventListener('click', function () {
      view.badges = !view.badges;
      changed();
    });
    body.appendChild(badge);
    if (activeFilterCount(view)) {
      const reset = el('button', 'jellio-chapter-settings-action', 'Clear filters');
      reset.type = 'button';
      reset.addEventListener('click', function () {
        FILTERS.forEach((filter) => (view[filter.key] = ''));
        changed();
      });
      body.appendChild(reset);
    }
  }
  paint();
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}
