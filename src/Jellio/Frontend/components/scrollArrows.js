
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

function updateArrowVisibility(track, prevArrow, nextArrow) {
  const maxScroll = track.scrollWidth - track.clientWidth;
  prevArrow.classList.toggle('jellio-row-arrow-visible', track.scrollLeft > 4);
  nextArrow.classList.toggle('jellio-row-arrow-visible', track.scrollLeft < maxScroll - 4);
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
