// Calendar: Jellio's own CalendarController, upcoming episode air dates
// and movie digital release dates for whatever is on this reader's own
// real Watchlist, grouped by real calendar date. Desktop only for now,
// components/sidebar.js's own header explains why (the mobile pill bar
// shares its own link set with the desktop rail, this one link
// deliberately does not go through that shared list).
import { getCalendarEntries, getImageUrl } from '../runtime/api.js';
import { navigateTo } from '../runtime/router.js';
import { renderLoading, renderRetry } from '../components/networkState.js';
import { describeNetworkFailure } from '../runtime/network.js';
import { el } from '../runtime/dom.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function dateKey(date) {
  return date.getFullYear() + '-' + (date.getMonth() + 1) + '-' + date.getDate();
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

// "Today"/"Tomorrow" read at a glance; anything past that names the
// real day, real weekday included since a bare "March 5" alone leaves
// a reader doing their own mental math for how far off that actually
// is, the one thing this whole screen exists to save them from doing.
function dateHeading(date) {
  const today = startOfDay(new Date());
  const target = startOfDay(date);
  const diffDays = Math.round((target - today) / DAY_MS);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays > 1 && diffDays < 7) {
    return date.toLocaleDateString(undefined, { weekday: 'long' });
  }
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

function kindLabel(entry) {
  if (entry.Kind === 'episode') {
    return entry.Detail ? 'New episode · ' + entry.Detail : 'New episode';
  }
  return 'Digital release';
}

// Reuses components/rowListModal.js's own real .jellio-row-list-item
// shape (poster thumb, title, subtitle, chevron, the same clickable row
// a "browse everything" list already renders) rather than a second row
// language just for this screen: it is already exactly this screen's
// own real content shape, one row per title.
function buildEntryRow(entry) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'jellio-row-list-item';

  const img = document.createElement('img');
  img.className = 'jellio-row-list-item-image';
  img.src = getImageUrl(entry.ItemId, 'Primary', { maxWidth: 160 });
  img.alt = '';
  img.loading = 'lazy';
  row.appendChild(img);

  const info = el('div', 'jellio-row-list-item-info');
  info.appendChild(el('div', 'jellio-row-list-item-title', entry.Name));
  info.appendChild(el('div', 'jellio-row-list-item-subtitle', kindLabel(entry)));
  row.appendChild(info);

  row.appendChild(el('span', 'material-icons jellio-row-list-item-chevron', 'chevron_right'));

  row.addEventListener('click', function () {
    navigateTo('#/item?id=' + entry.ItemId);
  });
  return row;
}

function buildDateGroup(date, entries) {
  const group = el('section', 'jellio-calendar-group');
  group.appendChild(el('h2', 'jellio-calendar-group-heading', dateHeading(date)));
  const list = el('div', 'jellio-row-list jellio-calendar-group-list');
  entries.forEach(function (entry) {
    list.appendChild(buildEntryRow(entry));
  });
  group.appendChild(list);
  return group;
}

function buildHeader() {
  const header = el('header', 'jellio-calendar-header');
  header.appendChild(el('h1', 'jellio-calendar-title', 'Calendar'));
  header.appendChild(
    el(
      'p',
      'jellio-calendar-tagline',
      'What’s coming for your Watchlist — new episodes and digital releases for whatever is already on it.',
    ),
  );
  return header;
}

export async function renderCalendar(root) {
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-calendar';
  root.appendChild(buildHeader());
  renderLoading(root);

  let entries;
  try {
    entries = await getCalendarEntries();
  } catch (err) {
    console.warn('Jellio: could not load the calendar', err);
    renderRetry(root, describeNetworkFailure('the calendar', err), function () {
      renderCalendar(root);
    });
    return;
  }

  root.textContent = '';
  root.appendChild(buildHeader());

  if (!entries.length) {
    root.appendChild(
      el(
        'p',
        'jellio-service-empty',
        'Nothing upcoming yet. Anything on your Watchlist with a known air or digital release date shows up here.',
      ),
    );
    return;
  }

  const groups = new Map();
  entries.forEach(function (entry) {
    const date = new Date(entry.Date);
    const key = dateKey(date);
    if (!groups.has(key)) groups.set(key, { date: date, entries: [] });
    groups.get(key).entries.push(entry);
  });

  const body = el('div', 'jellio-calendar-body');
  Array.from(groups.values()).forEach(function (group) {
    body.appendChild(buildDateGroup(group.date, group.entries));
  });
  root.appendChild(body);
}
