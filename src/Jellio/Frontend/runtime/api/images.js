import { getServerAddress } from '../auth.js';

export function getImageUrl(itemId, type, options) {
  const opts = options || {};
  if (opts.tag && (opts.tag.startsWith('http://') || opts.tag.startsWith('https://'))) {
    return opts.tag;
  }
  if (typeof itemId === 'string' && (itemId.startsWith('http://') || itemId.startsWith('https://'))) {
    return itemId;
  }
  const params = new URLSearchParams();
  if (opts.tag) params.set('tag', opts.tag);
  if (opts.maxWidth) params.set('maxWidth', String(opts.maxWidth));
  if (opts.quality) params.set('quality', String(opts.quality));
  const query = params.toString();
  return (
    getServerAddress() +
    '/Items/' +
    itemId +
    '/Images/' +
    (type || 'Primary') +
    (query ? '?' + query : '')
  );
}

export function getUserImageUrl(userId, tag, options) {
  const opts = options || {};
  const params = new URLSearchParams();
  if (tag) params.set('tag', tag);
  if (opts.maxWidth) params.set('maxWidth', String(opts.maxWidth));
  const query = params.toString();
  return getServerAddress() + '/Users/' + userId + '/Images/Primary' + (query ? '?' + query : '');
}
