
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

function scrollByPage(track, direction) {
  track.scrollBy({ left: direction * track.clientWidth * 0.9, behavior: 'smooth' });
}

function updateArrowVisibility(scrollLeft, maxScroll, prevArrow, nextArrow) {
  prevArrow.classList.toggle('jellio-row-arrow-visible', scrollLeft > 4);
  nextArrow.classList.toggle('jellio-row-arrow-visible', scrollLeft < maxScroll - 4);
}

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

  track.addEventListener(
    'wheel',
    function (event) {
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        const canScrollLeft = track.scrollLeft > 0 && event.deltaY < 0;
        const canScrollRight = track.scrollLeft < track.scrollWidth - track.clientWidth - 1 && event.deltaY > 0;
        if (canScrollLeft || canScrollRight) {
          event.preventDefault();
          track.scrollLeft += event.deltaY;
        }
      }
    },
    { passive: false },
  );

  let scrollListenerAttached = false;
  // Measured in refresh (first frame, resizes, callers adding content), not
  // on every scroll event.
  let maxScroll = 0;
  let scrollFrame = 0;

  function onScrollFrame() {
    scrollFrame = 0;
    const scrollLeft = track.scrollLeft;
    // Content may have grown since the last measure: check again at the end.
    if (scrollLeft >= maxScroll - 4) maxScroll = track.scrollWidth - track.clientWidth;
    updateArrowVisibility(scrollLeft, maxScroll, prevArrow, nextArrow);
  }

  function refresh() {
    maxScroll = track.scrollWidth - track.clientWidth;
    if (maxScroll > 4) {
      updateArrowVisibility(track.scrollLeft, maxScroll, prevArrow, nextArrow);
      if (!scrollListenerAttached) {
        scrollListenerAttached = true;
        track.addEventListener(
          'scroll',
          function () {
            if (!scrollFrame) scrollFrame = window.requestAnimationFrame(onScrollFrame);
          },
          { passive: true },
        );
      }
    } else {
      prevArrow.classList.remove('jellio-row-arrow-visible');
      nextArrow.classList.remove('jellio-row-arrow-visible');
    }
  }

  window.requestAnimationFrame(refresh);

  if (typeof ResizeObserver !== 'undefined') {
    let resizeTimer = null;
    const observer = new ResizeObserver(function () {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(refresh, 150);
    });
    observer.observe(trackWrap);
  }

  return refresh;
}
