import { t } from '../runtime/i18n.js';

import { el } from '../runtime/dom.js';
import { readString, writeJson } from '../runtime/storage.js';

const STORAGE_KEY = 'jellioHomeCustomization';

function defaultCustomization() {
  return { order: [], hidden: [] };
}

function getHomeCustomization() {
  try {
    const raw = readString(STORAGE_KEY);
    if (!raw) return defaultCustomization();
    const parsed = JSON.parse(raw);
    return {
      order: Array.isArray(parsed.order) ? parsed.order : [],
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden : [],
    };
  } catch (err) {
    return defaultCustomization();
  }
}

function saveHomeCustomization(customization) {
  writeJson(STORAGE_KEY, customization);
}

export function resetHomeCustomization() {
  saveHomeCustomization(defaultCustomization());
}

function effectiveOrder(liveKeys, customization) {
  const liveSet = new Set(liveKeys);
  const ordered = customization.order.filter(function (key) {
    return liveSet.has(key);
  });
  const seen = new Set(ordered);
  liveKeys.forEach(function (key) {
    if (!seen.has(key)) ordered.push(key);
  });
  return ordered;
}

function moveRowKey(customization, liveKeys, key, delta) {
  const order = effectiveOrder(liveKeys, customization);
  const idx = order.indexOf(key);
  if (idx < 0) return customization;
  const target = idx + delta;
  if (target < 0 || target >= order.length) return customization;
  const next = order.slice();
  const tmp = next[idx];
  next[idx] = next[target];
  next[target] = tmp;
  const updated = Object.assign({}, customization, { order: next });
  saveHomeCustomization(updated);
  return updated;
}

function toggleRowHiddenKey(customization, key) {
  const has = customization.hidden.includes(key);
  const updated = Object.assign({}, customization, {
    hidden: has ? customization.hidden.filter(function (k) { return k !== key; }) : customization.hidden.concat([key]),
  });
  saveHomeCustomization(updated);
  return updated;
}

let naturalOrderCounter = 0;

export function wrapRowForCustomization(rowElement, key) {
  const wrapper = el('div', 'jellio-row-editor');
  wrapper.dataset.jellioRowKey = key;
  wrapper.dataset.jellioNaturalOrder = String(naturalOrderCounter++);
  wrapper.appendChild(el('div', 'jellio-row-editor-bar'));
  const content = el('div', 'jellio-row-editor-content');
  content.appendChild(rowElement);
  wrapper.appendChild(content);
  return wrapper;
}

function rowDisplayName(wrapper) {
  const title = wrapper.querySelector('.jellio-row-title');
  if (!title) return 'Row';
  const clone = title.cloneNode(true);
  const icons = clone.querySelectorAll('.jellio-row-title-chevron, .material-icons');
  for (let i = 0; i < icons.length; i++) {
    if (icons[i].parentNode) {
      icons[i].parentNode.removeChild(icons[i]);
    }
  }
  return clone.textContent.trim() || 'Row';
}

function buildRowBar(wrapper, key, hidden, canMoveUp, canMoveDown, onChange) {
  const bar = wrapper.querySelector('.jellio-row-editor-bar');
  bar.textContent = '';
  bar.appendChild(el('span', 'jellio-row-editor-name', rowDisplayName(wrapper)));

  const actions = el('div', 'jellio-row-editor-actions');

  const up = el('button', 'jellio-row-editor-button');
  up.type = 'button';
  up.title = t('action_move_up');
  up.setAttribute('aria-label', t('home_move_row_up'));
  up.disabled = !canMoveUp;
  up.appendChild(el('span', 'material-icons', 'arrow_upward'));
  up.addEventListener('click', function () {
    onChange(function (customization, liveKeys) {
      return moveRowKey(customization, liveKeys, key, -1);
    });
  });
  actions.appendChild(up);

  const down = el('button', 'jellio-row-editor-button');
  down.type = 'button';
  down.title = t('action_move_down');
  down.setAttribute('aria-label', t('home_move_row_down'));
  down.disabled = !canMoveDown;
  down.appendChild(el('span', 'material-icons', 'arrow_downward'));
  down.addEventListener('click', function () {
    onChange(function (customization, liveKeys) {
      return moveRowKey(customization, liveKeys, key, 1);
    });
  });
  actions.appendChild(down);

  const toggle = el(
    'button',
    'jellio-row-editor-button' + (hidden ? ' jellio-row-editor-button-active' : ''),
  );
  toggle.type = 'button';
  toggle.title = hidden ? 'Show row' : 'Hide row';
  toggle.setAttribute('aria-label', hidden ? 'Show row' : 'Hide row');
  toggle.appendChild(el('span', 'material-icons', hidden ? 'visibility_off' : 'visibility'));
  toggle.addEventListener('click', function () {
    onChange(function (customization) {
      return toggleRowHiddenKey(customization, key);
    });
  });
  actions.appendChild(toggle);

  bar.appendChild(actions);
}

export function applyHomeCustomization(rowsContainer, editMode) {
  rowsContainer.classList.toggle('jellio-home-editing', editMode);

  const wrappers = Array.prototype.slice.call(
    rowsContainer.querySelectorAll(':scope > .jellio-row-editor'),
  );
  if (!wrappers.length) return;

  const liveKeys = wrappers
    .slice()
    .sort(function (a, b) {
      const homeA = a.dataset.jellioHomeOrder !== undefined ? Number(a.dataset.jellioHomeOrder) : null;
      const homeB = b.dataset.jellioHomeOrder !== undefined ? Number(b.dataset.jellioHomeOrder) : null;
      if (homeA !== null && homeB !== null && !Number.isNaN(homeA) && !Number.isNaN(homeB) && homeA !== homeB) {
        return homeA - homeB;
      }
      return Number(a.dataset.jellioNaturalOrder || 0) - Number(b.dataset.jellioNaturalOrder || 0);
    })
    .map(function (w) {
      return w.dataset.jellioRowKey;
    });
  const byKey = new Map(wrappers.map(function (w) {
    return [w.dataset.jellioRowKey, w];
  }));
  const customization = getHomeCustomization();
  const order = effectiveOrder(liveKeys, customization);

  const skeleton = rowsContainer.querySelector(':scope > .jellio-home-skeleton');
  const ordered = order.map(function (key) {
    return byKey.get(key);
  }).filter(Boolean);
  const desired = Array.from(rowsContainer.children)
    .filter(function (child) {
      return child !== skeleton && !child.classList.contains('jellio-row-editor');
    })
    .concat(ordered, skeleton && skeleton.parentNode === rowsContainer ? [skeleton] : []);
  let anchor = rowsContainer.firstElementChild;
  desired.forEach(function (node) {
    if (node === anchor) {
      anchor = anchor.nextElementSibling;
    } else {
      rowsContainer.insertBefore(node, anchor);
    }
  });

  function onChange(mutate) {
    const current = getHomeCustomization();
    mutate(current, liveKeys);
    applyHomeCustomization(rowsContainer, editMode);
  }

  order.forEach(function (key, index) {
    const wrapper = byKey.get(key);
    if (!wrapper) return;
    const hidden = customization.hidden.includes(key);
    wrapper.dataset.hidden = String(hidden);
    buildRowBar(wrapper, key, hidden, index > 0, index < order.length - 1, onChange);
  });
}

export function buildHomeCustomizeBar(onToggleEdit, onReset) {
  const bar = el('div', 'jellio-home-customize-bar');

  const resetButton = el('button', 'jellio-home-customize-reset', t('action_reset'));
  resetButton.type = 'button';
  const resetIcon = el('span', 'material-icons', 'restart_alt');
  resetButton.prepend(resetIcon);
  resetButton.addEventListener('click', onReset);
  bar.appendChild(resetButton);

  const editButton = el('button', 'jellio-home-customize-toggle', t('home_customize'));
  editButton.type = 'button';
  const editIcon = el('span', 'material-icons', 'tune');
  editButton.prepend(editIcon);
  editButton.addEventListener('click', onToggleEdit);
  bar.appendChild(editButton);

  return { bar: bar, resetButton: resetButton, editButton: editButton };
}

export function updateHomeCustomizeBar(elements, editMode) {
  if (elements.bar) {
    elements.bar.style.display = editMode ? '' : 'none';
  }
  elements.editButton.classList.toggle('jellio-home-customize-toggle-active', editMode);
  elements.editButton.lastChild.textContent = editMode ? 'Done' : 'Customize';
  elements.resetButton.style.display = editMode ? '' : 'none';
}
