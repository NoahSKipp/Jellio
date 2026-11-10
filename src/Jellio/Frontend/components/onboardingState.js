import { getCurrentUserId, getCurrentUser as getSessionUser } from '../runtime/auth.js';
import { getCachedServerDisplayPreferences, saveServerDisplayPreferences } from '../runtime/api.js';

// The first-run check, kept apart so startup can run it without loading the wizard.

const STORAGE_PREFIX = 'jellio_onboarding_done_';

export function shouldShowOnboarding(userId) {
  const uid = userId || getCurrentUserId();
  if (!uid) return false;
  try {
    if (window.localStorage.getItem(STORAGE_PREFIX + uid)) {
      return false;
    }

    const hasExistingUsage = Boolean(
      window.localStorage.getItem('jellio_last_seen_changelog_' + uid) ||
      window.localStorage.getItem('jellio_last_seen_changelog_global') ||
      window.localStorage.getItem('jellio_display_language') ||
      window.localStorage.getItem('jellio_player_volume') ||
      window.localStorage.getItem('jellioPlayerSpeed') ||
      window.localStorage.getItem('jellio_player_sub_style') ||
      window.localStorage.getItem('jellio_player_autoskip') ||
      window.localStorage.getItem('jellio_reader_settings') ||
      window.localStorage.getItem('jellio_reader_study_lang') ||
      window.localStorage.getItem('jellio_audiobook_default_speed') ||
      window.localStorage.getItem('jellio_audiobook_volume') ||
      window.localStorage.getItem('jellio_motion_level') ||
      window.localStorage.getItem('jellio_buffer_seconds') ||
      window.localStorage.getItem('jellio_pip_mode') ||
      window.localStorage.getItem('jellio_up_next_countdown') ||
      window.localStorage.getItem('jellio_recent_searches') ||
      window.localStorage.getItem('jellio_home_genres')
    );

    const serverPrefs = getCachedServerDisplayPreferences();
    if (serverPrefs && serverPrefs.CustomPrefs && serverPrefs.CustomPrefs.onboarding_done === 'true') {
      try {
        window.localStorage.setItem(STORAGE_PREFIX + uid, 'true');
      } catch (_) {}
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
  try {
    window.localStorage.setItem(STORAGE_PREFIX + uid, 'true');
  } catch (err) {}
  saveServerDisplayPreferences({ onboarding_done: 'true' }).catch(function () {});
}
