import { t } from '../runtime/i18n.js';
// Mihon's per-manga scanlator filter: which groups' chapters this series
// shows, so the same chapter from several of them isn't listed more than
// once. Remembered per series (screens/mangaSeries.js saves it).
import { el } from '../runtime/dom.js';

const OVERLAY_ID = 'jellioScanlatorFilter';

function close() {
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();
  document.removeEventListener('keydown', onKeydown);
}

function onKeydown(event) {
  if (event.key === 'Escape') close();
}

// available: [{ name, count }]. excluded: the names hidden now.
// onSave({ excluded: [names], duplicatesAsOne }).
export function openScanlatorFilter(options) {
  close();
  const overlay = el('div', 'jellio-avatar-picker-overlay');
  overlay.id = OVERLAY_ID;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', t('manga_scanlators'));
  overlay.addEventListener('click', function (event) {
    if (event.target === overlay) close();
  });
  document.addEventListener('keydown', onKeydown);

  const panel = el('div', 'jellio-avatar-picker-panel jellio-shelf-categories-panel');
  const closeButton = el('button', 'jellio-group-watch-close');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', t('action_close'));
  closeButton.appendChild(el('span', 'material-icons close'));
  closeButton.addEventListener('click', close);
  panel.appendChild(closeButton);
  panel.appendChild(el('h2', 'jellio-avatar-picker-title', t('manga_scanlators')));
  panel.appendChild(
    el('p', 'jellio-avatar-picker-status', t('manga_scanlators_desc')),
  );

  const hidden = new Set((options.excluded || []).map((name) => name.toLowerCase()));
  const list = el('div', 'jellio-shelf-categories-list');
  panel.appendChild(list);
  const boxes = [];
  options.available.forEach(function (entry) {
    const row = el('label', 'jellio-shelf-categories-check');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !hidden.has(entry.name.toLowerCase());
    box.addEventListener('change', refresh);
    boxes.push({ box: box, name: entry.name });
    row.appendChild(box);
    row.appendChild(el('span', 'jellio-scanlator-name', entry.name));
    row.appendChild(el('span', 'jellio-scanlator-count', entry.count + (entry.count === 1 ? ' chapter' : ' chapters')));
    list.appendChild(row);
  });

  const duplicates = el('label', 'jellio-shelf-categories-check jellio-scanlator-duplicates');
  const duplicatesBox = document.createElement('input');
  duplicatesBox.type = 'checkbox';
  duplicatesBox.checked = options.duplicatesAsOne !== false;
  duplicates.appendChild(duplicatesBox);
  const duplicatesText = el('span', null);
  duplicatesText.appendChild(el('span', 'jellio-scanlator-name', t('manga_mark_duplicate_read')));
  duplicatesText.appendChild(el('span', 'jellio-scanlator-hint', t('manga_mark_duplicate_read_desc')));
  duplicates.appendChild(duplicatesText);
  panel.appendChild(duplicates);

  const note = el('p', 'jellio-avatar-picker-status');
  panel.appendChild(note);

  const actions = el('div', 'jellio-shelf-categories-actions jellio-scanlator-actions');
  const reset = el('button', 'jellio-chapter-settings-action jellio-scanlator-reset', t('action_show_all'));
  reset.type = 'button';
  reset.addEventListener('click', function () {
    boxes.forEach((entry) => (entry.box.checked = true));
    refresh();
  });
  const save = el('button', 'jellio-shelf-categories-save', t('profile_save'));
  save.type = 'button';
  actions.appendChild(reset);
  actions.appendChild(save);
  panel.appendChild(actions);

  // At least one group has to stay: an empty list helps nobody.
  function refresh() {
    const shown = boxes.filter((entry) => entry.box.checked).length;
    save.disabled = shown === 0;
    note.textContent = shown === 0 ? 'Keep at least one group ticked.' : shown < boxes.length ? boxes.length - shown + ' hidden' : '';
    reset.hidden = shown === boxes.length;
  }
  refresh();

  save.addEventListener('click', function () {
    options.onSave({
      excluded: boxes.filter((entry) => !entry.box.checked).map((entry) => entry.name),
      duplicatesAsOne: duplicatesBox.checked,
    });
    close();
  });

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  const first = panel.querySelector('input');
  if (first) first.focus();
}
