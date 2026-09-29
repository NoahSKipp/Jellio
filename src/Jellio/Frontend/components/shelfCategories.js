// Mihon-style categories on the book shelves (runtime/shelf.js): a
// checklist for putting series or books into categories, and a dialog
// for adding, renaming, reordering and deleting them.
import {
  loadShelf,
  createCategory,
  updateCategory,
  deleteCategory,
  orderCategories,
  setMembership,
} from '../runtime/shelf.js';
import { showToast } from './toast.js';
import { el } from '../runtime/dom.js';

const OVERLAY_ID = 'jellioShelfCategories';

function close() {
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();
  document.removeEventListener('keydown', onKeydown);
}

function onKeydown(event) {
  if (event.key === 'Escape') close();
}

function modal(title) {
  close();
  const overlay = el('div', 'jellio-avatar-picker-overlay');
  overlay.id = OVERLAY_ID;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', title);
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
  panel.appendChild(el('h2', 'jellio-avatar-picker-title', title));
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  return panel;
}

function iconButton(icon, label, onClick) {
  const button = el('button', 'jellio-shelf-categories-icon');
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.appendChild(el('span', 'material-icons ' + icon));
  button.addEventListener('click', onClick);
  return button;
}

// A text field and button that adds a category.
function newCategoryForm(kind, onCreated) {
  const form = el('form', 'jellio-shelf-categories-new');
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 40;
  input.placeholder = 'New category, e.g. Reading';
  input.setAttribute('aria-label', 'New category name');
  const add = el('button', 'jellio-shelf-categories-add');
  add.type = 'submit';
  add.appendChild(el('span', 'material-icons add'));
  add.appendChild(el('span', null, 'Add'));
  form.appendChild(input);
  form.appendChild(add);
  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    add.disabled = true;
    try {
      const category = await createCategory(kind, name);
      input.value = '';
      onCreated(category);
    } catch (err) {
      showToast(err.message);
    } finally {
      add.disabled = false;
      input.focus();
    }
  });
  return form;
}

// Which categories keys (series or books) are in. With several keys,
// a category only starts ticked when all of them are in it.
export async function openCategoryPicker(kind, keys, title) {
  const panel = modal(title ? 'Categories for ' + title : 'Categories');
  const list = el('div', 'jellio-shelf-categories-list');
  panel.appendChild(list);
  const ticked = new Set();
  let first = true;

  async function paint(extraTick) {
    const shelf = await loadShelf(kind);
    if (first) {
      shelf.Categories.forEach(function (category) {
        if (keys.every((key) => category.Items.indexOf(key) !== -1)) ticked.add(category.Id);
      });
      first = false;
    }
    if (extraTick) ticked.add(extraTick);
    list.textContent = '';
    if (!shelf.Categories.length) {
      list.appendChild(el('p', 'jellio-avatar-picker-status', 'No categories yet. Add one below, like Reading or Up to date.'));
    }
    shelf.Categories.forEach(function (category) {
      const row = el('label', 'jellio-shelf-categories-check');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = ticked.has(category.Id);
      box.addEventListener('change', function () {
        if (box.checked) ticked.add(category.Id);
        else ticked.delete(category.Id);
      });
      row.appendChild(box);
      row.appendChild(el('span', null, category.Name));
      list.appendChild(row);
    });
  }

  panel.appendChild(newCategoryForm(kind, (category) => paint(category.Id)));
  const actions = el('div', 'jellio-shelf-categories-actions');
  const save = el('button', 'jellio-shelf-categories-save', 'Save');
  save.type = 'button';
  save.addEventListener('click', async function () {
    save.disabled = true;
    try {
      await setMembership(kind, keys, Array.from(ticked));
      close();
    } catch (err) {
      showToast(err.message);
      save.disabled = false;
    }
  });
  actions.appendChild(save);
  panel.appendChild(actions);
  await paint();
}

export async function openCategoryManager(kind) {
  const panel = modal('Edit categories');
  const list = el('div', 'jellio-shelf-categories-list');
  panel.appendChild(list);

  async function run(action) {
    try {
      await action();
    } catch (err) {
      showToast(err.message);
    }
    paint();
  }

  async function paint() {
    const shelf = await loadShelf(kind);
    const ids = shelf.Categories.map((category) => category.Id);
    list.textContent = '';
    if (!shelf.Categories.length) {
      list.appendChild(el('p', 'jellio-avatar-picker-status', 'No categories yet.'));
    }
    shelf.Categories.forEach(function (category, index) {
      const row = el('div', 'jellio-shelf-categories-row');
      const name = document.createElement('input');
      name.type = 'text';
      name.maxLength = 40;
      name.value = category.Name;
      name.setAttribute('aria-label', 'Category name');
      name.addEventListener('change', function () {
        const next = name.value.trim();
        if (!next || next === category.Name) {
          name.value = category.Name;
          return;
        }
        run(() => updateCategory(kind, category.Id, { Name: next }));
      });
      row.appendChild(name);
      row.appendChild(el('span', 'jellio-shelf-categories-count', String(category.Items.length)));
      const up = iconButton('arrow_upward', 'Move up', function () {
        const next = ids.slice();
        next.splice(index - 1, 0, next.splice(index, 1)[0]);
        run(() => orderCategories(kind, next));
      });
      up.disabled = index === 0;
      const down = iconButton('arrow_downward', 'Move down', function () {
        const next = ids.slice();
        next.splice(index + 1, 0, next.splice(index, 1)[0]);
        run(() => orderCategories(kind, next));
      });
      down.disabled = index === ids.length - 1;
      const remove = iconButton('delete_outline', 'Delete', function () {
        if (!window.confirm('Delete the category “' + category.Name + '”? What’s in it stays on the shelf.')) return;
        run(() => deleteCategory(kind, category.Id));
      });
      row.appendChild(up);
      row.appendChild(down);
      row.appendChild(remove);
      list.appendChild(row);
    });
  }

  panel.appendChild(newCategoryForm(kind, () => paint()));
  await paint();
}
