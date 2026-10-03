// #/downloads: everything kept on this device (runtime/offline.js), by
// kind, with progress for what's still downloading. Also the screen
// Jellio opens on when the server can't be reached.
import {
  listDownloads,
  removeDownload,
  retryDownload,
  onDownloadsChange,
  getOfflineObjectUrl,
  storageEstimate,
  isOffline,
  checkServer,
  timeLeftSeconds,
  isAutoDeleteWatchedEnabled,
  setAutoDeleteWatchedEnabled,
  isAutoDeleteReadEnabled,
  setAutoDeleteReadEnabled,
} from '../runtime/offline.js';
import { formatBytes, formatTimeLeft } from '../components/downloads.js';
import { navigateTo, setTitle } from '../runtime/router.js';
import { el } from '../runtime/dom.js';

const SECTIONS = [
  { kind: 'book', title: 'Books', icon: 'auto_stories' },
  { kind: 'manga', title: 'Manga', icon: 'collections_bookmark' },
  { kind: 'audiobook', title: 'Audiobooks', icon: 'headphones' },
  { kind: 'video', title: 'Movies & TV', icon: 'movie' },
];

function openHash(record) {
  if (record.Kind === 'audiobook') return '#/listen?id=' + record.Item.Id;
  if (record.Kind === 'video') return '#/play?id=' + record.Item.Id + '&local=1';
  return '#/read?id=' + record.Item.Id;
}

function statusLine(record) {
  if (record.Status === 'done') {
    return formatBytes(record.TotalBytes) + (record.AudioLanguage ? ' · ' + record.AudioLanguage + ' audio' : '');
  }
  if (record.Status === 'downloading' && record.Error) return record.Error;
  if (record.Status === 'downloading' && !record.DoneBytes && record.Kind === 'video') {
    return 'Waiting for Jellyfin to start the video…';
  }
  if (record.Status === 'error') return 'Failed: ' + (record.Error || 'unknown error');
  if (record.Status === 'queued' && record.Waiting) return record.Waiting;
  if (record.Status === 'queued') return isOffline() ? 'Waiting for the server' : 'Waiting to download';
  const total = record.TotalBytes || record.EstimatedBytes;
  const left = formatTimeLeft(timeLeftSeconds(record));
  return total
    ? 'Downloading ' + formatBytes(record.DoneBytes) + ' of ' + (record.TotalBytes ? '' : '~') + formatBytes(total) + (left ? ' · ' + left : '')
    : 'Downloading · ' + formatBytes(record.DoneBytes);
}

export function renderDownloads(root) {
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-downloads';
  setTitle('Downloads - Jellio');
  const objectUrls = [];
  let cancelled = false;

  const header = el('header', 'jellio-library-header jellio-downloads-header');
  header.appendChild(el('h1', 'jellio-library-title', 'Downloads'));
  const summary = el('p', 'jellio-bookshelf-stats');
  header.appendChild(summary);
  root.appendChild(header);

  const banner = el('div', 'jellio-downloads-offline');
  root.appendChild(banner);
  function paintBanner() {
    banner.textContent = '';
    banner.hidden = !isOffline();
    if (!isOffline()) return;
    banner.appendChild(el('span', 'material-icons cloud_off'));
    banner.appendChild(el('span', null, 'The server can’t be reached. Your downloads still work, and progress syncs when it’s back.'));
    const retry = el('button', 'jellio-downloads-retry', 'Try again');
    retry.type = 'button';
    retry.addEventListener('click', function () {
      retry.disabled = true;
      checkServer().finally(() => {
        retry.disabled = false;
      });
    });
    banner.appendChild(retry);
  }
  paintBanner();
  function onConnectivity() {
    paintBanner();
  }
  document.addEventListener('jellio:connectivity', onConnectivity);

  const body = el('div', 'jellio-downloads-body');
  root.appendChild(body);

  // Collapsed manga series and TV shows, remembered across repaints.
  const expanded = new Set();

  function cover(record, className) {
    const box = el('div', className || 'jellio-downloads-cover');
    box.appendChild(el('span', 'material-icons ' + (SECTIONS.find((section) => section.kind === record.Kind) || SECTIONS[0]).icon));
    const name = record.Kind === 'manga' ? 'seriescover' : 'cover';
    getOfflineObjectUrl(record.Id, name)
      .then((url) => url || (name !== 'cover' ? getOfflineObjectUrl(record.Id, 'cover') : null))
      .then(function (url) {
        if (!url || cancelled) return;
        objectUrls.push(url);
        const img = document.createElement('img');
        img.src = url;
        img.alt = '';
        box.textContent = '';
        box.appendChild(img);
      });
    return box;
  }

  function row(record) {
    const item = el('div', 'jellio-downloads-row jellio-downloads-' + record.Status);
    const open = el('button', 'jellio-downloads-open');
    open.type = 'button';
    open.disabled = record.Status !== 'done';
    open.appendChild(cover(record));
    const text = el('div', 'jellio-downloads-text');
    text.appendChild(el('span', 'jellio-downloads-title', record.Title));
    if (record.Subtitle) text.appendChild(el('span', 'jellio-downloads-subtitle', record.Subtitle));
    text.appendChild(el('span', 'jellio-downloads-status', statusLine(record)));
    if (record.LanguageNote) text.appendChild(el('span', 'jellio-downloads-subtitle', record.LanguageNote));
    if (record.Status === 'downloading') {
      const bar = el('div', 'jellio-downloads-bar');
      const fill = el('div', 'jellio-downloads-bar-fill');
      const total = record.TotalBytes || record.EstimatedBytes;
      fill.style.width = total ? Math.min(100, (record.DoneBytes / total) * 100) + '%' : '30%';
      if (!total) bar.classList.add('jellio-downloads-bar-indeterminate');
      bar.appendChild(fill);
      text.appendChild(bar);
    }
    open.appendChild(text);
    open.addEventListener('click', function () {
      navigateTo(openHash(record));
    });
    item.appendChild(open);

    const actions = el('div', 'jellio-downloads-actions');
    if (record.Status === 'error') {
      const retry = el('button', 'jellio-downloads-action');
      retry.type = 'button';
      retry.setAttribute('aria-label', 'Try again');
      retry.appendChild(el('span', 'material-icons refresh'));
      retry.addEventListener('click', () => retryDownload(record.Id));
      actions.appendChild(retry);
    }
    const remove = el('button', 'jellio-downloads-action');
    remove.type = 'button';
    remove.setAttribute('aria-label', record.Status === 'done' ? 'Remove download' : 'Cancel download');
    remove.appendChild(el('span', 'material-icons ' + (record.Status === 'done' ? 'delete_outline' : 'close')));
    remove.addEventListener('click', function () {
      if (record.Status === 'done' && !window.confirm('Remove “' + record.Title + '” from this device?')) return;
      removeDownload(record.Id);
    });
    actions.appendChild(remove);
    item.appendChild(actions);
    return item;
  }

  // A manga series or TV show: one line that opens into its downloads.
  function group(title, records) {
    const wrap = el('div', 'jellio-downloads-group');
    const key = records[0].Kind + ':' + (records[0].GroupKey || title);
    const toggle = el('button', 'jellio-downloads-group-head');
    toggle.type = 'button';
    const first = records[0];
    toggle.appendChild(cover(Object.assign({}, first, { Kind: first.Kind }), 'jellio-downloads-cover'));
    const text = el('div', 'jellio-downloads-text');
    text.appendChild(el('span', 'jellio-downloads-title', title));
    const bytes = records.reduce((sum, record) => sum + (record.TotalBytes || record.DoneBytes || 0), 0);
    const busy = records.filter((record) => record.Status !== 'done').length;
    const unit = first.Kind === 'manga' ? (records.length === 1 ? 'chapter' : 'chapters') : records.length === 1 ? 'episode' : 'episodes';
    text.appendChild(
      el('span', 'jellio-downloads-status', records.length + ' ' + unit + ' · ' + formatBytes(bytes) + (busy ? ' · ' + busy + ' downloading' : '')),
    );
    toggle.appendChild(text);
    toggle.appendChild(el('span', 'material-icons ' + (expanded.has(key) ? 'expand_less' : 'expand_more')));
    toggle.addEventListener('click', function () {
      if (expanded.has(key)) expanded.delete(key);
      else expanded.add(key);
      paint();
    });
    const head = el('div', 'jellio-downloads-group-bar');
    head.appendChild(toggle);
    // The whole series or show at once.
    const removeAll = el('button', 'jellio-downloads-action');
    removeAll.type = 'button';
    removeAll.setAttribute('aria-label', 'Remove all of ' + title);
    removeAll.title = 'Remove all';
    removeAll.appendChild(el('span', 'material-icons delete_sweep'));
    removeAll.addEventListener('click', async function () {
      if (!window.confirm('Remove all ' + records.length + ' ' + unit + ' of “' + title + '” from this device?')) return;
      removeAll.disabled = true;
      for (const record of records) {
        await removeDownload(record.Id).catch((err) => console.warn('Jellio: could not remove a download', err));
      }
    });
    head.appendChild(removeAll);
    wrap.appendChild(head);
    if (expanded.has(key)) {
      const list = el('div', 'jellio-downloads-group-list');
      records
        .slice()
        .sort((a, b) => (a.Title || '').localeCompare(b.Title || '', undefined, { numeric: true }))
        .forEach((record) => list.appendChild(row(record)));
      wrap.appendChild(list);
    }
    return wrap;
  }

  let painting = false;
  let again = false;
  async function paint() {
    if (painting) {
      again = true;
      return;
    }
    painting = true;
    try {
      const [records, estimate] = await Promise.all([listDownloads().catch(() => []), storageEstimate()]);
      if (cancelled) return;
      objectUrls.splice(0).forEach((url) => URL.revokeObjectURL(url));
      body.textContent = '';
      const byKind = {
        video: 0,
        manga: 0,
        audiobook: 0,
        book: 0,
      };
      records.forEach(function (record) {
        const bytes = record.TotalBytes || record.DoneBytes || 0;
        if (byKind[record.Kind] != null) {
          byKind[record.Kind] += bytes;
        }
      });
      const totalUsed = Object.values(byKind).reduce((a, b) => a + b, 0);
      const quota = estimate && estimate.quota ? estimate.quota : totalUsed;
      const free = estimate && estimate.quota ? Math.max(0, estimate.quota - estimate.usage) : 0;

      summary.textContent =
        records.length + (records.length === 1 ? ' download' : ' downloads') + ' · ' + formatBytes(totalUsed) +
        (estimate && estimate.quota ? ' · ' + formatBytes(free) + ' free for Jellio on this device' : '');

      const storageSection = el('div', 'jellio-downloads-storage');
      const storageBar = el('div', 'jellio-storage-bar');
      const totalCapacity = Math.max(quota, totalUsed + free, 1);
      const kinds = [
        { key: 'video', label: 'Movies & TV', color: '#a855f7', bytes: byKind.video },
        { key: 'manga', label: 'Manga', color: '#06b6d4', bytes: byKind.manga },
        { key: 'audiobook', label: 'Audiobooks', color: '#14b8a6', bytes: byKind.audiobook },
        { key: 'book', label: 'Books', color: '#f59e0b', bytes: byKind.book },
      ];
      kinds.forEach(function (k) {
        if (k.bytes > 0) {
          const seg = el('div', 'jellio-storage-segment jellio-storage-segment-' + k.key);
          seg.style.width = ((k.bytes / totalCapacity) * 100) + '%';
          seg.title = k.label + ': ' + formatBytes(k.bytes);
          storageBar.appendChild(seg);
        }
      });
      if (free > 0) {
        const freeSeg = el('div', 'jellio-storage-segment jellio-storage-segment-free');
        freeSeg.style.width = ((free / totalCapacity) * 100) + '%';
        freeSeg.title = 'Free storage: ' + formatBytes(free);
        storageBar.appendChild(freeSeg);
      }
      storageSection.appendChild(storageBar);

      const legend = el('div', 'jellio-storage-legend');
      kinds.forEach(function (k) {
        if (k.bytes > 0) {
          const item = el('div', 'jellio-storage-legend-item');
          const dot = el('span', 'jellio-storage-legend-dot');
          dot.style.backgroundColor = k.color;
          item.appendChild(dot);
          item.appendChild(el('span', 'jellio-storage-legend-label', k.label));
          item.appendChild(el('span', 'jellio-storage-legend-value', formatBytes(k.bytes)));
          legend.appendChild(item);
        }
      });
      if (free > 0) {
        const freeItem = el('div', 'jellio-storage-legend-item');
        const freeDot = el('span', 'jellio-storage-legend-dot jellio-storage-legend-dot-free');
        freeItem.appendChild(freeDot);
        freeItem.appendChild(el('span', 'jellio-storage-legend-label', 'Free'));
        freeItem.appendChild(el('span', 'jellio-storage-legend-value', formatBytes(free)));
        legend.appendChild(freeItem);
      }
      storageSection.appendChild(legend);

      const quickSettings = el('div', 'jellio-downloads-quick-settings');
      function buildQuickToggle(icon, title, initialValue, onToggle) {
        const row = el('label', 'jellio-downloads-quick-toggle');
        row.appendChild(el('span', 'material-icons ' + icon));
        row.appendChild(el('span', 'jellio-downloads-quick-label', title));
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'jellio-settings-checkbox';
        input.checked = initialValue;
        input.addEventListener('change', function () {
          onToggle(input.checked);
        });
        row.appendChild(input);
        return row;
      }
      quickSettings.appendChild(
        buildQuickToggle('movie', 'Delete after watching', isAutoDeleteWatchedEnabled(), function (checked) {
          setAutoDeleteWatchedEnabled(checked);
        }),
      );
      quickSettings.appendChild(
        buildQuickToggle('auto_stories', 'Delete after reading', isAutoDeleteReadEnabled(), function (checked) {
          setAutoDeleteReadEnabled(checked);
        }),
      );
      storageSection.appendChild(quickSettings);
      body.appendChild(storageSection);

      if (!records.length) {
        const empty = el('div', 'jellio-bookshelf-empty');
        empty.appendChild(el('span', 'material-icons download_for_offline'));
        empty.appendChild(el('p', null, 'Nothing downloaded yet.'));
        empty.appendChild(
          el(
            'p',
            'jellio-bookshelf-stats',
            'Use Download on a book, a manga series, an audiobook, a film or an episode to keep it on this device and read, listen or watch without the server.',
          ),
        );
        body.appendChild(empty);
        return;
      }
      SECTIONS.forEach(function (section) {
        const mine = records.filter((record) => record.Kind === section.kind);
        if (!mine.length) return;
        const block = el('section', 'jellio-downloads-section');
        block.appendChild(el('h2', 'jellio-row-title', section.title));
        const groups = new Map();
        mine.forEach(function (record) {
          if (record.Group) {
            const key = record.GroupKey || record.Group;
            if (!groups.has(key)) groups.set(key, { title: record.Group, records: [] });
            groups.get(key).records.push(record);
          } else {
            block.appendChild(row(record));
          }
        });
        groups.forEach((entry) => block.appendChild(group(entry.title, entry.records)));
        body.appendChild(block);
      });
    } finally {
      painting = false;
      if (again) {
        again = false;
        paint();
      }
    }
  }

  let scheduled = null;
  const stop = onDownloadsChange(function () {
    if (scheduled) return;
    scheduled = window.setTimeout(function () {
      scheduled = null;
      paint();
    }, 500);
  });
  paint();

  return function cleanup() {
    cancelled = true;
    stop();
    window.clearTimeout(scheduled);
    document.removeEventListener('jellio:connectivity', onConnectivity);
    objectUrls.splice(0).forEach((url) => URL.revokeObjectURL(url));
  };
}
