import { getCurrentUserId, getCurrentUser as getSessionUser } from '../runtime/auth.js';
import { getCachedServerDisplayPreferences, saveServerDisplayPreferences } from '../runtime/api.js';
import { readString, storageReadable, writeString } from '../runtime/storage.js';

// The first-run check, kept apart so startup can run it without loading the wizard.

const STORAGE_PREFIX = 'jellio_onboarding_done_';

export function shouldShowOnboarding(userId) {
  const uid = userId || getCurrentUserId();
  if (!uid) return false;
  try {
    if (!storageReadable() || readString(STORAGE_PREFIX + uid)) {
      return false;
    }

    const hasExistingUsage = Boolean(
      readString('jellio_last_seen_changelog_' + uid) ||
      readString('jellio_last_seen_changelog_global') ||
      readString('jellio_display_language') ||
      readString('jellio_player_volume') ||
      readString('jellioPlayerSpeed') ||
      readString('jellio_player_sub_style') ||
      readString('jellio_player_autoskip') ||
      readString('jellio_reader_settings') ||
      readString('jellio_reader_study_lang') ||
      readString('jellio_audiobook_default_speed') ||
      readString('jellio_audiobook_volume') ||
      readString('jellio_motion_level') ||
      readString('jellio_buffer_seconds') ||
      readString('jellio_pip_mode') ||
      readString('jellio_up_next_countdown') ||
      readString('jellio_recent_searches') ||
      readString('jellio_home_genres')
    );

    const serverPrefs = getCachedServerDisplayPreferences();
    if (serverPrefs && serverPrefs.CustomPrefs && serverPrefs.CustomPrefs.onboarding_done === 'true') {
      writeString(STORAGE_PREFIX + uid, 'true');
      return false;
    }

    const user = getSessionUser();
    const hasPriorLogin = Boolean(user && user.LastLoginDate);
    const hasPriorActivity = Boolean(user && user.LastActivityDate && (Date.now() - new Date(user.LastActivityDate).getTime() > 30000));
    const hasServerSettings = Boolean(
      user &&
      user.Configuration &&
      (user.Configuration.AudioLanguagePreference ||
       user.Configuration.SubtitleLanguagePreference ||
       user.Configuration.SubtitleMode)
    );

    if (hasExistingUsage || hasPriorLogin || hasPriorActivity || hasServerSettings) {
      markOnboardingComplete(uid);
      return false;
    }

    return true;
  } catch (err) {
    return false;
  }
}

export function markOnboardingComplete(userId) {
  const uid = userId || getCurrentUserId();
  if (!uid) return;
  writeString(STORAGE_PREFIX + uid, 'true');
  saveServerDisplayPreferences({ onboarding_done: 'true' }).catch(function () {});
}
