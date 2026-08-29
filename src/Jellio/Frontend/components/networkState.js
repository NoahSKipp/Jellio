// The gap Nuvio's own instant-navigation-plus-retry model covers and
// this runtime's own screens did not: every screen used to clear root
// and then await its own data with nothing shown in between, real bug
// on a slow or flaky connection (a hotel wifi, one real case reported
// live) where a card tap read as doing nothing at all rather than
// working. renderLoading() fills that gap the instant a screen starts
// fetching; renderRetry() replaces a screen's own dead "Back only" exit
// with a real retry action, same shape as Nuvio's own
// NetworkOfflineCard's Retry button, confirmed against its real source
// before writing this.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// message is optional: screens/detail.js's own polling wait for a
// title Gelato is still importing for the first time is the one real
// caller so far with something worth telling the reader while this
// spinner is already up, every other call site still just wants the
// bare spinner it always had.
export function renderLoading(root, message) {
  const wrap = el('div', 'jellio-screen-loading');
  wrap.appendChild(el('div', 'jellio-screen-spinner'));
  if (message) wrap.appendChild(el('p', 'jellio-service-empty', message));
  root.appendChild(wrap);
}

// onRetry is left out for a failure retrying cannot help (a route
// reached with no id/param at all still has no id/param the second
// time): both screens pass null there rather than a button that just
// repeats the exact same dead end. onBack is optional the same way,
// only offered when there is somewhere real to go back to.
export function renderRetry(root, message, onRetry, options) {
  const opts = options || {};
  root.textContent = '';
  const wrap = el('div', 'jellio-screen-retry');
  wrap.appendChild(el('p', 'jellio-service-empty', message));
  const actions = el('div', 'jellio-screen-retry-actions');
  if (onRetry) {
    const retryButton = el('button', 'jellio-detail-error-back', 'Retry');
    retryButton.type = 'button';
    retryButton.addEventListener('click', onRetry);
    actions.appendChild(retryButton);
  }
  if (opts.onBack) {
    const backButton = el('button', 'jellio-detail-error-back', opts.backLabel || 'Back');
    backButton.type = 'button';
    backButton.addEventListener('click', opts.onBack);
    actions.appendChild(backButton);
  }
  wrap.appendChild(actions);
  root.appendChild(wrap);
}
