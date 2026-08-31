// Ported in spirit from Harbor's own real home row customization
// (harborstremio/harbor, src/views/home/customizable-rows.tsx,
// row-controls.tsx, home-customize-bar.tsx and lib/home-customization.ts,
// confirmed against that real source before writing this): reorder,
// hide and reset a row's own position on the home screen, entirely
// client side the same way every other personal-to-this-browser
// preference in this runtime already is (components/streamPicker.js's
// own remembered stream choice, screens/player.js's own subtitle
// style). Harbor's own real editor uses move up/down buttons rather
// than real drag and drop, confirmed against that source rather than
// assumed, the one real reason this whole feature also works identically
// on a phone with nothing further to design for that case: a button
// tap needs no pointer-drag gesture at all.
//
// Scoped to what was actually asked (reorder, hide, reset) rather than
// porting Harbor's own full real feature set: no per-row rename, no Top
// 10 numerals toggle, no hero-source picking, no custom addon sources
// or list rows, none of which this runtime has an equivalent concept
// of to attach them to.

const STORAGE_KEY = 'jellioHomeCustomization';

function defaultCustomization() {
  return { order: [], hidden: [] };
}

export function getHomeCustomization() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
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
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(customization));
  } catch (err) {
    // Client only preference: a write that fails leaves the in-memory
    // choice acting for this session, nothing further to recover here.
  }
}

export function resetHomeCustomization() {
  saveHomeCustomization(defaultCustomization());
}

export function hasCustomization(customization) {
  return customization.order.length > 0 || customization.hidden.length > 0;
}

// Ported from Harbor's own real effectiveOrder(): whatever this
// session's own rows actually are right now (a catalog row, a "Because
// you watched X" row, a discovered genre row, any of which can
// legitimately be a different real set from one visit to the next)
// filtered through whatever order this reader saved last time, any
// stored key no longer live today silently dropped, any live key never
// seen before appended after it in its own natural order rather than
// lost. Nothing here ever needs a stored key list to exactly match
// today's real rows for the whole feature to keep working.
export function effectiveOrder(liveKeys, customization) {
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

export function moveRowKey(customization, liveKeys, key, delta) {
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

export function toggleRowHiddenKey(customization, key) {
  const has = customization.hidden.includes(key);
  const updated = Object.assign({}, customization, {
    hidden: has ? customization.hidden.filter(function (k) { return k !== key; }) : customization.hidden.concat([key]),
  });
  saveHomeCustomization(updated);
  return updated;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Real bug, found live in a headless test before this ever shipped:
// effectiveOrder()'s own fallback ("no stored order, so whatever's
// live right now") used to read live order straight off the current
// DOM, which applyHomeCustomization() below itself reorders via
// appendChild. A real reorder followed by Reset restored nothing,
// since by then the DOM itself, the only place "default order" was
// ever read from, already was the reordered one. A monotonic counter
// stamped once here, at the moment each row is first built (screens/
// home.js's own progressive section building always pushes rows in
// the same real relative sequence every render regardless of which
// phase's own network call happens to resolve first, confirmed
// against that file's own header before relying on it), gives
// effectiveOrder() a real, stable baseline no later reorder can ever
// overwrite.
let naturalOrderCounter = 0;

// Wraps a real row element (whatever buildRow()/buildHubStrip() etc.
// already built) so its own eventual control bar and hidden state have
// somewhere to live without moving or cloning the row element itself.
// Called once, at the moment each row is first built, well before this
// reader's own saved order/hidden state is even known yet (screens/
// home.js's own progressive section building fires this from several
// real, independent async phases); applyHomeCustomization() below is
// what actually fills the bar in and reacts to that saved state, once
// the real, current set of rows is fully known.
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
  return (title && title.textContent) || 'Row';
}

function buildRowBar(wrapper, key, hidden, canMoveUp, canMoveDown, onChange) {
  const bar = wrapper.querySelector('.jellio-row-editor-bar');
  bar.textContent = '';
  bar.appendChild(el('span', 'jellio-row-editor-name', rowDisplayName(wrapper)));

  const actions = el('div', 'jellio-row-editor-actions');

  const up = el('button', 'jellio-row-editor-button');
  up.type = 'button';
  up.title = 'Move up';
  up.setAttribute('aria-label', 'Move row up');
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
  down.title = 'Move down';
  down.setAttribute('aria-label', 'Move row down');
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

// The one real place order/hidden state actually becomes DOM: reads
// whatever real .jellio-row-editor wrappers currently sit inside
// rowsContainer (screens/home.js's own progressive rendering means this
// runs more than once as more of them arrive), reorders them via
// appendChild the same way screens/home.js's own final section replay
// already relies on that moving rather than duplicating an already
// attached node, and rebuilds every row's own control bar against the
// currently live key set so up/down buttons are never left enabled
// past either end of it.
export function applyHomeCustomization(rowsContainer, editMode) {
  rowsContainer.classList.toggle('jellio-home-editing', editMode);

  const wrappers = Array.prototype.slice.call(
    rowsContainer.querySelectorAll(':scope > .jellio-row-editor'),
  );
  if (!wrappers.length) return;

  // Natural order, not current DOM order: this same call is what
  // moves wrappers around the DOM a moment from now, so reading live
  // order back off the DOM here would let today's reorder quietly
  // become tomorrow's new "default" the instant a reader hit Reset.
  const liveKeys = wrappers
    .slice()
    .sort(function (a, b) {
      return Number(a.dataset.jellioNaturalOrder) - Number(b.dataset.jellioNaturalOrder);
    })
    .map(function (w) {
      return w.dataset.jellioRowKey;
    });
  const byKey = new Map(wrappers.map(function (w) {
    return [w.dataset.jellioRowKey, w];
  }));
  const customization = getHomeCustomization();
  const order = effectiveOrder(liveKeys, customization);

  order.forEach(function (key) {
    const wrapper = byKey.get(key);
    if (wrapper) rowsContainer.appendChild(wrapper);
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

  const resetButton = el('button', 'jellio-home-customize-reset', 'Reset');
  resetButton.type = 'button';
  const resetIcon = el('span', 'material-icons', 'restart_alt');
  resetButton.prepend(resetIcon);
  resetButton.addEventListener('click', onReset);
  bar.appendChild(resetButton);

  const editButton = el('button', 'jellio-home-customize-toggle', 'Customize');
  editButton.type = 'button';
  const editIcon = el('span', 'material-icons', 'tune');
  editButton.prepend(editIcon);
  editButton.addEventListener('click', onToggleEdit);
  bar.appendChild(editButton);

  return { bar: bar, resetButton: resetButton, editButton: editButton };
}

export function updateHomeCustomizeBar(elements, editMode) {
  elements.editButton.classList.toggle('jellio-home-customize-toggle-active', editMode);
  elements.editButton.lastChild.textContent = editMode ? 'Done' : 'Customize';
  elements.resetButton.style.display = editMode ? '' : 'none';
}
