// Badge unlock toast. Same real "don't announce the reader's own
// entire backlog on a fresh page load, only a genuinely new unlock
// during this live session" reasoning components/notifications.js's
// own header already documents, same real knownIds shape: null until
// the first real poll resolves, seeded silently from whatever is
// already unlocked at that point rather than treated as new.
import { getMyAchievements } from '../runtime/api.js';
import { isAuthenticated } from '../runtime/auth.js';
import { showToast } from './toast.js';
import { navigateTo } from '../runtime/router.js';

// A badge does not unlock the instant a title finishes, it waits on
// the real server side PlaybackStopped credit (AchievementService.cs),
// itself only ever fired once the reader's own client has actually
// reported a stop. Polled rather than pushed, same real tradeoff
// components/notifications.js's own header already explains, on a
// looser interval than that file's own 5 minutes: a badge is worth a
// more prompt real toast than a release date is.
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
            showToast('Badge unlocked: ' + badge.Name, function () {
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
      // Leave whatever was last known, same real tolerance every other
      // poll loop in this runtime already has: it tries again next tick.
    })
    .then(function () {
      window.setTimeout(poll, POLL_INTERVAL_MS);
    });
}

// Called from app.js's own sync() once a session is confirmed
// authenticated, same real reason components/notifications.js's own
// startNotifications() already waits for that too.
export function startAchievementNotifier() {
  if (started || !isAuthenticated()) return;
  started = true;
  poll();
}
