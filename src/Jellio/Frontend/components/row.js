import { buildCard } from './card.js';
import { attachScrollArrows } from './scrollArrows.js';
import { makeRowTitleClickable } from './rowListModal.js';
import { el } from '../runtime/dom.js';

const HORIZONTAL_PAGE_SIZE = 24;
const SCROLL_THRESHOLD_PX = 600;

function attachInfiniteHorizontalScroll(track, initialItems, cardOptions, fetchPage, refreshArrows) {
  let nextStart = initialItems ? initialItems.length : 0;
  let loading = false;
  let done = false;

  const seenIds = new Set();
  (initialItems || []).forEach(function (it) {
    if (it && it.Id) seenIds.add(String(it.Id));
  });

  function maybeLoadMore() {
    if (loading || done) return;
    const remainingScroll = track.scrollWidth - (track.scrollLeft + track.clientWidth);
    if (remainingScroll > SCROLL_THRESHOLD_PX) return;

    loading = true;
    const start = nextStart;
    fetchPage(start, HORIZONTAL_PAGE_SIZE)
      .then(function (pageItems) {
        if (!pageItems || !pageItems.length) {
          done = true;
          return;
        }
        nextStart = start + HORIZONTAL_PAGE_SIZE;
        let added = 0;
        pageItems.forEach(function (item) {
          if (!item) return;
          const id = item.Id ? String(item.Id) : null;
          if (id && seenIds.has(id)) return;
          if (id) seenIds.add(id);
          track.appendChild(buildCard(item, cardOptions));
          added++;
        });
        if (pageItems.length < HORIZONTAL_PAGE_SIZE / 2 && added === 0) {
          done = true;
        }
        if (typeof refreshArrows === 'function') {
          refreshArrows();
        }
      })
      .catch(function (err) {
        console.warn('Jellio: could not load next page for horizontal row', err);
        done = true;
      })
      .finally(function () {
        loading = false;
      });
  }

  track.addEventListener('scroll', maybeLoadMore, { passive: true });
}

export function buildRow(title, items, cardOptions, fetchAll) {
  if (!items || !items.length) return null;

  const section = el('section', 'jellio-row');
  const titleEl = el('h2', 'jellio-row-title', title);
  section.appendChild(titleEl);
  // fetchAll may also be an options object ({ fetchAll, fetchPage }).
  const fetchOptions = typeof fetchAll === 'function' ? { fetchAll: fetchAll } : fetchAll || {};
  makeRowTitleClickable(titleEl, title, items, fetchOptions);

  const trackWrap = el('div', 'jellio-row-track-wrap');
  const track = el('div', 'jellio-row-track');
  items.forEach(function (item) {
    track.appendChild(buildCard(item, cardOptions));
  });

  trackWrap.appendChild(track);
  section.appendChild(trackWrap);
  const refreshArrows = attachScrollArrows(trackWrap, track);

  if (fetchOptions && typeof fetchOptions.fetchPage === 'function') {
    attachInfiniteHorizontalScroll(track, items, cardOptions, fetchOptions.fetchPage, refreshArrows);
  }

  return section;
}
