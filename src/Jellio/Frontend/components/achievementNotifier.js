import { t, getBadgeName } from '../runtime/i18n.js';
import { getMyAchievements } from '../runtime/apiSocial.js';
import { isAuthenticated } from '../runtime/auth.js';
import { showToast } from './toast.js';
import { navigateTo } from '../runtime/router.js';

const POLL_INTERVAL_MS = 30000;

let started = false;
let knownUnlockedIds = null;

function poll() {
  getMyAchievements()
    .then(function (result) {
      const badges = result.Badges || [];
      if (knownUnlockedIds) {
        badges.forEach(function (badge) {
          if (badge.Unlocked && !knownUnlockedIds.has(badge.Id)) {
            showToast(t('badge_unlocked_toast', { name: getBadgeName(badge) }), function () {
              navigateTo('#/profile');
            });
          }
        });
      }
      knownUnlockedIds = new Set(
        badges.filter(function (badge) { return badge.Unlocked; }).map(function (badge) { return badge.Id; }),
      );
    })
    .catch(function () {
    })
    .then(function () {
      window.setTimeout(poll, POLL_INTERVAL_MS);
    });
}

export function startAchievementNotifier() {
  if (started || !isAuthenticated()) return;
  started = true;
  poll();
}
