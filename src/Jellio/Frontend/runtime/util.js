import { getServerAddress, getAccessToken } from './auth.js';

export function idKey(id) {
  return String(id || '').replace(/-/g, '').toLowerCase();
}

export function jellioVersion() {
  const script = document.querySelector('script[src*="/Jellio/frontend/app.js"]');
  if (!script) return '';
  try {
    return new URL(script.src, window.location.origin).searchParams.get('v') || '';
  } catch (err) {
    return '';
  }
}

// Folds "The Hobbit: Vol. 2" and "hobbit" together for matching.
export function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[,:;(\[].*$/, '')
    .replace(/\s+vol(ume)?\.?\s*\d+.*$/, '')
    .replace(/^(the|a|an)\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Jellio's own cover endpoints need the token on the URL for <img>.
export function coverSrc(url) {
  if (!url) return '';
  if (url.indexOf('/Jellio/') !== 0) return url;
  return getServerAddress() + url + '&ApiKey=' + encodeURIComponent(getAccessToken() || '');
}
