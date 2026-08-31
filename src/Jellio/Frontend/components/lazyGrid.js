// Batches a real item grid's own card build/append work rather than
// doing all of it in one synchronous pass: components/card.js's own
// buildCard() builds a poster <img> (loading="lazy", so the network
// cost already only pays for what actually scrolls into view) plus a
// handful of action buttons and their own real listeners, and a
// watchlist, search result or filmography grid can carry up to a
// hundred of these. Building every one of them the instant a screen's
// own data lands is real synchronous DOM/layout cost paid up front for
// content mostly off screen, the same real class of cost Nuvio itself
// never pays since its own list only ever renders what is visible.
//
// First batch renders synchronously (a reader landing on an already
// short list should never see it trickle in one row at a time), every
// batch after that waits for a real IntersectionObserver on a sentinel
// element to report it has scrolled near, same real technique
// components/row.js and screens/library.js's own coverflow do not need
// (a row scrolls sideways with a fixed, real small item count; this is
// the one real place a vertical grid can grow large).
const BATCH_SIZE = 24;

export function appendCardsLazily(grid, items, buildCard) {
  let index = 0;

  // Appended as the grid's own last child up front, not a sibling
  // after it: grid may not even be attached to the document yet at
  // this point (several real callers build a grid, call this, then
  // append the whole thing to root right after), so a sibling insert
  // here has nowhere real to go. css/app.css's own rule for this
  // class spans it across every real grid column and gives it no real
  // height, so it never reads as an empty card-sized gap in a real
  // CSS grid the way an unstyled child of one otherwise would; every
  // batch below inserts before it rather than appending after, so it
  // always stays the grid's own last child no matter how many real
  // batches land.
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
    // No real IntersectionObserver support: appends everything rather
    // than leaving the rest of a real list permanently missing.
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
