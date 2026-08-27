// Preset avatar picker, opened from the sidebar's own profile button.
// Lists whatever an admin has dropped into Jellio's own avatars folder
// (runtime/api.js's own getAvatarPresets, Controllers/AvatarsController.cs)
// and sets the chosen one as the signed in user's real avatar via the
// same POST /Users/{id}/Images/Primary flow the stock profile page's own
// file upload already uses.
import { getAvatarPresets, getAvatarPresetUrl, setUserAvatar, setUserAvatarFromFile } from '../runtime/api.js';

const OVERLAY_ID = 'jellioAvatarPicker';

function handleKeydown(event) {
  if (event.key === 'Escape') closeAvatarPicker();
}

export async function openAvatarPicker(onChanged) {
  closeAvatarPicker();

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'jellio-avatar-picker-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Choose an avatar');
  overlay.addEventListener('click', function (event) {
    if (event.target === overlay) closeAvatarPicker();
  });
  document.addEventListener('keydown', handleKeydown);

  const panel = document.createElement('div');
  panel.className = 'jellio-avatar-picker-panel';

  const title = document.createElement('h2');
  title.className = 'jellio-avatar-picker-title';
  title.textContent = 'Choose an avatar';
  panel.appendChild(title);

  // The upload tile and any loose (ungrouped) presets share this one
  // flat grid, same shape this picker always had. A grouped preset
  // (dropped into its own real subfolder server side, see
  // AvatarsController.cs's own header) gets its own <details> section
  // instead, appended after this grid: a plain native disclosure
  // widget, no real JS state of its own needed to track open/closed.
  const grid = document.createElement('div');
  grid.className = 'jellio-avatar-picker-grid';
  panel.appendChild(grid);

  const sections = document.createElement('div');
  sections.className = 'jellio-avatar-picker-sections';
  panel.appendChild(sections);

  const status = document.createElement('p');
  status.className = 'jellio-avatar-picker-status';
  panel.appendChild(status);

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  // Real Jellyfin already accepts an uploaded user image natively (a
  // picture or an animated gif, the same real POST /Users/{id}/Images/
  // Primary preset picking already goes through), real feedback asked
  // directly for a way to reach it rather than presets only. A plain
  // hidden file input rather than a second real overlay: this same
  // tile shape (a button wrapping an img) already reads as "pick this
  // option" for every preset in this grid, the upload tile just opens
  // a native file picker instead of setting a preset id directly.
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.className = 'jellio-avatar-picker-file-input';
  fileInput.setAttribute('aria-hidden', 'true');
  fileInput.tabIndex = -1;
  panel.appendChild(fileInput);

  const uploadOption = document.createElement('button');
  uploadOption.type = 'button';
  uploadOption.className = 'jellio-avatar-picker-option jellio-avatar-picker-upload';
  uploadOption.setAttribute('aria-label', 'Upload your own picture or gif');
  const uploadIcon = document.createElement('span');
  uploadIcon.className = 'material-icons add_a_photo';
  uploadIcon.setAttribute('aria-hidden', 'true');
  uploadOption.appendChild(uploadIcon);
  const uploadLabel = document.createElement('span');
  uploadLabel.className = 'jellio-avatar-picker-upload-label';
  uploadLabel.textContent = 'Upload';
  uploadOption.appendChild(uploadLabel);
  uploadOption.addEventListener('click', function () {
    fileInput.click();
  });
  fileInput.addEventListener('change', function () {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    uploadOption.disabled = true;
    status.textContent = 'Setting avatar…';
    setUserAvatarFromFile(file)
      .then(function () {
        status.textContent = 'Avatar updated.';
        if (onChanged) onChanged();
        closeAvatarPicker();
      })
      .catch(function (err) {
        console.warn('Jellio: could not upload avatar', err);
        status.textContent = 'Could not upload that picture.';
        uploadOption.disabled = false;
      });
  });
  // Appended unconditionally, ahead of the real preset fetch below:
  // uploading a real device file has no real dependency on that fetch
  // ever succeeding at all, a server error loading presets should not
  // also take the one option that never needed them down with it.
  grid.appendChild(uploadOption);

  function buildOption(preset) {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'jellio-avatar-picker-option';
    option.setAttribute('aria-label', preset.Id);
    const img = document.createElement('img');
    img.src = getAvatarPresetUrl(preset.Id);
    img.alt = '';
    img.loading = 'lazy';
    option.appendChild(img);
    option.addEventListener('click', function () {
      option.disabled = true;
      status.textContent = 'Setting avatar…';
      setUserAvatar(preset.Id)
        .then(function () {
          status.textContent = 'Avatar updated.';
          if (onChanged) onChanged();
          closeAvatarPicker();
        })
        .catch(function (err) {
          console.warn('Jellio: could not set avatar', err);
          status.textContent = 'Could not set that avatar.';
          option.disabled = false;
        });
    });
    return option;
  }

  // One real <details> per Category, created the first time a preset in
  // it is seen rather than up front: an admin with no real grouped
  // folders at all should never see an empty section.
  const categoryGrids = new Map();
  function gridForCategory(category) {
    if (categoryGrids.has(category)) return categoryGrids.get(category);
    const details = document.createElement('details');
    details.className = 'jellio-avatar-picker-section';
    details.open = true;
    const summary = document.createElement('summary');
    summary.textContent = category;
    details.appendChild(summary);
    const categoryGrid = document.createElement('div');
    categoryGrid.className = 'jellio-avatar-picker-grid';
    details.appendChild(categoryGrid);
    sections.appendChild(details);
    categoryGrids.set(category, categoryGrid);
    return categoryGrid;
  }

  try {
    const presets = await getAvatarPresets();
    if (!presets.length) {
      status.textContent = 'No preset avatars are available on this server, upload your own instead.';
      return;
    }
    presets.forEach(function (preset) {
      const option = buildOption(preset);
      const target = preset.Category ? gridForCategory(preset.Category) : grid;
      target.appendChild(option);
    });
    if (grid.firstElementChild) grid.firstElementChild.focus();
  } catch (err) {
    console.warn('Jellio: could not load avatar presets', err);
    status.textContent = 'Could not load avatars.';
  }
}

export function closeAvatarPicker() {
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();
  document.removeEventListener('keydown', handleKeydown);
}
