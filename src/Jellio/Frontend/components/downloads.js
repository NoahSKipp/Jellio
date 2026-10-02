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
  getEpisodes,
  getSeriesEpisodes,
  getMediaSources,
  getCurrentUser,
  getDownloadPlaybackInfo,
  getConversionStatus,
  matchAudioStreamIndex,
  getAudioStreams,
} from '../runtime/api.js';
import { sourceAudioLanguages } from './streamPicker.js';
import { languageName } from '../runtime/languages.js';
import { getDeviceId } from '../runtime/auth.js';
import { vendorUrl } from '../runtime/vendorScript.js';
import {
  queueDownload,
  findAnyDownload,
  recordHolds,
  removeDownload,
  retryDownload,
  onDownloadsChange,
  setLocalProgress,
  isOffline,
  timeLeftSeconds,
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
  // At the exact address the reader loads them from (versioned), which
  // is what the service worker keys its copies by.
  ['jszip.min.js', 'epub.min.js', 'pdf.min.js', 'pdf.worker.min.js'].forEach(function (name) {
    fetch(vendorUrl(name)).catch(() => {});
  });
}

function idKey(id) {
  return String(id || '').replace(/-/g, '').toLowerCase();
}

// Like the streaming apps: Low is small and quick to fetch, Higher keeps
// 1080p. Anything above these caps is re-encoded on the server; a file
// already under one is kept as it is. Low is the default.
const DOWNLOAD_AUDIO_BITRATE = 128000;
export const VIDEO_QUALITIES = [
  { value: 'low', name: 'Low', detail: '480p', height: 480, bitrate: 1000000 },
  { value: 'high', name: 'High', detail: '720p', height: 720, bitrate: 2500000 },
  { value: 'higher', name: 'Higher', detail: '1080p', height: 1080, bitrate: 5000000 },
  { value: 'original', name: 'Original file', detail: 'largest', height: 0, bitrate: 0 },
];

// HEVC holds about the same quality in around 60% of the bitrate.
const HEVC_BITRATE_FACTOR = 0.6;
let hevcResolved = false;
let hevcPromise = null;

// Whether this device asks for HEVC: the Mac app, when it can play it
// and the server encodes it in hardware (a CPU encode would be slow).
export function wantsHevc() {
  if (hevcPromise) return hevcPromise;
  hevcPromise = (async function () {
    if (!(window.jellioNative && window.jellioNative.platform === 'macos')) return false;
    if (!document.createElement('video').canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"')) return false;
    const status = await getConversionStatus().catch(() => null);
    if (!status) {
      hevcPromise = null;
      return false;
    }
    return !!status.HevcEncoding;
  })().then(function (answer) {
    if (hevcPromise) hevcResolved = answer;
    return answer;
  });
  return hevcPromise;
}

function effectiveBitrate(option, hevc) {
  return hevc ? Math.round(option.bitrate * HEVC_BITRATE_FACTOR) : option.bitrate;
}

// "High · 720p · ~1.1 GB" for a title of known length, else per hour.
export function qualityLabel(option, runtimeTicks) {
  if (!option.bitrate) return option.name + ' · ' + option.detail;
  const perSecond = (effectiveBitrate(option, hevcResolved) + DOWNLOAD_AUDIO_BITRATE) / 8;
  const size = runtimeTicks ? formatBytes(perSecond * (runtimeTicks / 1e7)) : '~' + formatBytes(perSecond * 3600) + ' per hour';
  return option.name + ' · ' + option.detail + ' · ' + (runtimeTicks ? '~' : '') + size;
}

// "about 5 min left" from runtime/offline.js's seconds estimate.
export function formatTimeLeft(seconds) {
  if (seconds == null) return '';
  if (seconds < 45) return 'less than a minute left';
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return 'about ' + minutes + ' min left';
  const hours = Math.floor(minutes / 60);
  return 'about ' + hours + ' h ' + (minutes % 60) + ' min left';
}

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
  // A chapter read straight from its source has no library item: the
  // server packs its pages into a CBZ as it downloads.
  const stream = item.Stream;
  const details = stream ? item : await getItemDetails(item.Id).catch(() => item);
  const snapshot = Object.assign({}, item, details, { Path: item.Path || details.Path });
  const isManga = kind === 'manga';
  const seriesTitle = isManga ? mangaSeriesTitle(snapshot) : '';
  const files = stream
    ? [
        { Name: 'file', Url: '/Jellio/manga/stream/chapter/' + stream.ChapterId + '/cbz', Label: snapshot.Name },
        { Name: 'cover', Url: '/Jellio/manga/thumbnail/' + stream.MangaId, Optional: true },
      ]
    : [
        { Name: 'file', Url: '/Jellio/reading/file/' + item.Id, Label: snapshot.Name },
        { Name: 'cover', Url: '/Items/' + item.Id + '/Images/Primary?maxWidth=600', Optional: true },
      ];
  if (isManga) {
    files.push({
      Name: 'seriescover',
      Url: stream ? '/Jellio/manga/thumbnail/' + stream.MangaId : '/Jellio/manga/series-cover/' + item.Id,
      Optional: true,
    });
  }
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

// The user's default audio language (Settings, Language), if any.
async function preferredAudioLanguage() {
  const user = await getCurrentUser().catch(() => null);
  return (user && user.Configuration && user.Configuration.AudioLanguagePreference) || '';
}

// Of an item's sources (Gelato lists one per release), the first whose
// audio is in the wanted language, going by its tracks or the flag
// emoji in its name (components/streamPicker.js's detection).
function sourceInLanguage(sources, language) {
  if (!language) return null;
  const wanted = languageName(language);
  return sources.find((source) => sourceAudioLanguages(source).some((code) => languageName(code) === wanted)) || null;
}

// A film or episode: the source in the user's audio language when there
// is one (else the default), opened through Jellyfin's playback
// negotiation, then converted to an MP4 every browser plays at the
// chosen quality (or the original file), with its text subtitles as
// WebVTT.
export async function downloadVideo(item, quality) {
  const option = VIDEO_QUALITIES.find((entry) => entry.value === quality) || VIDEO_QUALITIES[0];
  const [details, sources, language] = await Promise.all([
    getItemDetails(item.Id),
    getMediaSources(item.Id).catch(() => []),
    preferredAudioLanguage(),
  ]);
  const matchingSource = sourceInLanguage(sources, language);
  const chosen = matchingSource || sources[0] || null;
  const hevc = option.bitrate ? await wantsHevc() : false;
  const bitrate = effectiveBitrate(option, hevc);

  let audioIndex = chosen && language ? matchAudioStreamIndex(chosen, language) : null;
  let info = await getDownloadPlaybackInfo(item.Id, chosen && chosen.Id, audioIndex, option.height, bitrate, hevc);
  let source = info && info.MediaSources && info.MediaSources[0];
  if (!source) throw new Error('No playable stream was found for this title');

  // A source's tracks are often only known once it's been opened: look
  // again, and pick the language's track if there's a choice.
  if (audioIndex == null && language && getAudioStreams(source).length > 1) {
    const found = matchAudioStreamIndex(source, language);
    if (found != null) {
      audioIndex = found;
      info = await getDownloadPlaybackInfo(item.Id, source.Id, audioIndex, option.height, bitrate, hevc);
      source = (info && info.MediaSources && info.MediaSources[0]) || source;
    }
  }
  const languageFound = !!matchingSource || audioIndex != null;

  const staticUrl =
    '/Videos/' + item.Id + '/stream?static=true&MediaSourceId=' + encodeURIComponent(source.Id) +
    (source.LiveStreamId ? '&LiveStreamId=' + encodeURIComponent(source.LiveStreamId) : '') +
    (info.PlaySessionId ? '&PlaySessionId=' + encodeURIComponent(info.PlaySessionId) : '');
  let videoUrl;
  if (option.value === 'original' || (source.SupportsDirectPlay && !source.TranscodingUrl)) {
    videoUrl = staticUrl;
  } else if (source.TranscodingUrl) {
    videoUrl = source.TranscodingUrl.replace(/^https?:\/\/[^/]+/, '');
  } else {
    const params = new URLSearchParams({
      MediaSourceId: source.Id,
      VideoCodec: hevc ? 'hevc' : 'h264',
      AudioCodec: 'aac',
      AudioChannels: '2',
      MaxHeight: String(option.height),
      VideoBitrate: String(bitrate),
      AudioBitrate: String(DOWNLOAD_AUDIO_BITRATE),
      DeviceId: getDeviceId(),
      PlaySessionId: info.PlaySessionId || 'jellio-download-' + Date.now(),
    });
    if (source.LiveStreamId) params.set('LiveStreamId', source.LiveStreamId);
    if (audioIndex != null) params.set('AudioStreamIndex', String(audioIndex));
    videoUrl = '/Videos/' + item.Id + '/stream.mp4?' + params.toString();
  }

  const subtitles = (source.MediaStreams || []).filter(
    (stream) => stream.Type === 'Subtitle' && (stream.IsTextSubtitleStream || stream.IsExternal) && stream.Codec !== 'pgssub',
  );
  // The file itself (not a conversion) can be fetched in parts at once,
  // when the server supports it (runtime/offline.js).
  // Anything but the file as stored is converted by the server, which
  // only does a couple at a time (runtime/offline.js holds a slot for it).
  const convert = videoUrl !== staticUrl;
  if (convert) {
    const status = await getConversionStatus().catch(() => null);
    if (status && status.Available === false) {
      const busy = new Error(
        'The server is already converting ' + status.Max + ' downloads for other people. Try again in a few minutes, or choose Original file.',
      );
      busy.conversionFull = true;
      throw busy;
    }
  }
  const files = [{ Name: 'video', Url: videoUrl, Label: details.Name, Parallel: videoUrl === staticUrl, Convert: convert }];
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
  const audioStream = audioIndex != null ? getAudioStreams(source).find((stream) => stream.Index === audioIndex) : null;
  return queueDownload({
    Id: item.Id,
    Kind: 'video',
    Title: details.Name,
    Subtitle: subtitle,
    Group: isEpisode ? details.SeriesName : null,
    GroupKey: isEpisode && details.SeriesId ? idKey(details.SeriesId) : null,
    Item: details,
    Quality: option.value,
    AudioLanguage: audioStream && audioStream.Language ? languageName(audioStream.Language) : language && languageFound ? languageName(language) : '',
    LanguageNote: language && !languageFound ? 'No ' + languageName(language) + ' audio found; downloaded the default.' : '',
    // At most the cap, and no more than the source itself when known.
    EstimatedBytes:
      option.bitrate && details.RunTimeTicks
        ? Math.round(((Math.min(bitrate, source.Bitrate || bitrate) + DOWNLOAD_AUDIO_BITRATE) / 8) * (details.RunTimeTicks / 1e7))
        : 0,
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
  if (record.Status === 'queued') return record.Waiting ? 'Waiting for the server' : 'Waiting to download';
  const total = record.TotalBytes || record.EstimatedBytes;
  const left = formatTimeLeft(timeLeftSeconds(record));
  if (total) return 'Downloading ' + Math.min(99, Math.floor((record.DoneBytes / total) * 100)) + '%' + (left ? ' · ' + left : '');
  return 'Downloading · ' + formatBytes(record.DoneBytes);
}

// A small menu under a button: [{ label, onSelect }].
function openMenu(anchor, entries) {
  const anchorRect = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor;
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
  const rect = anchorRect;
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
          showToast('Could not start the download' + (err && err.message ? ': ' + err.message : '.'));
        })
        .finally(function () {
          button.disabled = false;
        });
    }
    if (kind === 'video') {
      wantsHevc().then(function () {
        openMenu(
          button,
          VIDEO_QUALITIES.map((option) => ({ label: 'Download · ' + qualityLabel(option, item.RunTimeTicks), onSelect: () => start(option.value) })),
        );
      });
    } else {
      start();
    }
  });

  paint();
  refresh();
  return button;
}

// A series' or season's page: download several episodes at once, then
// pick the quality. Episodes already downloaded are skipped.
export function buildEpisodesDownloadButton(item, options) {
  const opts = options || {};
  if ((item.Type !== 'Series' && item.Type !== 'Season') || !('caches' in window) || !('indexedDB' in window)) return null;
  const button = el('button', opts.className || 'jellio-detail-icon-action jellio-download-button');
  button.type = 'button';
  button.setAttribute('aria-label', 'Download episodes');
  button.title = 'Download episodes';
  button.appendChild(el('span', 'material-icons download'));

  button.addEventListener('click', function (event) {
    event.stopPropagation();
    openEpisodesMenu(item, button, button);
  });
  return button;
}

// Which episodes of a series or season to download, then the quality.
function openEpisodesMenu(item, anchor, busyButton) {
  if (isOffline()) {
    showToast('Downloads start once the server can be reached.');
    return;
  }
  function episodes() {
    return item.Type === 'Season' ? getEpisodes(item.SeriesId, item.Id) : getSeriesEpisodes(item.Id);
  }
  const unwatched = (list) => list.filter((episode) => !(episode.UserData && episode.UserData.Played));

  async function queue(pick, quality) {
    if (busyButton) busyButton.disabled = true;
    try {
      const chosen = pick(await episodes());
      if (!chosen.length) {
        showToast('No episodes to download.');
        return;
      }
      showToast('Getting ' + chosen.length + (chosen.length === 1 ? ' episode' : ' episodes') + ' ready to download…');
      let queued = 0;
      let busy = null;
      for (const episode of chosen) {
        const existing = await findAnyDownload(episode.Id);
        if (existing && existing.Status !== 'error') continue;
        try {
          await downloadVideo(episode, quality);
          queued += 1;
        } catch (err) {
          console.warn('Jellio: could not queue an episode', err);
          // No point asking again for the rest.
          if (err && err.conversionFull) {
            busy = err.message;
            break;
          }
        }
      }
      if (busy) {
        showToast((queued ? 'Downloading ' + queued + (queued === 1 ? ' episode' : ' episodes') + '. The rest could not be added: ' : '') + busy);
      } else {
        showToast(queued ? 'Downloading ' + queued + (queued === 1 ? ' episode.' : ' episodes.') + ' Find them under Downloads.' : 'Those episodes are already downloaded.');
      }
    } catch (err) {
      console.warn('Jellio: could not list episodes', err);
      showToast('Could not load the episodes.');
    } finally {
      if (busyButton) busyButton.disabled = false;
    }
  }

  const choices =
    item.Type === 'Season'
      ? [
          { label: 'Unwatched episodes', pick: unwatched },
          { label: 'Whole season', pick: (list) => list },
        ]
      : [
          { label: 'Next 5 unwatched', pick: (list) => unwatched(list).slice(0, 5) },
          { label: 'All unwatched', pick: unwatched },
          { label: 'Whole series', pick: (list) => list },
        ];
  openMenu(
    anchor,
    choices.map((choice) => ({
      label: 'Download · ' + choice.label,
      onSelect: () =>
        wantsHevc().then(function () {
          openMenu(
            anchor,
            VIDEO_QUALITIES.map((option) => ({ label: qualityLabel(option), onSelect: () => queue(choice.pick, option.value) })),
          );
        }),
    })),
  );
}

// Whether a card's options menu should offer Download for this item.
export function canDownload(item) {
  return (
    'caches' in window &&
    'indexedDB' in window &&
    (!!downloadKindFor(item) || item.Type === 'Series' || item.Type === 'Season')
  );
}

// Download from a card's options menu (components/cardOptionsMenu.js),
// anchored where that menu was: episodes ask which and at what quality,
// a film or episode the quality, anything else starts straight away.
export function promptDownload(item, anchorRect) {
  if (item.Type === 'Series' || item.Type === 'Season') {
    openEpisodesMenu(item, anchorRect, null);
    return;
  }
  const kind = downloadKindFor(item);
  if (!kind) return;
  if (isOffline()) {
    showToast('Downloads start once the server can be reached.');
    return;
  }
  findAnyDownload(item.Id).then(function (existing) {
    if (existing && existing.Status !== 'error') {
      showToast(existing.Status === 'done' ? 'Already downloaded.' : 'Already downloading.');
      return;
    }
    function start(quality) {
      startDownload(item, kind, quality)
        .then(() => showToast('Downloading. Find it under Downloads.'))
        .catch(function (err) {
          console.warn('Jellio: could not start the download', err);
          showToast('Could not start the download' + (err && err.message ? ': ' + err.message : '.'));
        });
    }
    if (kind === 'video') {
      wantsHevc().then(function () {
        openMenu(
          anchorRect,
          VIDEO_QUALITIES.map((option) => ({ label: 'Download · ' + qualityLabel(option, item.RunTimeTicks), onSelect: () => start(option.value) })),
        );
      });
    } else {
      start();
    }
  });
}
