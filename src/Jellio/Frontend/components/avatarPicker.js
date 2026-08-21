// Preset avatar picker, opened from the sidebar's own profile button.
// Lists whatever an admin has dropped into Jellio's own avatars folder
// (runtime/api.js's own getAvatarPresets, Controllers/AvatarsController.cs)
// and sets the chosen one as the signed in user's real avatar via the
// same POST /Users/{id}/Images/Primary flow the stock profile page's own
// file upload already uses.
import { getAvatarPresets, getAvatarPresetUrl, setUserAvatar } from '../runtime/api.js';

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

  const grid = document.createElement('div');
  grid.className = 'jellio-avatar-picker-grid';
  panel.appendChild(grid);

  const status = document.createElement('p');
  status.className = 'jellio-avatar-picker-status';
  panel.appendChild(status);

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  try {
    const presets = await getAvatarPresets();
    if (!presets.length) {
      status.textContent = 'No preset avatars are available on this server.';
      return;
    }
    presets.forEach(function (preset) {
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
      grid.appendChild(option);
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
