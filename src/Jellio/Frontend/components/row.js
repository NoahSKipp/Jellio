// One card row, shared by screens/home.js and screens/library.js
// (previously identical copies in both, real duplication rather than
// two rows that happen to look alike). Adds hover revealed scroll
// arrows on top of what both already had, real feedback asked for
// more animation "where it fits", and a horizontally scrolling row
// with no visible way to move it except a mouse drag or a trackpad
// swipe was the plainest gap: Harbor's own arrowed-scroll-row.tsx uses
// the same idea (hover reveals a prev/next control that pages the
// track), reimplemented here in vanilla JS against this project's own
// markup rather than copied.
import { buildCard } from './card.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

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
// keeps one card's worth of overlap so the row reads as continuing
// rather than jumping to a spot the reader has not seen the lead-in
// to.
function scrollByPage(track, direction) {
  track.scrollBy({ left: direction * track.clientWidth * 0.9, behavior: 'smooth' });
}

// Arrows only show when there is somewhere left to scroll in that
// direction, checked on every real scroll (native drag/swipe/wheel
// included, not only this file's own button clicks) rather than only
// right after a click, so the row is honest about its own ends.
function updateArrowVisibility(track, prevArrow, nextArrow) {
  const maxScroll = track.scrollWidth - track.clientWidth;
  prevArrow.classList.toggle('jellio-row-arrow-visible', track.scrollLeft > 4);
  nextArrow.classList.toggle('jellio-row-arrow-visible', track.scrollLeft < maxScroll - 4);
}

export function buildRow(title, items, cardOptions) {
  if (!items || !items.length) return null;

  const section = el('section', 'jellio-row');
  section.appendChild(el('h2', 'jellio-row-title', title));

  const trackWrap = el('div', 'jellio-row-track-wrap');
  const track = el('div', 'jellio-row-track');
  items.forEach(function (item) {
    track.appendChild(buildCard(item, cardOptions));
  });

  const prevArrow = buildArrow('prev', 'Scroll left');
  const nextArrow = buildArrow('next', 'Scroll right');
  prevArrow.addEventListener('click', function () {
    scrollByPage(track, -1);
  });
  nextArrow.addEventListener('click', function () {
    scrollByPage(track, 1);
  });

  trackWrap.appendChild(track);
  trackWrap.appendChild(prevArrow);
  trackWrap.appendChild(nextArrow);
  section.appendChild(trackWrap);

  // Only worth wiring up at all once there is something to scroll
  // to: a row shorter than its own track never needs an arrow, and a
  // scroll listener on a track that can never scroll would just be
  // dead weight.
  window.requestAnimationFrame(function () {
    if (track.scrollWidth > track.clientWidth + 4) {
      updateArrowVisibility(track, prevArrow, nextArrow);
      track.addEventListener('scroll', function () {
        updateArrowVisibility(track, prevArrow, nextArrow);
      });
    }
  });

  return section;
}
