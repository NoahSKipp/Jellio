import { t } from '../runtime/i18n.js';
import { el } from '../runtime/dom.js';

export function renderLoading(root, message) {
  const wrap = el('div', 'jellio-screen-loading');
  wrap.appendChild(el('div', 'jellio-screen-spinner'));
  if (message) wrap.appendChild(el('p', 'jellio-service-empty', message));
  root.appendChild(wrap);
}

export function renderRetry(root, message, onRetry, options) {
  const opts = options || {};
  root.textContent = '';
  const wrap = el('div', 'jellio-screen-retry');
  wrap.appendChild(el('p', 'jellio-service-empty', message));
  const actions = el('div', 'jellio-screen-retry-actions');
  if (onRetry) {
    const retryButton = el('button', 'jellio-detail-error-back', t('action_retry'));
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
