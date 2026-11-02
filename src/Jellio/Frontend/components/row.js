import { buildCard } from './card.js';
import { attachScrollArrows } from './scrollArrows.js';
import { makeRowTitleClickable } from './rowListModal.js';
import { el } from '../runtime/dom.js';

export function buildRow(title, items, cardOptions, fetchAll) {
  if (!items || !items.length) return null;

  const section = el('section', 'jellio-row');
  const titleEl = el('h2', 'jellio-row-title', title);
  section.appendChild(titleEl);
  // fetchAll may also be an options object ({ fetchAll, fetchPage }).
  makeRowTitleClickable(titleEl, title, items, typeof fetchAll === 'function' ? { fetchAll: fetchAll } : fetchAll || {});

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
