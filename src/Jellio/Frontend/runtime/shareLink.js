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

export function shareItemLabel(item) {
  if (!item) return '';
  if (item.Type === 'Episode') {
    const series = item.SeriesName || '';
    const hasSeason = item.ParentIndexNumber != null && item.ParentIndexNumber !== '';
    const hasEpisode = item.IndexNumber != null && item.IndexNumber !== '';
    if (series && hasSeason && hasEpisode) {
      const seasonPart = Number(item.ParentIndexNumber) === 0 ? 'Specials' : 'Season ' + item.ParentIndexNumber;
      return series + ' - ' + seasonPart + ' Episode ' + item.IndexNumber;
    }
    if (series && hasEpisode) {
      return series + ' - Episode ' + item.IndexNumber;
    }
    if (series && item.Name) {
      return series + ' - ' + item.Name;
    }
    if (hasSeason && hasEpisode) {
      const seasonPart = Number(item.ParentIndexNumber) === 0 ? 'Specials' : 'Season ' + item.ParentIndexNumber;
      return seasonPart + ' Episode ' + item.IndexNumber;
    }
    return item.Name || series || 'Episode';
  }
  if (item.Type === 'Season') {
    const series = item.SeriesName || '';
    const hasSeason = item.IndexNumber != null && item.IndexNumber !== '';
    if (series && hasSeason) {
      const seasonPart = Number(item.IndexNumber) === 0 ? 'Specials' : 'Season ' + item.IndexNumber;
      return series + ' - ' + seasonPart;
    }
    return item.Name || (series ? series + ' Season' : 'Season');
  }
  return item.Name || '';
}

export function formatShareText(label, url) {
  if (label) {
    return 'Look at ' + label + ' on Jellyfin - ' + url;
  }
  return url;
}

// Copies the link (and offers the phone's share sheet where there is one).
// Resolves to 'shared', 'copied' or 'cancelled'.
export function shareItem(item) {
  const label = shareItemLabel(item);
  const url = buildShareUrl(item);
  const text = formatShareText(label, url);
  return shareUrl(label, url, text);
}

export function shareHash(title, hash) {
  const url = buildHashUrl(hash);
  const text = formatShareText(title, url);
  return shareUrl(title, url, text);
}

async function shareUrl(title, url, text) {
  const shareText = text || formatShareText(title, url);
  if (navigator.share && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    try {
      await navigator.share({
        title: title || 'Jellio',
        text: 'Look at ' + (title || 'this') + ' on Jellyfin',
        url: url,
      });
      return 'shared';
    } catch (err) {
      if (err && err.name === 'AbortError') return 'cancelled';
    }
  }
  await copyText(shareText);
  return 'copied';
}
