// Mihon's chapter settings for one series: filters (each off, only, or
// without), the sort, and how a chapter is named. Changes apply as they
// are made and are remembered per series (screens/mangaSeries.js saves
// them); Set as default makes them the starting point for other series.
import { el } from '../runtime/dom.js';

const OVERLAY_ID = 'jellioChapterSettings';

function close() {
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();
  document.removeEventListener('keydown', onKeydown);
}

function onKeydown(event) {
  if (event.key === 'Escape') close();
}

const SORTS = [
  { value: 'source', label: 'By source' },
  { value: 'number', label: 'By chapter number' },
  { value: 'date', label: 'By upload date' },
  { value: 'title', label: 'Alphabetically' },
];

// options: { settings, scanlators: [{name,count}], shownGroups, onChange(patch),
// onScanlators(), onSetDefault(applyToLibrary), onReset() }
export function openChapterSettings(options) {
  close();
  const state = Object.assign({}, options.settings);
  let tab = 'filter';

  const overlay = el('div', 'jellio-avatar-picker-overlay');
  overlay.id = OVERLAY_ID;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Chapter settings');
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
  panel.appendChild(el('h2', 'jellio-avatar-picker-title', 'Chapter settings'));

  const tabs = el('div', 'jellio-shelf-tabs jellio-chapter-settings-tabs');
  tabs.setAttribute('role', 'tablist');
  panel.appendChild(tabs);
  const content = el('div', 'jellio-chapter-settings-content');
  panel.appendChild(content);
  const footer = el('div', 'jellio-chapter-settings-footer');
  panel.appendChild(footer);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  function change(patch) {
    Object.assign(state, patch);
    options.onChange(patch);
    paint();
  }

  // Off, then only these, then everything but these.
  function triState(label, key) {
    const mode = state[key];
    const row = el('button', 'jellio-chapter-settings-row');
    row.type = 'button';
    row.setAttribute('role', 'checkbox');
    row.setAttribute('aria-checked', mode === 'include' ? 'true' : mode === 'exclude' ? 'mixed' : 'false');
    row.appendChild(el('span', 'material-icons ' + (mode === 'include' ? 'check_box' : mode === 'exclude' ? 'indeterminate_check_box' : 'check_box_outline_blank')));
    row.appendChild(el('span', 'jellio-chapter-settings-label', label));
    if (mode) row.appendChild(el('span', 'jellio-chapter-settings-hint', mode === 'include' ? 'Only' : 'Hide'));
    row.addEventListener('click', function () {
      const next = mode == null ? 'include' : mode === 'include' ? 'exclude' : null;
      const patch = {};
      patch[key] = next;
      change(patch);
    });
    return row;
  }

  function paintFilter() {
    content.appendChild(triState('Downloaded', 'downloaded'));
    content.appendChild(triState('Unread', 'unread'));
    content.appendChild(triState('Bookmarked', 'bookmarked'));
    if (options.scanlators.length > 1) {
      const groups = el('button', 'jellio-chapter-settings-row');
      groups.type = 'button';
      groups.appendChild(el('span', 'material-icons groups'));
      groups.appendChild(el('span', 'jellio-chapter-settings-label', 'Scanlators'));
      if (options.shownGroups < options.scanlators.length) {
        groups.appendChild(el('span', 'jellio-chapter-settings-hint', options.shownGroups + ' of ' + options.scanlators.length));
      }
      groups.addEventListener('click', function () {
        close();
        options.onScanlators();
      });
      content.appendChild(groups);
    }
  }

  // Choosing the sort in use again flips its direction.
  function paintSort() {
    SORTS.forEach(function (entry) {
      const active = state.sort === entry.value;
      const row = el('button', 'jellio-chapter-settings-row');
      row.type = 'button';
      row.setAttribute('role', 'radio');
      row.setAttribute('aria-checked', active ? 'true' : 'false');
      row.appendChild(el('span', 'material-icons ' + (active ? (state.descending ? 'arrow_downward' : 'arrow_upward') : 'remove')));
      row.appendChild(el('span', 'jellio-chapter-settings-label', entry.label));
      if (active) row.appendChild(el('span', 'jellio-chapter-settings-hint', state.descending ? 'Newest first' : 'Oldest first'));
      row.addEventListener('click', function () {
        if (active) change({ descending: !state.descending });
        else change({ sort: entry.value });
      });
      content.appendChild(row);
    });
  }

  function paintDisplay() {
    [
      { value: 'title', label: 'Show the source’s title' },
      { value: 'number', label: 'Show the chapter number' },
    ].forEach(function (entry) {
      const active = state.display === entry.value;
      const row = el('button', 'jellio-chapter-settings-row');
      row.type = 'button';
      row.setAttribute('role', 'radio');
      row.setAttribute('aria-checked', active ? 'true' : 'false');
      row.appendChild(el('span', 'material-icons ' + (active ? 'radio_button_checked' : 'radio_button_unchecked')));
      row.appendChild(el('span', 'jellio-chapter-settings-label', entry.label));
      row.addEventListener('click', function () {
        change({ display: entry.value });
      });
      content.appendChild(row);
    });
  }

  function paintFooter() {
    footer.textContent = '';
    const setDefault = el('button', 'jellio-chapter-settings-action', 'Set as default');
    setDefault.type = 'button';
    setDefault.addEventListener('click', function () {
      footer.textContent = '';
      const ask = el('label', 'jellio-shelf-categories-check');
      const box = document.createElement('input');
      box.type = 'checkbox';
      ask.appendChild(box);
      ask.appendChild(el('span', null, 'Also use these for every series on my shelf'));
      footer.appendChild(ask);
      const actions = el('div', 'jellio-shelf-categories-actions');
      const cancel = el('button', 'jellio-chapter-settings-action', 'Cancel');
      cancel.type = 'button';
      cancel.addEventListener('click', paintFooter);
      const ok = el('button', 'jellio-shelf-categories-save', 'Use as default');
      ok.type = 'button';
      ok.addEventListener('click', function () {
        options.onSetDefault(box.checked);
        paintFooter();
      });
      actions.appendChild(cancel);
      actions.appendChild(ok);
      footer.appendChild(actions);
    });
    const reset = el('button', 'jellio-chapter-settings-action', 'Reset');
    reset.type = 'button';
    reset.title = 'Go back to the defaults for this series';
    reset.addEventListener('click', function () {
      options.onReset();
      close();
    });
    footer.appendChild(setDefault);
    footer.appendChild(reset);
  }

  function paint() {
    tabs.textContent = '';
    [
      { id: 'filter', label: 'Filter' },
      { id: 'sort', label: 'Sort' },
      { id: 'display', label: 'Display' },
    ].forEach(function (entry) {
      const button = el('button', 'jellio-shelf-tab' + (tab === entry.id ? ' jellio-shelf-tab-active' : ''), entry.label);
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', tab === entry.id ? 'true' : 'false');
      button.addEventListener('click', function () {
        tab = entry.id;
        paint();
      });
      tabs.appendChild(button);
    });
    content.textContent = '';
    if (tab === 'filter') paintFilter();
    else if (tab === 'sort') paintSort();
    else paintDisplay();
  }

  paint();
  paintFooter();
}
