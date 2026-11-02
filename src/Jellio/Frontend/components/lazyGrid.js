const BATCH_SIZE = 24;

export function appendCardsLazily(grid, items, buildCard) {
  let index = 0;

  const sentinel = document.createElement('div');
  sentinel.className = 'jellio-lazy-grid-sentinel';
  grid.appendChild(sentinel);

  function appendBatch() {
    const end = Math.min(index + BATCH_SIZE, items.length);
    for (; index < end; index++) {
      grid.insertBefore(buildCard(items[index]), sentinel);
    }
  }

  appendBatch();
  if (index >= items.length) {
    sentinel.remove();
    return;
  }

  if (typeof IntersectionObserver !== 'function') {
    while (index < items.length) appendBatch();
    sentinel.remove();
    return;
  }

  const observer = new IntersectionObserver(function (entries) {
    if (!entries.some(function (entry) { return entry.isIntersecting; })) return;
    appendBatch();
    if (index >= items.length) {
      observer.disconnect();
      sentinel.remove();
    }
  }, { rootMargin: '600px 0px' });
  observer.observe(sentinel);
}
