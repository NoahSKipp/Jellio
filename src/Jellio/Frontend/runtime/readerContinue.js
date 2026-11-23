// What a reader took out of their Continue rows or their library, shared by
// the home rows and the shelves. The server keeps it in the shelf: a book
// off their shelf is "i:<id>" in LibraryRemoved, a manga series taken out of
// Continue reading carries ContinueDismissedAt in its series prefs.

// What is stored when a series is removed: the time it was last read, so
// reading it again brings it back; "-" when it had never been read.
export function dismissalMarker(lastReadAt) {
  return lastReadAt ? String(lastReadAt) : '-';
}

export function isContinueDismissed(seriesPrefs, shelfKey, lastReadAt) {
  const prefs = seriesPrefs && seriesPrefs[shelfKey];
  const stored = prefs && prefs.ContinueDismissedAt;
  return !!stored && stored === dismissalMarker(lastReadAt);
}

// Drops from a Continue reading or listening list the books the reader
// removed from their library and the manga chapters of a series they
// removed or dismissed. seriesKeyOf gives a chapter's series shelf key
// ("s:...") or '' for a book. A chapter list only knows the progress of
// what is on it, so a dismissal holds while the series has nothing read
// after its marker (a dismissal with no marker holds for none).
export function withoutHiddenContinue(items, shelf, seriesKeyOf, itemKeyOf) {
  const removed = new Set((shelf && shelf.LibraryRemoved) || []);
  const prefs = (shelf && shelf.Series) || {};
  const newest = new Map();
  const seriesOf = new Map();
  items.forEach(function (item) {
    const seriesKey = seriesKeyOf(item);
    if (!seriesKey) return;
    seriesOf.set(item, seriesKey);
    const at = Date.parse(item.JellioUpdatedAt) || 0;
    newest.set(seriesKey, Math.max(newest.get(seriesKey) || 0, at));
  });
  return items.filter(function (item) {
    if (removed.has(itemKeyOf(item))) return false;
    const seriesKey = seriesOf.get(item);
    if (!seriesKey) return true;
    if (removed.has(seriesKey)) return false;
    const stored = prefs[seriesKey] && prefs[seriesKey].ContinueDismissedAt;
    if (!stored || stored === '-') return true;
    const marker = Date.parse(stored);
    return !(marker >= newest.get(seriesKey));
  });
}

// The newest of some stored read times, as it was stored (not parsed).
export function latestRead(times) {
  let best = null;
  let bestAt = -1;
  (times || []).forEach(function (time) {
    const at = Date.parse(time);
    if (time && at > bestAt) {
      best = time;
      bestAt = at;
    }
  });
  return best;
}
