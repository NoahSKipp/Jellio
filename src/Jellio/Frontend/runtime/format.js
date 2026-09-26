// Small display formatters shared across screens/components, previously
// copy pasted byte for byte in each caller (components/heroCarousel.js and
// screens/detail.js both carried their own formatRuntime, screens/feed.js
// and screens/profile.js both carried their own formatRelativeTime).

export function formatRuntime(ticks) {
  if (!ticks) return '';
  const minutes = Math.round(ticks / 600000000);
  // A book item can carry a few stray ticks of "runtime"; never print "0m".
  if (minutes < 1) return '';
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return hours > 0 ? hours + 'h ' + mins + 'm' : mins + 'm';
}

// Reading/listening activity lines for the Feed and profile (Controllers/
// ReadingActivityController.cs): "Read 40 pages of", "Listened to 1h 5m
// of", "Finished reading", plus "Page 120 of 330" where known.
const READING_TYPES = { Book: 'book', Manga: 'manga', AudioBook: 'audiobook' };

export function isReadingActivity(entry) {
  return !!(entry && READING_TYPES[entry.ItemType]);
}

function formatListened(ticks) {
  const minutes = Math.round((ticks || 0) / 600000000);
  if (minutes < 60) return minutes + ' min';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours + 'h' + (rest ? ' ' + rest + 'm' : '');
}

export function describeReading(entry) {
  const audio = entry.ItemType === 'AudioBook';
  let lead;
  if (entry.Finished) lead = audio ? 'Finished listening to ' : 'Finished reading ';
  else if (audio) lead = entry.ListenedTicks ? 'Listened to ' + formatListened(entry.ListenedTicks) + ' of ' : 'Listened to ';
  else if (entry.PagesRead) lead = 'Read ' + entry.PagesRead + (entry.PagesRead === 1 ? ' page of ' : ' pages of ');
  else lead = 'Read ';
  let detail = '';
  if (!audio && entry.CurrentPage && entry.PageCount) {
    detail = 'Page ' + entry.CurrentPage + ' of ' + entry.PageCount;
  } else if (audio && entry.Finished && entry.ListenedTicks) {
    detail = formatListened(entry.ListenedTicks) + ' listened';
  }
  return { lead: lead, title: entry.ItemName || '', detail: detail };
}

export function formatRelativeTime(isoString) {
  const then = new Date(isoString).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return minutes + (minutes === 1 ? ' minute ago' : ' minutes ago');
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
  const days = Math.round(hours / 24);
  if (days < 30) return days + (days === 1 ? ' day ago' : ' days ago');
  const months = Math.round(days / 30);
  if (months < 12) return months + (months === 1 ? ' month ago' : ' months ago');
  const years = Math.round(months / 12);
  return years + (years === 1 ? ' year ago' : ' years ago');
}
