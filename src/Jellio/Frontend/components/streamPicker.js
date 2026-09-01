// Pre-playback stream picker, real feedback asked for it directly:
// hitting Play used to negotiate PlaybackInfo against whichever source
// GetPlaybackMediaSources defaulted to and start playing that one
// straight away, no chance to look at what else Gelato resolved before
// committing. Visual structure ported from NuvioWeb's own real
// css/components.css (.series-stream-overlay/-panel/-left/-right/-list/
// -card, read before writing this, not guessed at) and then, real
// feedback again with real Nuvio screenshots in hand, reworked away
// from that first pass' own centered boxed card: Nuvio's own real
// stream screen never boxes the item's own art at all, it IS the full
// backdrop, with the item's own logo floating directly over it and a
// milk glass panel docked to one edge instead of centered with margins
// on every side. Data shape is this runtime's own though, not ported:
// NuvioWeb's own cards describe a raw Stremio stream from a specific
// addon (addon icon, seeders, per-addon filter chips), where every one
// of Jellio's own options is already a real Jellyfin MediaSourceInfo
// Gelato resolved server side, the same object components/../screens/
// player.js's own mid-playback Sources menu already lists, so this
// reuses that file's own real field choices (sourceLabel below) rather
// than inventing a second way to describe the same data. Addon/provider
// origin is deliberately not surfaced here (no such field exists on a
// real MediaSourceInfo, Gelato normalizes every source down to that one
// shape server side before this runtime ever sees it), real feedback
// asked for that specifically left out rather than guessed at.
import { getMediaSources, getImageUrl, TICKS_PER_SECOND } from '../runtime/api.js';
import { navigateTo } from '../runtime/router.js';
import { languageName } from '../runtime/languages.js';
import { renderLoading, renderRetry } from './networkState.js';
import { describeNetworkFailure } from '../runtime/network.js';
import { el } from '../runtime/dom.js';

const OVERLAY_ID = 'jellioStreamPicker';

// Client only, same reasoning screens/player.js's own subtitle style
// pref already uses (SUBTITLE_STYLE_KEY): a real per-title choice, not
// a server side account setting Jellyfin itself has any concept of.
// REMEMBERED_SOURCES_KEY is a plain {itemId: {mediaSourceId, ts}} map
// rather than one single slot, since remembering only the most recent
// title's own choice would forget every other title's the moment a
// second one was ever played. On by default, real feedback asked for
// it: absent from storage reads as on rather than off, only an
// explicit '0' this screen's own toggle wrote turns it off.
const REMEMBER_ENABLED_KEY = 'jellioRememberStream';
const REMEMBERED_SOURCES_KEY = 'jellioRememberedStreamSources';
const REMEMBER_TTL_MS = 4 * 24 * 60 * 60 * 1000;

export function isRememberStreamEnabled() {
  try {
    return window.localStorage.getItem(REMEMBER_ENABLED_KEY) !== '0';
  } catch (err) {
    return true;
  }
}

export function setRememberStreamEnabled(enabled) {
  try {
    window.localStorage.setItem(REMEMBER_ENABLED_KEY, enabled ? '1' : '0');
  } catch (err) {
    // Not persisted, this tab still behaves as asked until reload.
  }
}

// A choice past REMEMBER_TTL_MS is dropped as it is found rather than
// kept around stale: a source Gelato resolved days ago is exactly the
// kind of thing real feedback called "bad" (a dead debrid link, a
// torrent with no seeders left anymore), asking again after a real
// few days is the safer default, not a real inconvenience for a title
// actually still being watched inside that window.
function readRememberedSources() {
  try {
    const raw = window.localStorage.getItem(REMEMBERED_SOURCES_KEY);
    const map = raw ? JSON.parse(raw) : {};
    const now = Date.now();
    let changed = false;
    Object.keys(map).forEach(function (itemId) {
      const entry = map[itemId];
      if (!entry || typeof entry.ts !== 'number' || now - entry.ts > REMEMBER_TTL_MS) {
        delete map[itemId];
        changed = true;
      }
    });
    if (changed) {
      try {
        window.localStorage.setItem(REMEMBERED_SOURCES_KEY, JSON.stringify(map));
      } catch (err) {
        // Stale entries just get re-filtered on the next real read.
      }
    }
    return map;
  } catch (err) {
    return {};
  }
}

function rememberSourceChoice(itemId, mediaSourceId) {
  try {
    const map = readRememberedSources();
    map[itemId] = { mediaSourceId: mediaSourceId, ts: Date.now() };
    window.localStorage.setItem(REMEMBERED_SOURCES_KEY, JSON.stringify(map));
  } catch (err) {
    // A choice not remembered just asks again next time, not fatal.
  }
}

function handleKeydown(event) {
  if (event.key === 'Escape') closeStreamPicker();
}

export function closeStreamPicker() {
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();
  document.removeEventListener('keydown', handleKeydown);
}

// A source's own rich Name (Decorators/MediaSourceManagerDecorator.cs's
// own GetVersionInfo: the stream's own scraper name, plus description
// on a second line when there is one) is already the closest thing to
// a real quality/source label Gelato hands back, resolution and size
// are real fields on the same MediaSourceInfo (its own Video
// MediaStream's Height, its own Size in bytes) rather than parsed back
// out of that free text.
function sourceResolutionLabel(source) {
  const streams = source.MediaStreams || [];
  const video = streams.filter(function (stream) {
    return stream.Type === 'Video';
  })[0];
  if (!video || !video.Height) return '';
  if (video.Height >= 2000) return '4K';
  return video.Height + 'p';
}

// Real MediaStream.BitRate, per stream video track, left blank rather
// than estimated when a source carries none: runtime/api.js's own
// getPlaybackInfo has a real fallback estimate for negotiating an
// actual transcode, a real number the server has to act on either way,
// but a card here showing an invented figure would read as more real
// data than Gelato actually reported for this one source.
function sourceBitrateLabel(source) {
  const streams = source.MediaStreams || [];
  const video = streams.filter(function (stream) {
    return stream.Type === 'Video';
  })[0];
  if (!video || !video.BitRate) return '';
  return (video.BitRate / 1000000).toFixed(1) + ' Mbps';
}

// Real feedback, a real screenshot: a real Size well under 1MB (a
// mislabeled real source, or a real placeholder Gelato has not
// actually probed yet) used to round straight to a literal "0 MB"
// tag, real feedback found that read as a broken badge rather than
// small/unknown, blank now the same as no real Size at all.
function formatFileSize(bytes) {
  if (!bytes) return '';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return gb.toFixed(1) + ' GB';
  const mb = Math.round(bytes / (1024 * 1024));
  return mb > 0 ? mb + ' MB' : '';
}

// The source's own first real embedded audio track, the same one
// screens/player.js's own audio menu defaults to: Codec and Channels
// are both real fields on that MediaStream, not guessed at (a bare
// channel count is shown rather than a "5.1"/"7.1" layout name, real
// feedback found guessing that mapping from a count alone unreliable).
function sourceAudioLabel(source) {
  const audio = (source.MediaStreams || []).filter(function (stream) {
    return stream.Type === 'Audio';
  })[0];
  if (!audio) return '';
  const parts = [];
  if (audio.Codec) parts.push(String(audio.Codec).toUpperCase());
  if (audio.Channels) parts.push(audio.Channels + 'ch');
  return parts.join(' ');
}

export function sourceLabel(source) {
  const name = (source.Name || '').split('\n')[0] || 'Source';
  const details = [sourceResolutionLabel(source), formatFileSize(source.Size)]
    .filter(Boolean)
    .join(' · ');
  return details ? name + ' (' + details + ')' : name;
}

function sourceDescription(source) {
  return (source.Name || '').split('\n').slice(1).join(' ').trim();
}

// Real bug, found live: this used to read only MediaStreams, on the
// real assumption that field was reliably populated for every source
// runtime/api.js's own getMediaSources hands back. Real feedback (a
// screenshot of the actual picker) proved that wrong: Gelato's own
// bulk GET /Items/{id}?Fields=MediaSources listing only fully probes
// whichever one source already got played before, every other one of
// 38+ real results coming back with no MediaStreams audio entries at
// all, filtering German or English both landing on that exact same
// single already-probed source. AIOStreams' own real stream titles
// already carry a flag emoji per embedded audio language right in
// source.Name (confirmed against that same screenshot, not guessed
// at), a real signal every one of these sources actually has, unlike
// MediaStreams here, so this now reads both and keeps whichever codes
// either one finds.
const REGIONAL_INDICATOR_BASE = 0x1f1e6; // Unicode regional indicator 'A'

// One flag per major real source country for each language this
// picker's own LANGUAGE_OPTIONS list already covers, not every real
// ISO 3166 territory that happens to speak it.
const FLAG_COUNTRY_TO_LANGUAGE = {
  DE: 'ger', AT: 'ger', CH: 'ger',
  GB: 'eng', US: 'eng', CA: 'eng', AU: 'eng', IE: 'eng',
  FR: 'fre',
  ES: 'spa', MX: 'spa', AR: 'spa',
  IT: 'ita',
  JP: 'jpn',
  KR: 'kor',
  CN: 'chi', TW: 'chi', HK: 'chi',
  RU: 'rus',
  PT: 'por', BR: 'por',
  NL: 'dut',
  SA: 'ara', AE: 'ara',
  PL: 'pol',
  SE: 'swe',
  TR: 'tur',
};

// Array.from rather than a plain index walk: a flag emoji is a
// surrogate pair per regional indicator, a bare string index would
// split it and never match either half.
function flagLanguages(text) {
  const codes = [];
  const chars = Array.from(text || '');
  for (let i = 0; i < chars.length - 1; i++) {
    const a = chars[i].codePointAt(0);
    const b = chars[i + 1].codePointAt(0);
    if (a < REGIONAL_INDICATOR_BASE || a > REGIONAL_INDICATOR_BASE + 25) continue;
    if (b < REGIONAL_INDICATOR_BASE || b > REGIONAL_INDICATOR_BASE + 25) continue;
    const country = String.fromCharCode(65 + (a - REGIONAL_INDICATOR_BASE)) + String.fromCharCode(65 + (b - REGIONAL_INDICATOR_BASE));
    const code = FLAG_COUNTRY_TO_LANGUAGE[country];
    if (code && codes.indexOf(code) === -1) codes.push(code);
    i++;
  }
  return codes;
}

function sourceAudioLanguages(source) {
  const codes = [];
  (source.MediaStreams || []).forEach(function (stream) {
    if (stream.Type !== 'Audio' || !stream.Language) return;
    const code = stream.Language.toLowerCase();
    if (codes.indexOf(code) === -1) codes.push(code);
  });
  flagLanguages(source.Name).forEach(function (code) {
    if (codes.indexOf(code) === -1) codes.push(code);
  });
  return codes;
}

function playHash(itemId, mediaSourceId) {
  return '#/play?id=' + itemId + (mediaSourceId ? '&mediaSourceId=' + mediaSourceId : '');
}

// mm:ss, or h:mm:ss past the first real hour: the same real tick unit
// (TICKS_PER_SECOND, runtime/api.js's own real .NET TimeSpan constant)
// screens/player.js's own seek bar already renders off of, not a
// second unit conversion invented here.
function formatResumeLabel(ticks) {
  const totalSeconds = Math.floor(ticks / TICKS_PER_SECOND);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) return hours + ':' + String(minutes).padStart(2, '0') + ':' + ss;
  return minutes + ':' + ss;
}

// Exported for screens/player.js's own in-player Sources panel to
// reuse directly: the exact same dense, real card Gelato's own Name
// field already earns (resolution/bitrate/size/container/audio tags, a
// second line description when the scraper's own Name carries one),
// not a second, plainer list built from the same data. onSelect stands
// in for the close-this-overlay-and-navigate behaviour only this
// file's own picker below needs; the player's own in-place source
// switch wants something else entirely done with the same card.
export function buildSourceCard(source, onSelect, isActive) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'jellio-stream-picker-card' + (isActive ? ' jellio-stream-picker-card-active' : '');

  card.appendChild(el('div', 'jellio-stream-picker-card-title', (source.Name || '').split('\n')[0] || 'Source'));

  const description = sourceDescription(source);
  if (description) {
    card.appendChild(el('div', 'jellio-stream-picker-card-desc', description));
  }

  const tags = [
    sourceResolutionLabel(source),
    sourceBitrateLabel(source),
    formatFileSize(source.Size),
    source.Container,
    sourceAudioLabel(source),
  ]
    .filter(Boolean)
    .map(function (tag) {
      return String(tag).toUpperCase();
    });
  if (tags.length) {
    const tagRow = el('div', 'jellio-stream-picker-card-tags');
    tags.forEach(function (tag) {
      tagRow.appendChild(el('span', 'jellio-stream-picker-card-tag', tag));
    });
    card.appendChild(tagRow);
  }

  // Real feedback, a real screenshot: German showed up twice in the
  // same card. sourceAudioLanguages() already dedupes its own real
  // codes against each other, but a real embedded MediaStreams
  // Language ('de', ISO 639-1) and a real flag-emoji-derived code
  // ('ger', ISO 639-2/T, flagLanguages() above) describe the exact
  // same real language under two different real strings, real Gelato
  // sources mix both conventions, so that code-level dedup never
  // caught it. Deduping again here, against languageName()'s own real
  // resolved display name instead of the raw code, catches that.
  const languageCodes = sourceAudioLanguages(source);
  if (languageCodes.length) {
    const seenNames = {};
    const names = [];
    languageCodes.forEach(function (code) {
      const name = languageName(code);
      if (name && !seenNames[name]) {
        seenNames[name] = true;
        names.push(name);
      }
    });
    if (names.length) {
      const langRow = el('div', 'jellio-stream-picker-card-langs');
      names.forEach(function (name) {
        langRow.appendChild(el('span', 'jellio-stream-picker-card-lang', name));
      });
      card.appendChild(langRow);
    }
  }

  card.addEventListener('click', function () {
    onSelect(source);
  });

  return card;
}

// Real feedback: this used to await the whole real fetch before the
// overlay even existed, a real blank beat on a slow Gelato resolve
// with nothing on screen to show a tap had done anything at all, the
// same silent-gap shape found and fixed on the detail screen, search
// and the boot splash. The overlay (backdrop, dim, back button) now
// mounts first, synchronously, real data this function already has
// off item itself; only the status underneath it (a spinner, then
// either the real list or a real retry/empty state) waits on the
// fetch. document.getElementById(OVERLAY_ID) is checked again after
// every real await below: a reader who hits back or Escape while this
// is still loading has already removed the one real overlay this
// function is filling in, and nothing past that point should keep
// touching a detached node.
function buildOverlayShell(item) {
  const overlay = el('div', 'jellio-stream-picker-overlay jellio-stream-picker-overlay-status');
  overlay.id = OVERLAY_ID;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Choose a stream');
  overlay.addEventListener('click', function (event) {
    if (event.target === overlay) closeStreamPicker();
  });
  document.addEventListener('keydown', handleKeydown);

  const backdropTag = item.BackdropImageTags && item.BackdropImageTags[0];
  const posterTag = item.ImageTags && item.ImageTags.Primary;
  if (backdropTag) {
    overlay.style.backgroundImage = "url('" + getImageUrl(item.Id, 'Backdrop', { tag: backdropTag, maxWidth: 1920 }) + "')";
  } else if (posterTag) {
    overlay.style.backgroundImage = "url('" + getImageUrl(item.Id, 'Primary', { tag: posterTag, maxWidth: 1920 }) + "')";
  }

  overlay.appendChild(el('div', 'jellio-stream-picker-dim'));

  // Top-left, over the open backdrop rather than a corner of a boxed
  // panel: real Nuvio reference, its own stream screen has no visible
  // close affordance at all beyond this, a plain back arrow.
  const backButton = document.createElement('button');
  backButton.type = 'button';
  backButton.className = 'jellio-stream-picker-back';
  backButton.setAttribute('aria-label', 'Close');
  const backIcon = el('span', 'material-icons arrow_back');
  backIcon.setAttribute('aria-hidden', 'true');
  backButton.appendChild(backIcon);
  backButton.addEventListener('click', closeStreamPicker);
  overlay.appendChild(backButton);

  const status = el('div', 'jellio-stream-picker-status');
  overlay.appendChild(status);

  document.body.appendChild(overlay);
  return { overlay: overlay, status: status };
}

// A picker with nothing real to pick between is not worth showing at
// all, same reasoning screens/player.js's own mid-playback Sources
// button already uses for a one-option list: straight to Play instead,
// same as before this existed. options.forceChoice is screens/detail.js's
// own Change Stream button: it only ever needs to skip the remembered
// shortcut below, a title with one real source still has nothing to
// change to either way, so that check stays first regardless.
export async function openStreamPicker(item, options) {
  closeStreamPicker();
  const opts = options || {};

  const shell = buildOverlayShell(item);
  renderLoading(shell.status);

  let sources = [];
  try {
    sources = await getMediaSources(item.Id);
  } catch (err) {
    console.warn('Jellio: could not load sources for the stream picker', err);
    if (document.getElementById(OVERLAY_ID) !== shell.overlay) return;
    shell.status.textContent = '';
    renderRetry(shell.status, describeNetworkFailure('streams for this title', err), function () {
      openStreamPicker(item, options);
    }, { onBack: closeStreamPicker, backLabel: 'Close' });
    return;
  }

  if (document.getElementById(OVERLAY_ID) !== shell.overlay) return;

  if (!sources.length) {
    shell.status.textContent = '';
    renderRetry(shell.status, 'No streams found for this title.', function () {
      openStreamPicker(item, options);
    }, { onBack: closeStreamPicker, backLabel: 'Close' });
    return;
  }

  if (sources.length === 1) {
    closeStreamPicker();
    navigateTo(playHash(item.Id, sources[0].Id));
    return;
  }

  if (!opts.forceChoice && isRememberStreamEnabled()) {
    const remembered = readRememberedSources()[item.Id];
    const rememberedId = remembered && remembered.mediaSourceId;
    const stillOffered = rememberedId && sources.some(function (source) {
      return source.Id === rememberedId;
    });
    if (stillOffered) {
      closeStreamPicker();
      navigateTo(playHash(item.Id, rememberedId));
      return;
    }
  }

  const overlay = shell.overlay;
  shell.status.remove();
  overlay.classList.remove('jellio-stream-picker-overlay-status');

  // Real feedback with real Nuvio screenshots in hand: the picker used
  // to box the poster in its own small card inside the panel. Nuvio's
  // own real stream screen has no such box at all, the backdrop itself
  // is the art, with the item's own Logo image (or, absent one, its
  // plain title, same onerror fallback screens/../components/
  // heroCarousel.js's own hero already uses) floating directly over it.
  const hero = el('div', 'jellio-stream-picker-hero');
  const isEpisode = item.Type === 'Episode' && !!item.SeriesName;

  const logo = document.createElement('img');
  logo.className = 'jellio-stream-picker-logo';
  logo.alt = '';
  logo.onerror = function () {
    logo.classList.add('jellio-stream-picker-logo-hidden');
  };
  logo.src = getImageUrl(item.Id, 'Logo', { maxWidth: 800 });
  hero.appendChild(logo);
  hero.appendChild(el('h2', 'jellio-stream-picker-title', isEpisode ? item.SeriesName : item.Name || ''));

  if (isEpisode) {
    const hasSeason = typeof item.ParentIndexNumber === 'number';
    const hasEpisode = typeof item.IndexNumber === 'number';
    const code = hasSeason && hasEpisode ? 'S' + item.ParentIndexNumber + 'E' + item.IndexNumber : '';
    const episodeLine = code ? code + ' - ' + (item.Name || '') : item.Name || '';
    hero.appendChild(el('div', 'jellio-stream-picker-episode', episodeLine));
  }
  overlay.appendChild(hero);

  const panel = el('div', 'jellio-stream-picker-panel');

  // Real Jellyfin field, the same one screens/player.js's own resume
  // already reads off item.UserData to seek on real playback start:
  // this is a fast path onto that same real behaviour, not a second
  // resume mechanism, picking the remembered/first source and letting
  // the player's own existing resume logic do the actual seek.
  const resumeTicks = item.UserData && item.UserData.PlaybackPositionTicks;
  if (resumeTicks) {
    const resumeButton = el('button', 'jellio-stream-picker-resume', 'Resume from ' + formatResumeLabel(resumeTicks));
    resumeButton.type = 'button';
    resumeButton.addEventListener('click', function () {
      const remembered = readRememberedSources()[item.Id];
      const rememberedId = remembered && remembered.mediaSourceId;
      const stillOffered = rememberedId && sources.some(function (source) {
        return source.Id === rememberedId;
      });
      const targetId = stillOffered ? rememberedId : sources[0] && sources[0].Id;
      closeStreamPicker();
      navigateTo(playHash(item.Id, targetId));
    });
    panel.appendChild(resumeButton);
  }

  const count = el('div', 'jellio-stream-picker-count');

  // Only worth showing when there is a real choice behind it: every
  // source carrying the exact same one language (or none at all,
  // common for a release with no real embedded audio metadata) leaves
  // nothing for a filter to actually narrow, same reasoning the whole
  // picker already skips itself for a single-source title.
  const languageCounts = {};
  sources.forEach(function (source) {
    sourceAudioLanguages(source).forEach(function (code) {
      languageCounts[code] = (languageCounts[code] || 0) + 1;
    });
  });
  const languages = Object.keys(languageCounts).sort(function (a, b) {
    return languageCounts[b] - languageCounts[a] || languageName(a).localeCompare(languageName(b));
  });

  let selectedLanguage = null;
  const list = el('div', 'jellio-stream-picker-list');

  function renderList() {
    list.textContent = '';
    const filtered = selectedLanguage
      ? sources.filter(function (source) {
          return sourceAudioLanguages(source).indexOf(selectedLanguage) !== -1;
        })
      : sources;
    count.textContent = filtered.length + ' stream' + (filtered.length === 1 ? '' : 's') + ' found';
    filtered.forEach(function (source) {
      list.appendChild(
        buildSourceCard(source, function (picked) {
          if (isRememberStreamEnabled()) rememberSourceChoice(item.Id, picked.Id);
          closeStreamPicker();
          navigateTo(playHash(item.Id, picked.Id));
        }),
      );
    });
  }

  if (languages.length > 1) {
    const filterRow = el('div', 'jellio-stream-picker-filters');
    const chips = [];
    function setSelected(code, chip) {
      selectedLanguage = code;
      chips.forEach(function (entry) {
        entry.chip.classList.toggle('jellio-stream-picker-filter-chip-active', entry.chip === chip);
      });
      renderList();
    }
    const allChip = el('button', 'jellio-stream-picker-filter-chip jellio-stream-picker-filter-chip-active', 'All');
    allChip.type = 'button';
    allChip.addEventListener('click', function () {
      setSelected(null, allChip);
    });
    chips.push({ chip: allChip });
    filterRow.appendChild(allChip);
    languages.forEach(function (code) {
      const chip = el('button', 'jellio-stream-picker-filter-chip', languageName(code));
      chip.type = 'button';
      chip.addEventListener('click', function () {
        setSelected(code, chip);
      });
      chips.push({ chip: chip });
      filterRow.appendChild(chip);
    });
    panel.appendChild(filterRow);
  }

  panel.appendChild(count);
  renderList();
  panel.appendChild(list);

  overlay.appendChild(panel);
}
