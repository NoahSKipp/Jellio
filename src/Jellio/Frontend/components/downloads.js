// What gets downloaded for each kind of item, and the Download button
// that sits on its page. The files and bookkeeping are runtime/offline.js's;
// this file decides which files make up a book, a manga chapter, an
// audiobook or a video, and snapshots what's needed to show and resume
// them offline.
import {
  getItemDetails,
  getAudiobookTracks,
  getReadingProgress,
  getAnnotations,
  audiobookTitle,
} from '../runtime/api.js';
import { getDeviceId } from '../runtime/auth.js';
import {
  queueDownload,
  findAnyDownload,
  recordHolds,
  removeDownload,
  retryDownload,
  onDownloadsChange,
  setLocalProgress,
  isOffline,
} from '../runtime/offline.js';
import { mangaSeriesTitle, mangaSeriesKey } from './mangaSeries.js';
import { showToast } from './toast.js';
import { el } from '../runtime/dom.js';

// The reader's libraries, fetched once so the service worker keeps them
// for opening books offline.
let vendorWarmed = false;
function warmReaderScripts() {
  if (vendorWarmed) return;
  vendorWarmed = true;
  ['jszip.min.js', 'epub.min.js', 'pdf.min.js', 'pdf.worker.min.js'].forEach(function (name) {
    fetch('/Jellio/frontend/vendor/' + name).catch(() => {});
  });
}

function idKey(id) {
  return String(id || '').replace(/-/g, '').toLowerCase();
}

export const VIDEO_QUALITIES = [
  { value: '1080', label: '1080p', height: 1080, bitrate: 8000000 },
  { value: '720', label: '720p', height: 720, bitrate: 4000000 },
  { value: '480', label: '480p · smallest', height: 480, bitrate: 1500000 },
  { value: 'original', label: 'Original file', height: 0, bitrate: 0 },
];

export function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return (value >= 10 || unit < 2 ? Math.round(value) : value.toFixed(1)) + ' ' + units[unit];
}

// Books and manga chapters: the file the reader opens, its cover, and
// where the reader got to.
export async function downloadBook(item, kind) {
  warmReaderScripts();
  const details = await getItemDetails(item.Id).catch(() => item);
  const snapshot = Object.assign({}, item, details, { Path: item.Path || details.Path });
  const isManga = kind === 'manga';
  const seriesTitle = isManga ? mangaSeriesTitle(snapshot) : '';
  const files = [
    { Name: 'file', Url: '/Jellio/reading/file/' + item.Id, Label: snapshot.Name },
    { Name: 'cover', Url: '/Items/' + item.Id + '/Images/Primary?maxWidth=600', Optional: true },
  ];
  if (isManga) files.push({ Name: 'seriescover', Url: '/Jellio/manga/series-cover/' + item.Id, Optional: true });
  const record = await queueDownload({
    Id: item.Id,
    Kind: isManga ? 'manga' : 'book',
    Title: snapshot.Name,
    Subtitle: isManga ? seriesTitle : snapshot.AlbumArtist || '',
    Group: seriesTitle || null,
    GroupKey: seriesTitle ? mangaSeriesKey(seriesTitle) : null,
    Item: snapshot,
    Files: files,
  });
  getReadingProgress(item.Id)
    .then(function (progress) {
      if (progress && progress.Locator) setLocalProgress(item.Id, progress);
    })
    .catch(() => {});
  getAnnotations(item.Id).catch(() => {});
  return record;
}

// Every track of an audiobook, with its cover under each track's id too,
// since the player asks for covers by track.
export async function downloadAudiobook(item) {
  const existing = await findAnyDownload(item.Id);
  if (existing && existing.Status !== 'error') return existing;
  const tracks = await getAudiobookTracks(item);
  const title = audiobookTitle(item, tracks.length);
  const trackIds = tracks.map((track) => idKey(track.Id));
  const aliases = trackIds.concat(item.AlbumId ? [idKey(item.AlbumId)] : []);
  return queueDownload({
    Id: item.Id,
    Kind: 'audiobook',
    Title: title,
    Subtitle: item.AlbumArtist || (item.Artists && item.Artists[0]) || '',
    Item: Object.assign({}, item, { Name: title }),
    Tracks: tracks,
    TrackIds: trackIds,
    CoverAliases: aliases,
    Files: tracks
      .map(function (track, index) {
        return { Name: 'track-' + idKey(track.Id), Url: '/Audio/' + track.Id + '/stream?static=true', Label: 'part ' + (index + 1) };
      })
      .concat([{ Name: 'cover', Url: '/Items/' + (item.AlbumId || item.Id) + '/Images/Primary?maxWidth=600', Optional: true }]),
  });
}

// A film or episode, converted by Jellyfin to an MP4 every browser plays
// (or the original file), plus its text subtitles as WebVTT.
export async function downloadVideo(item, quality) {
  const details = await getItemDetails(item.Id);
  const source = (details.MediaSources || [])[0];
  if (!source) throw new Error('This video has no playable file');
  const option = VIDEO_QUALITIES.find((entry) => entry.value === quality) || VIDEO_QUALITIES[1];
  let videoUrl;
  if (option.value === 'original') {
    videoUrl = '/Videos/' + item.Id + '/stream?static=true&MediaSourceId=' + encodeURIComponent(source.Id);
  } else {
    const params = new URLSearchParams({
      MediaSourceId: source.Id,
      VideoCodec: 'h264',
      AudioCodec: 'aac',
      AudioChannels: '2',
      MaxHeight: String(option.height),
      VideoBitrate: String(option.bitrate),
      AudioBitrate: '192000',
      DeviceId: getDeviceId(),
      PlaySessionId: 'jellio-download-' + Date.now(),
    });
    videoUrl = '/Videos/' + item.Id + '/stream.mp4?' + params.toString();
  }
  const subtitles = (source.MediaStreams || []).filter(
    (stream) => stream.Type === 'Subtitle' && (stream.IsTextSubtitleStream || stream.IsExternal) && stream.Codec !== 'pgssub',
  );
  const files = [{ Name: 'video', Url: videoUrl, Label: details.Name }];
  subtitles.forEach(function (stream) {
    files.push({
      Name: 'sub-' + stream.Index,
      Url: '/Videos/' + item.Id + '/' + source.Id + '/Subtitles/' + stream.Index + '/0/Stream.vtt',
      Optional: true,
    });
  });
  files.push({ Name: 'cover', Url: '/Items/' + item.Id + '/Images/Primary?maxWidth=600', Optional: true });
  if (details.SeriesId) {
    files.push({ Name: 'poster', Url: '/Items/' + details.SeriesId + '/Images/Primary?maxWidth=400', Optional: true });
  }
  const isEpisode = details.Type === 'Episode';
  const subtitle = isEpisode
    ? [details.SeriesName, details.ParentIndexNumber != null ? 'S' + details.ParentIndexNumber + ' E' + details.IndexNumber : ''].filter(Boolean).join(' · ')
    : details.ProductionYear
      ? String(details.ProductionYear)
      : '';
  return queueDownload({
    Id: item.Id,
    Kind: 'video',
    Title: details.Name,
    Subtitle: subtitle,
    Group: isEpisode ? details.SeriesName : null,
    GroupKey: isEpisode && details.SeriesId ? idKey(details.SeriesId) : null,
    Item: details,
    Quality: option.value,
    EstimatedBytes: option.bitrate && details.RunTimeTicks ? Math.round(((option.bitrate + 192000) / 8) * (details.RunTimeTicks / 1e7)) : 0,
    Subtitles: subtitles.map(function (stream) {
      return {
        Name: 'sub-' + stream.Index,
        Index: stream.Index,
        Language: stream.Language || '',
        Label: stream.DisplayTitle || stream.Title || stream.Language || 'Subtitles',
        IsDefault: !!stream.IsDefault,
      };
    }),
    Files: files,
  });
}

export function downloadKindFor(item, bookKind) {
  if (item.Type === 'AudioBook') return 'audiobook';
  if (item.Type === 'Book') return bookKind === 'manga' || /\.(cbz|cbr|cb7|cbt)$/i.test(item.Path || '') ? 'manga' : 'book';
  if (item.Type === 'Movie' || item.Type === 'Episode' || item.Type === 'Video' || item.Type === 'MusicVideo') return 'video';
  return null;
}

function startDownload(item, kind, quality) {
  if (kind === 'audiobook') return downloadAudiobook(item);
  if (kind === 'video') return downloadVideo(item, quality);
  return downloadBook(item, kind);
}

function statusText(record) {
  if (!record) return null;
  if (record.Status === 'done') return 'Downloaded';
  if (record.Status === 'error') return 'Download failed';
  if (record.Status === 'queued') return 'Waiting to download';
  const total = record.TotalBytes || record.EstimatedBytes;
  if (total) return 'Downloading ' + Math.min(99, Math.floor((record.DoneBytes / total) * 100)) + '%';
  return 'Downloading · ' + formatBytes(record.DoneBytes);
}

// A small menu under a button: [{ label, onSelect }].
function openMenu(anchor, entries) {
  const menu = el('div', 'jellio-download-menu');
  entries.forEach(function (entry) {
    const option = el('button', 'jellio-download-menu-item', entry.label);
    option.type = 'button';
    option.addEventListener('click', function (event) {
      event.stopPropagation();
      close();
      entry.onSelect();
    });
    menu.appendChild(option);
  });
  function close() {
    menu.remove();
    document.removeEventListener('click', close, true);
  }
  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = rect.bottom + 6 + 'px';
  window.setTimeout(() => document.addEventListener('click', close, true), 0);
}

// The Download button for an item's page. options.bookKind: 'manga' for
// a chapter on the Manga shelf. options.compact: icon only.
export function buildDownloadButton(item, options) {
  const opts = options || {};
  const kind = downloadKindFor(item, opts.bookKind);
  if (!kind || !('caches' in window) || !('indexedDB' in window)) return null;
  const button = el('button', opts.className || 'jellio-detail-icon-action jellio-download-button');
  button.type = 'button';
  let record = null;

  function paint() {
    button.textContent = '';
    const done = record && record.Status === 'done';
    const busy = record && (record.Status === 'queued' || record.Status === 'downloading');
    const icon = done ? 'download_done' : record && record.Status === 'error' ? 'error_outline' : busy ? 'downloading' : 'download';
    button.appendChild(el('span', 'material-icons ' + icon));
    const label = statusText(record) || 'Download';
    if (!opts.compact) button.appendChild(el('span', 'jellio-download-button-label', label));
    button.setAttribute('aria-label', label);
    button.title = label;
    button.classList.toggle('jellio-detail-icon-action-active', !!done);
    button.classList.toggle('jellio-download-busy', !!busy);
  }

  function refresh() {
    findAnyDownload(item.Id).then(function (found) {
      record = found;
      paint();
    });
  }

  // Stops listening once the button has been on the page and left it.
  const stop = onDownloadsChange(function (changed) {
    if (button.isConnected) button.dataset.mounted = '1';
    else if (button.dataset.mounted) {
      stop();
      return;
    }
    if (!recordHolds(changed, item.Id)) return;
    record = changed.Status === 'removed' ? null : changed;
    paint();
  });

  button.addEventListener('click', function (event) {
    event.stopPropagation();
    if (record && record.Status === 'done') {
      openMenu(button, [{ label: 'Remove download', onSelect: () => removeDownload(record.Id) }]);
      return;
    }
    if (record && record.Status === 'error') {
      openMenu(button, [
        { label: 'Try again', onSelect: () => retryDownload(record.Id) },
        { label: 'Remove', onSelect: () => removeDownload(record.Id) },
      ]);
      return;
    }
    if (record) {
      openMenu(button, [{ label: 'Cancel download', onSelect: () => removeDownload(record.Id) }]);
      return;
    }
    if (isOffline()) {
      showToast('Downloads start once the server can be reached.');
      return;
    }
    function start(quality) {
      button.disabled = true;
      startDownload(item, kind, quality)
        .then(function (queued) {
          record = queued;
          paint();
          showToast('Downloading. Find it under Downloads.');
        })
        .catch(function (err) {
          console.warn('Jellio: could not start the download', err);
          showToast('Could not start the download.');
        })
        .finally(function () {
          button.disabled = false;
        });
    }
    if (kind === 'video') {
      openMenu(
        button,
        VIDEO_QUALITIES.map((option) => ({ label: 'Download · ' + option.label, onSelect: () => start(option.value) })),
      );
    } else {
      start();
    }
  });

  paint();
  refresh();
  return button;
}
