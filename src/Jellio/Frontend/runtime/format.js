import { t } from './i18n.js';

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
  if (entry.Finished) {
    lead = audio ? t('format_finished_listening') : t('format_finished_reading');
  } else if (audio) {
    lead = entry.ListenedTicks ? t('format_listened_to_time', { time: formatListened(entry.ListenedTicks) }) : t('format_listened_to');
  } else if (entry.PagesRead) {
    lead = t('format_read_pages', { count: entry.PagesRead });
  } else {
    lead = t('format_read');
  }
  let detail = '';
  if (!audio && entry.CurrentPage && entry.PageCount) {
    detail = t('format_page_of', { current: entry.CurrentPage, total: entry.PageCount });
  } else if (audio && entry.Finished && entry.ListenedTicks) {
    detail = t('format_listened_time', { time: formatListened(entry.ListenedTicks) });
  }
  // Time spent in the reader, once it's at least a minute.
  if (!audio && entry.ListenedTicks >= 600000000) {
    detail = (detail ? detail + ' · ' : '') + t('format_reading_time', { time: formatListened(entry.ListenedTicks) });
  }
  // A manga chapter names its series too: "Chapter 5" of "Berserk".
  const series = entry.SeriesName && entry.SeriesName !== entry.ItemName ? entry.SeriesName : '';
  return { lead: lead, title: entry.ItemName || '', series: series, detail: detail };
}

export function formatRelativeTime(isoString) {
  const then = new Date(isoString).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return t('time_just_now');
  if (minutes < 60) return t('time_minutes_ago', { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('time_hours_ago', { count: hours });
  const days = Math.round(hours / 24);
  if (days < 30) return t('time_days_ago', { count: days });
  const months = Math.round(days / 30);
  if (months < 12) return t('time_months_ago', { count: months });
  const years = Math.round(months / 12);
  return t('time_years_ago', { count: years });
}
