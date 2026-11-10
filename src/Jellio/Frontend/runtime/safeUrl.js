// URLs that come from server data go through these before they reach an
// href or a CSS url(), so a javascript: link or a stray quote cannot run
// script or break out of the declaration.

export function safeExternalUrl(url) {
  if (typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!trimmed) return '';
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (err) {
    return '';
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : '';
}

// A quoted CSS url() value with quotes, backslashes and line breaks escaped.
export function cssUrl(url) {
  const value = String(url == null ? '' : url)
    .replace(/[\\"]/g, '\\$&')
    .replace(/[\n\r\f]/g, function (ch) {
      return '\\' + ch.charCodeAt(0).toString(16) + ' ';
    });
  return 'url("' + value + '")';
}
