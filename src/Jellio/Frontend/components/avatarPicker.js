import { t } from '../runtime/i18n.js';
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
  overlay.setAttribute('aria-label', t('avatar_choose'));
  overlay.addEventListener('click', function (event) {
    if (event.target === overlay) closeAvatarPicker();
  });
  document.addEventListener('keydown', handleKeydown);

  const panel = document.createElement('div');
  panel.className = 'jellio-avatar-picker-panel';

  const title = document.createElement('h2');
  title.className = 'jellio-avatar-picker-title';
  title.textContent = t('avatar_choose');
  panel.appendChild(title);

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
  uploadOption.setAttribute('aria-label', t('avatar_upload_prompt'));
  const uploadIcon = document.createElement('span');
  uploadIcon.className = 'material-icons add_a_photo';
  uploadIcon.setAttribute('aria-hidden', 'true');
  uploadOption.appendChild(uploadIcon);
  const uploadLabel = document.createElement('span');
  uploadLabel.className = 'jellio-avatar-picker-upload-label';
  uploadLabel.textContent = t('avatar_upload_btn');
  uploadOption.appendChild(uploadLabel);
  uploadOption.addEventListener('click', function () {
    fileInput.click();
  });
  fileInput.addEventListener('change', function () {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    uploadOption.disabled = true;
    status.textContent = t('avatar_setting');
    setUserAvatarFromFile(file)
      .then(function () {
        status.textContent = t('avatar_updated');
        if (onChanged) onChanged();
        closeAvatarPicker();
      })
      .catch(function (err) {
        console.warn('Jellio: could not upload avatar', err);
        status.textContent = t('avatar_upload_error');
        uploadOption.disabled = false;
      });
  });
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
      status.textContent = t('avatar_setting');
      setUserAvatar(preset.Id)
        .then(function () {
          status.textContent = t('avatar_updated');
          if (onChanged) onChanged();
          closeAvatarPicker();
        })
        .catch(function (err) {
          console.warn('Jellio: could not set avatar', err);
          status.textContent = t('avatar_load_error');
          option.disabled = false;
        });
    });
    return option;
  }

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
      status.textContent = t('avatar_no_presets');
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
    status.textContent = t('avatar_load_error');
  }
}

function closeAvatarPicker() {
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();
  document.removeEventListener('keydown', handleKeydown);
}
