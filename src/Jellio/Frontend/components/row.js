// One card row, shared by screens/home.js and screens/library.js
// (previously identical copies in both, real duplication rather than
// two rows that happen to look alike). Hover revealed scroll arrows,
// components/scrollArrows.js's own shared attachScrollArrows() (real
// feedback asked for more animation "where it fits", a horizontally
// scrolling row with no visible way to move it except a mouse drag or
// a trackpad swipe was the plainest gap), also reused now by
// screens/detail.js's own season tabs and episode track, the same real
// gap this file solved once already.
import { buildCard } from './card.js';
import { attachScrollArrows } from './scrollArrows.js';
import { makeRowTitleClickable } from './rowListModal.js';
import { el } from '../runtime/dom.js';

// fetchAll: optional, a real unbounded (or much larger) refetch of this
// exact same row for makeRowTitleClickable's own list modal to swap in,
// real feedback was that "browse everything" only ever showed whichever
// short list the row itself had already loaded. Omitted for a row with
// no real single query behind it to widen (Continue Watching, Up Next,
// a computed recommendation row), the modal just keeps showing what is
// already loaded for those, nothing to fetch more of.
export function buildRow(title, items, cardOptions, fetchAll) {
  if (!items || !items.length) return null;

  const section = el('section', 'jellio-row');
  const titleEl = el('h2', 'jellio-row-title', title);
  section.appendChild(titleEl);
  makeRowTitleClickable(titleEl, title, items, { fetchAll: fetchAll });

  const trackWrap = el('div', 'jellio-row-track-wrap');
  const track = el('div', 'jellio-row-track');
  items.forEach(function (item) {
    track.appendChild(buildCard(item, cardOptions));
  });

  trackWrap.appendChild(track);
  section.appendChild(trackWrap);
  attachScrollArrows(trackWrap, track);

  return section;
}
