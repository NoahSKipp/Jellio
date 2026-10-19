// Up Next countdown length, a client only display preference.
const COUNTDOWN_KEY = 'jellioUpNextCountdownSeconds';
export const DEFAULT_COUNTDOWN_SECONDS = 15;

export const UPNEXT_COUNTDOWN_OPTIONS = [
  { value: '0', label: 'Off (Do not auto-advance)' },
  { value: '5', label: '5 seconds' },
  { value: '10', label: '10 seconds' },
  { value: '15', label: '15 seconds (default)' },
  { value: '30', label: '30 seconds' },
  { value: '45', label: '45 seconds' },
  { value: '60', label: '1 minute' },
];

export function getUpNextCountdownSeconds() {
  try {
    const raw = window.localStorage.getItem(COUNTDOWN_KEY);
    if (raw === null || raw === undefined) return DEFAULT_COUNTDOWN_SECONDS;
    const parsed = Number(raw);
    return UPNEXT_COUNTDOWN_OPTIONS.some((option) => Number(option.value) === parsed) ? parsed : DEFAULT_COUNTDOWN_SECONDS;
  } catch (err) {
    return DEFAULT_COUNTDOWN_SECONDS;
  }
}

export function setUpNextCountdownSeconds(seconds) {
  try {
    window.localStorage.setItem(COUNTDOWN_KEY, String(seconds));
  } catch (err) {
    // Not persisted, this tab still uses the chosen value until reload.
  }
}
