// A link to a title that anyone with an account on this server can open:
// this app's own address plus the title's page. Someone not signed in is
// asked to sign in first and then lands on it (screens/login.js).
export function buildShareUrl(item) {
  const base = window.location.origin + window.location.pathname;
  return base + '#/item?id=' + encodeURIComponent(item.Id);
}

async function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('copy failed');
}

// A link to any page of this app by its hash route.
export function buildHashUrl(hash) {
  return window.location.origin + window.location.pathname + hash;
}

// Copies the link (and offers the phone's share sheet where there is one).
// Resolves to 'shared', 'copied' or 'cancelled'.
export function shareItem(item) {
  const title = item.Type === 'Episode' && item.SeriesName ? item.SeriesName + ' · ' + item.Name : item.Name || 'Jellio';
  return shareUrl(title, buildShareUrl(item));
}

export function shareHash(title, hash) {
  return shareUrl(title, buildHashUrl(hash));
}

async function shareUrl(title, url) {
  if (navigator.share && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    try {
      await navigator.share({ title: title, url: url });
      return 'shared';
    } catch (err) {
      if (err && err.name === 'AbortError') return 'cancelled';
    }
  }
  await copyText(url);
  return 'copied';
}
