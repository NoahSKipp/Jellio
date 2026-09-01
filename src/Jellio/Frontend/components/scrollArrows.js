// Hover revealed prev/next scroll arrows for any horizontally
// scrolling track, factored out of components/row.js's own original
// version (real duplication otherwise: screens/detail.js's own season
// tabs and episode track had no way to reach anything scrolled past
// the visible edge either, real feedback live, the exact same real gap
// row.js already solved once). Harbor's own arrowed-scroll-row.tsx
// idea (hover reveals a control that pages the track), reimplemented
// here in vanilla JS against this project's own markup rather than
// copied.

import { el } from '../runtime/dom.js';

function buildArrow(direction, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'jellio-row-arrow jellio-row-arrow-' + direction;
  button.setAttribute('aria-label', label);
  button.tabIndex = -1;
  const icon = el('span', 'material-icons ' + (direction === 'prev' ? 'chevron_left' : 'chevron_right'));
  icon.setAttribute('aria-hidden', 'true');
  button.appendChild(icon);
  return button;
}

// A page at a time, not the whole track: 0.9 of the visible width
// keeps one item's worth of overlap so the track reads as continuing
// rather than jumping to a spot the reader has not seen the lead-in to.
function scrollByPage(track, direction) {
  track.scrollBy({ left: direction * track.clientWidth * 0.9, behavior: 'smooth' });
}

// Arrows only show when there is somewhere left to scroll in that
// direction, checked on every real scroll (native drag/swipe/wheel
// included, not only a click on the arrow itself) rather than only
// right after a click, so the track is honest about its own ends.
function updateArrowVisibility(track, prevArrow, nextArrow) {
  const maxScroll = track.scrollWidth - track.clientWidth;
  prevArrow.classList.toggle('jellio-row-arrow-visible', track.scrollLeft > 4);
  nextArrow.classList.toggle('jellio-row-arrow-visible', track.scrollLeft < maxScroll - 4);
}

// trackWrap must already be position: relative (css/app.css's own
// .jellio-row-track-wrap rule) for these arrows to anchor against it
// correctly; track is the direct scrolling child inside it.
//
// Returns a refresh() callers can invoke again after replacing track's
// own content wholesale (screens/detail.js's own real need: switching
// seasons swaps the episode track's own children for a different
// season's own, real episode count that can cross the "does this even
// need arrows" line either way, well after this function's own one
// time initial check already ran).
export function attachScrollArrows(trackWrap, track) {
  const prevArrow = buildArrow('prev', 'Scroll left');
  const nextArrow = buildArrow('next', 'Scroll right');
  prevArrow.addEventListener('click', function () {
    scrollByPage(track, -1);
  });
  nextArrow.addEventListener('click', function () {
    scrollByPage(track, 1);
  });
  trackWrap.appendChild(prevArrow);
  trackWrap.appendChild(nextArrow);

  let scrollListenerAttached = false;

  // Only worth wiring the scroll listener up at all once there is
  // something to scroll to: a track shorter than its own wrap never
  // needs an arrow, and a scroll listener on a track that can never
  // scroll would just be dead weight. Safe to call more than once,
  // the listener itself only ever attaches the one real time.
  function refresh() {
    if (track.scrollWidth > track.clientWidth + 4) {
      updateArrowVisibility(track, prevArrow, nextArrow);
      if (!scrollListenerAttached) {
        scrollListenerAttached = true;
        track.addEventListener('scroll', function () {
          updateArrowVisibility(track, prevArrow, nextArrow);
        });
      }
    } else {
      prevArrow.classList.remove('jellio-row-arrow-visible');
      nextArrow.classList.remove('jellio-row-arrow-visible');
    }
  }

  window.requestAnimationFrame(refresh);
  return refresh;
}
