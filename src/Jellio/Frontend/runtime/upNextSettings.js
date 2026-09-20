// How long before an episode's real end the Up Next card shows,
// client only, same reasoning components/streamPicker.js's own
// REMEMBER_ENABLED_KEY already uses: a real per-reader display
// preference, not a server side account setting Jellyfin has any
// concept of. Only used as a fallback trigger (screens/player.js's own
// shouldShowUpNextNow prefers a real Intro Skipper Credits segment
// outright whenever one exists), but real feedback was that even the
// fallback's own old default, 2 real minutes before the end, showed
// the card noticeably before the episode was actually winding down on
// most real content, cutting the reader's own UPNEXT_COUNTDOWN_SECONDS
// window short of real content still worth watching. Default lowered
// to 45s (closer to a typical end card's own real length) and left
// adjustable here for readers whose own library skews toward either
// longer or shorter real outros than that.
const TRIGGER_KEY = 'jellioUpNextTriggerSeconds';
const DEFAULT_TRIGGER_SECONDS = 45;

export const UPNEXT_TRIGGER_OPTIONS = [
  { value: '20', label: '20 seconds before the end' },
  { value: '30', label: '30 seconds before the end' },
  { value: '45', label: '45 seconds before the end (default)' },
  { value: '60', label: '1 minute before the end' },
  { value: '90', label: '1.5 minutes before the end' },
  { value: '120', label: '2 minutes before the end' },
];

export function getUpNextTriggerSeconds() {
  try {
    const raw = window.localStorage.getItem(TRIGGER_KEY);
    const parsed = raw ? Number(raw) : NaN;
    return UPNEXT_TRIGGER_OPTIONS.some((option) => Number(option.value) === parsed) ? parsed : DEFAULT_TRIGGER_SECONDS;
  } catch (err) {
    return DEFAULT_TRIGGER_SECONDS;
  }
}

export function setUpNextTriggerSeconds(seconds) {
  try {
    window.localStorage.setItem(TRIGGER_KEY, String(seconds));
  } catch (err) {
    // Not persisted, this tab still uses the chosen value until reload.
  }
}
