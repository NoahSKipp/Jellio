import { t } from '../runtime/i18n.js';
import { getMediaSources, getImageUrl, TICKS_PER_SECOND, canBrowserDirectPlay, loadVideoTranscodePolicy, getWarmSources, getQualityTiers } from '../runtime/api.js';
import { isPreferReadyEnabled, preferReadySource, normalizeId } from '../runtime/readySources.js';
import { isBadSource } from '../runtime/streamHealth.js';
import { avoidingVideoTranscodes, classifySource, getVideoTranscodePolicy, playbackOutlook } from '../runtime/transcodePolicy.js';
import { videoInfoOf } from '../runtime/transcodeClassifier.js';
import { QUALITY_ORDER, labelQuality, sourceQuality, filterPlayableSources } from '../runtime/quality.js';
import { getAvailableEditions, detectSourceEdition, rawEditionTag } from '../runtime/editions.js';

export { sourceQuality };
import { navigateTo } from '../runtime/router.js';
import { languageName } from '../runtime/languages.js';
import { renderLoading, renderRetry } from './networkState.js';
import { describeNetworkFailure } from '../runtime/network.js';
import { el } from '../runtime/dom.js';

const OVERLAY_ID = 'jellioStreamPicker';
const READY_INFO_WAIT_MS = 1200;

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
  if (event.key === 'Escape') {
    closeStreamPicker();
    return;
  }
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) return;
  const cards = Array.from(overlay.querySelectorAll('.jellio-stream-picker-card'));
  if (!cards.length) return;

  const activeIndex = cards.indexOf(document.activeElement);
  if (event.key === 'ArrowDown' || event.key === 'j') {
    event.preventDefault();
    const nextIndex = activeIndex === -1 ? 0 : Math.min(cards.length - 1, activeIndex + 1);
    cards[nextIndex].focus();
    cards[nextIndex].scrollIntoView({ block: 'nearest' });
  } else if (event.key === 'ArrowUp' || event.key === 'k') {
    event.preventDefault();
    const prevIndex = activeIndex === -1 ? 0 : Math.max(0, activeIndex - 1);
    cards[prevIndex].focus();
    cards[prevIndex].scrollIntoView({ block: 'nearest' });
  }
}

function closeStreamPicker() {
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();
  document.removeEventListener('keydown', handleKeydown);
}

function sourceResolutionLabel(source) {
  const streams = source.MediaStreams || [];
  const video = streams.filter(function (stream) {
    return stream.Type === 'Video';
  })[0];
  if (!video || !video.Height) return '';
  if (video.Height >= 2000) return '4K';
  return video.Height + 'p';
}

function sourceBitrateLabel(source) {
  const streams = source.MediaStreams || [];
  const video = streams.filter(function (stream) {
    return stream.Type === 'Video';
  })[0];
  if (!video || !video.BitRate) return '';
  return (video.BitRate / 1000000).toFixed(1) + ' Mbps';
}

function formatFileSize(bytes) {
  if (!bytes) return '';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return gb.toFixed(1) + ' GB';
  const mb = Math.round(bytes / (1024 * 1024));
  return mb > 0 ? mb + ' MB' : '';
}

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
  // A label that already names its quality doesn't need the probed one.
  const details = [labelQuality(source) ? '' : sourceResolutionLabel(source), formatFileSize(source.Size)]
    .filter(Boolean)
    .join(' · ');
  return details ? name + ' (' + details + ')' : name;
}

function sourceDescription(source) {
  return (source.Name || '').split('\n').slice(1).join(' ').trim();
}

const REGIONAL_INDICATOR_BASE = 0x1f1e6; // Unicode regional indicator 'A'

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

const ORIGINAL_AUDIO_CODE = '__original__';

const MULTI_AUDIO_CODE = '__multi__';

const MULTI_AUDIO_PATTERN = /\b(multi|dual)([-.\s]?audio)?\b/i;

export function sourceAudioLanguages(source) {
  const codes = [];
  (source.MediaStreams || []).forEach(function (stream) {
    if (stream.Type !== 'Audio' || !stream.Language) return;
    const code = stream.Language.toLowerCase();
    if (codes.indexOf(code) === -1) codes.push(code);
  });
  flagLanguages(source.Name).forEach(function (code) {
    if (codes.indexOf(code) === -1) codes.push(code);
  });
  if (!codes.length && MULTI_AUDIO_PATTERN.test(source.Name || '')) {
    codes.push(MULTI_AUDIO_CODE);
  }
  if (!codes.length) codes.push(ORIGINAL_AUDIO_CODE);
  return codes;
}

export function playHash(itemId, mediaSourceId) {
  return '#/play?id=' + itemId + (mediaSourceId ? '&mediaSourceId=' + mediaSourceId : '');
}

function formatResumeLabel(ticks) {
  const totalSeconds = Math.floor(ticks / TICKS_PER_SECOND);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) return hours + ':' + String(minutes).padStart(2, '0') + ':' + ss;
  return minutes + ':' + ss;
}

const OUTLOOK_ICONS = { good: 'check_circle', warn: 'warning', block: 'block' };

// "Plays smoothly" / "Likely to stutter: ..." / "Won't play: ..." from
// runtime/transcodePolicy.js's playbackOutlook().
export function buildOutlookBadge(outlook) {
  const badge = el('span', 'jellio-outlook jellio-outlook-' + outlook.tone);
  const icon = el('span', 'material-icons ' + OUTLOOK_ICONS[outlook.tone]);
  icon.setAttribute('aria-hidden', 'true');
  badge.appendChild(icon);
  badge.appendChild(el('span', null, outlook.text));
  badge.title = outlook.title;
  return badge;
}

export function buildSourceCard(source, onSelect, isActive, allSources) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'jellio-stream-picker-card' + (isActive ? ' jellio-stream-picker-card-active' : '');

  card.appendChild(el('div', 'jellio-stream-picker-card-title', (source.Name || '').split('\n')[0] || 'Source'));

  const description = sourceDescription(source);
  if (description) {
    card.appendChild(el('div', 'jellio-stream-picker-card-desc', description));
  }

  const detectedEdition = allSources && getAvailableEditions(allSources).length >= 2
    ? detectSourceEdition(source, allSources)
    : rawEditionTag(source);

  const tags = [
    labelQuality(source) || sourceResolutionLabel(source) || sourceQuality(source),
    sourceBitrateLabel(source),
    formatFileSize(source.Size),
    source.Container,
    sourceAudioLabel(source),
  ]
    .filter(Boolean)
    .map(function (tag) {
      return String(tag).toUpperCase();
    });

  if (detectedEdition) {
    tags.unshift(detectedEdition.toUpperCase());
  }

  if (tags.length) {
    const tagRow = el('div', 'jellio-stream-picker-card-tags');
    tags.forEach(function (tag) {
      const isEdition = detectedEdition && tag === detectedEdition.toUpperCase();
      tagRow.appendChild(
        el('span', 'jellio-stream-picker-card-tag' + (isEdition ? ' jellio-stream-picker-card-edition' : ''), tag),
      );
    });
    card.appendChild(tagRow);
  }

  const languageCodes = sourceAudioLanguages(source);
  const langRow = el('div', 'jellio-stream-picker-card-langs');
  const seenNames = {};
  languageCodes.forEach(function (code) {
    const name = languageName(code);
    if (!name || seenNames[name]) return;
    seenNames[name] = true;
    const isInferred = code === ORIGINAL_AUDIO_CODE;
    langRow.appendChild(
      el('span', 'jellio-stream-picker-card-lang' + (isInferred ? ' jellio-stream-picker-card-lang-unknown' : ''), name),
    );
  });
  card.appendChild(langRow);

  card.addEventListener('click', function () {
    onSelect(source);
  });

  return card;
}

function buildOverlayShell(item) {
  const overlay = el('div', 'jellio-stream-picker-overlay jellio-stream-picker-overlay-status');
  overlay.id = OVERLAY_ID;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', t('stream_choose'));
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

  const backButton = document.createElement('button');
  backButton.type = 'button';
  backButton.className = 'jellio-stream-picker-back';
  backButton.setAttribute('aria-label', t('action_close'));
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

export function buildLanguageFilterRow(sources, onSelect) {
  const languageCounts = {};
  sources.forEach(function (source) {
    sourceAudioLanguages(source).forEach(function (code) {
      languageCounts[code] = (languageCounts[code] || 0) + 1;
    });
  });
  const languages = Object.keys(languageCounts).sort(function (a, b) {
    return languageCounts[b] - languageCounts[a] || languageName(a).localeCompare(languageName(b));
  });
  if (!languages.length) return null;
  return buildChipRow(languages.map(function (code) {
    return { value: code, label: languageName(code) };
  }), onSelect);
}

export function buildQualityFilterRow(sources, onSelect) {
  const present = {};
  sources.forEach(function (source) {
    const quality = sourceQuality(source);
    if (quality) present[quality] = true;
  });
  const qualities = QUALITY_ORDER.filter(function (quality) {
    return present[quality];
  });
  if (!qualities.length) return null;
  return buildChipRow(qualities.map(function (quality) {
    return { value: quality, label: quality };
  }), onSelect);
}

export function buildEditionFilterRow(sources, onSelect, initialSelected) {
  const editions = getAvailableEditions(sources);
  if (editions.length < 2) return null;
  return buildChipRow(
    editions.map(function (edition) {
      return { value: edition, label: edition };
    }),
    onSelect,
    initialSelected,
  );
}

// Language, quality, and edition chips combine: a source has to match all active filters.
export function filterSources(sources, language, quality, edition) {
  return sources.filter(function (source) {
    if (language && sourceAudioLanguages(source).indexOf(language) === -1) return false;
    if (quality && sourceQuality(source) !== quality) return false;
    if (edition && detectSourceEdition(source, sources) !== edition) return false;
    return true;
  });
}

function buildChipRow(entries, onSelect, initialSelected) {
  const filterRow = el('div', 'jellio-stream-picker-filters');
  const chips = [];
  function setSelected(value, chip) {
    chips.forEach(function (entry) {
      entry.classList.toggle('jellio-stream-picker-filter-chip-active', entry === chip);
    });
    onSelect(value);
  }
  const isDefaultAll = !initialSelected;
  const allChip = el(
    'button',
    'jellio-stream-picker-filter-chip' + (isDefaultAll ? ' jellio-stream-picker-filter-chip-active' : ''),
    t('stream_all'),
  );
  allChip.type = 'button';
  allChip.addEventListener('click', function () {
    setSelected(null, allChip);
  });
  chips.push(allChip);
  filterRow.appendChild(allChip);
  entries.forEach(function (entry) {
    const isActive = initialSelected === entry.value;
    const chip = el(
      'button',
      'jellio-stream-picker-filter-chip' + (isActive ? ' jellio-stream-picker-filter-chip-active' : ''),
      entry.label,
    );
    chip.type = 'button';
    chip.addEventListener('click', function () {
      setSelected(entry.value, chip);
    });
    chips.push(chip);
    filterRow.appendChild(chip);
  });
  return filterRow;
}

function buildRefreshChip(onRefresh) {
  const btn = el('button', 'jellio-stream-picker-filter-chip');
  btn.type = 'button';
  btn.setAttribute('aria-label', t('stream_refresh'));
  btn.title = t('stream_refresh');
  const icon = el('span', 'material-icons refresh');
  icon.setAttribute('aria-hidden', 'true');
  icon.style.fontSize = '1.15em';
  icon.style.verticalAlign = 'middle';
  btn.appendChild(icon);
  btn.addEventListener('click', onRefresh);
  return btn;
}

function buildDigitalReleaseFilterCard(onRefresh) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'jellio-stream-picker-card';
  card.appendChild(el('div', 'jellio-stream-picker-card-title', '📅 ' + t('stream_picker_digital_release')));
  card.appendChild(
    el(
      'div',
      'jellio-stream-picker-card-desc',
      '⚠ No streams found. Perhaps there is no digital release available for this media yet.',
    ),
  );
  card.addEventListener('click', onRefresh);
  return card;
}

export async function openStreamPicker(item, options) {
  closeStreamPicker();
  const opts = options || {};
  // Null until the server said which sources are ready.
  let warmSourceIds = null;
  function isSourceReady(source) {
    return !!warmSourceIds && warmSourceIds.has(normalizeId(source.Id));
  }
  const refreshStreams = function () {
    openStreamPicker(item, Object.assign({}, opts, { forceFresh: true }));
  };

  const shell = buildOverlayShell(item);
  renderLoading(shell.status);

  // Which sources start fast and their quality tiers; never holds the list up
  // for long.
  const readyInfo = Promise.race([
    Promise.all([getWarmSources(item.Id, { forceFresh: !!opts.forceFresh }), getQualityTiers(item.Id)]),
    new Promise(function (resolve) {
      window.setTimeout(function () { resolve(null); }, READY_INFO_WAIT_MS);
    }),
  ]);

  let sources = [];
  try {
    sources = await getMediaSources(item.Id, { forceFresh: !!opts.forceFresh });
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

  sources = filterPlayableSources(sources);

  const methods = new Map();
  if (sources.length) {
    try {
      await loadVideoTranscodePolicy();
    } catch (err) {}
    const avoiding = avoidingVideoTranscodes();
    if (avoiding) {
      sources.forEach(function (source) {
        // Unprobed addon streams are judged from their name; nothing to go
        // on in either means no badge.
        if (!videoInfoOf(source)) return;
        const classification = classifySource(source, canBrowserDirectPlay(source));
        methods.set(source.Id, { method: classification.playMethod, classification: classification });
      });
      if (getVideoTranscodePolicy() === 'Block') {
        const playable = sources.filter(function (source) {
          return !methods.has(source.Id) || methods.get(source.Id).method !== 'Transcode';
        });
        if (!playable.length) {
          if (document.getElementById(OVERLAY_ID) !== shell.overlay) return;
          shell.status.textContent = '';
          renderRetry(
            shell.status,
            'Every stream for this title would need the server to re-encode the video, which is turned off on this server.',
            null,
            { onBack: closeStreamPicker, backLabel: 'Close' },
          );
          return;
        }
        sources = playable;
      }
    }

    // Streams that recently failed to play go last, flagged below; in Avoid,
    // streams that need a video re-encode go after the rest.
    const ranks = new Map();
    sources = sources
      .map(function (source, index) {
        const rank = (isBadSource(item.Id, source) ? 2 : 0) + (methods.has(source.Id) && methods.get(source.Id).method === 'Transcode' ? 1 : 0);
        ranks.set(source.Id, rank);
        return { source: source, index: index, rank: rank };
      })
      .sort(function (a, b) {
        return a.rank - b.rank || a.index - b.index;
      })
      .map(function (entry) {
        return entry.source;
      });

    const ready = await readyInfo;
    if (ready && ready[0]) {
      warmSourceIds = new Set(Object.keys(ready[0]).map(normalizeId));
      const tiers = {};
      Object.keys(ready[1] || {}).forEach(function (id) { tiers[normalizeId(id)] = ready[1][id]; });
      if (isPreferReadyEnabled()) {
        sources = preferReadySource(
          sources,
          isSourceReady,
          function (source) { return tiers[normalizeId(source.Id)]; },
          function (source) { return ranks.get(source.Id) || 0; },
        );
      }
    }

    if (!opts.forceChoice && isRememberStreamEnabled()) {
      const remembered = readRememberedSources()[item.Id];
      const rememberedId = remembered && remembered.mediaSourceId;
      const rememberedSource = rememberedId && sources.find(function (source) {
        return source.Id === rememberedId && !isBadSource(item.Id, source);
      });
      const editionMatches = !opts.edition || (rememberedSource && detectSourceEdition(rememberedSource, sources) === opts.edition);
      if (rememberedSource && editionMatches) {
        closeStreamPicker();
        navigateTo(playHash(item.Id, rememberedId));
        return;
      }
    }
  }

  if (document.getElementById(OVERLAY_ID) !== shell.overlay) return;

  const overlay = shell.overlay;
  shell.status.remove();
  overlay.classList.remove('jellio-stream-picker-overlay-status');

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

  const resumeTicks = sources.length && item.UserData && item.UserData.PlaybackPositionTicks;
  if (resumeTicks) {
    const resumeButton = el('button', 'jellio-stream-picker-resume', 'Resume from ' + formatResumeLabel(resumeTicks));
    resumeButton.type = 'button';
    resumeButton.addEventListener('click', function () {
      const remembered = readRememberedSources()[item.Id];
      const rememberedId = remembered && remembered.mediaSourceId;
      const stillOffered = rememberedId && sources.some(function (source) {
        return source.Id === rememberedId;
      });
      const candidates = selectedEdition
        ? sources.filter(function (s) { return detectSourceEdition(s, sources) === selectedEdition; })
        : sources;
      const targetId = stillOffered ? rememberedId : (candidates[0] && candidates[0].Id) || (sources[0] && sources[0].Id);
      closeStreamPicker();
      navigateTo(playHash(item.Id, targetId));
    });
    panel.appendChild(resumeButton);
  }

  const count = el('div', 'jellio-stream-picker-count');

  let selectedLanguage = null;
  let selectedQuality = null;
  const availableEditions = getAvailableEditions(sources);
  let selectedEdition = opts.edition && availableEditions.includes(opts.edition) ? opts.edition : null;
  const list = el('div', 'jellio-stream-picker-list');

  if (!sources.length) {
    const emptyFilterRow = el('div', 'jellio-stream-picker-filters');
    emptyFilterRow.appendChild(buildRefreshChip(refreshStreams));
    const allChip = el('button', 'jellio-stream-picker-filter-chip jellio-stream-picker-filter-chip-active', t('stream_all'));
    allChip.type = 'button';
    emptyFilterRow.appendChild(allChip);
    panel.appendChild(emptyFilterRow);

    const filterCard = buildDigitalReleaseFilterCard(refreshStreams);
    list.appendChild(filterCard);
    panel.appendChild(list);
    overlay.appendChild(panel);
    window.setTimeout(function () {
      try { filterCard.focus(); } catch (e) {}
    }, 50);
    return;
  }

  function renderList() {
    list.textContent = '';
    const filtered = filterSources(sources, selectedLanguage, selectedQuality, selectedEdition);
    count.textContent = filtered.length
      ? filtered.length + ' stream' + (filtered.length === 1 ? '' : 's') + ' found'
      : 'No streams match these filters';
    filtered.forEach(function (source) {
      const card = buildSourceCard(source, function (picked) {
        if (isRememberStreamEnabled()) rememberSourceChoice(item.Id, picked.Id);
        closeStreamPicker();
        navigateTo(playHash(item.Id, picked.Id));
      }, false, sources);
      const judged = methods.get(source.Id);
      if (judged) card.appendChild(buildOutlookBadge(playbackOutlook(judged.classification)));
      if (warmSourceIds) {
        const sourceReady = isSourceReady(source);
        card.title = t(sourceReady ? 'stream_ready_tip' : 'stream_cold_tip');
        if (sourceReady) card.appendChild(el('div', 'jellio-stream-picker-ready', '⚡ ' + t('stream_ready')));
      }
      if (isBadSource(item.Id, source)) {
        card.classList.add('jellio-stream-picker-card-bad');
        card.insertBefore(el('div', 'jellio-stream-picker-bad-note', '⚠ ' + t('stream_picker_not_played_recently')), card.firstChild);
      }
      list.appendChild(card);
    });
    const firstCard = list.querySelector('.jellio-stream-picker-card');
    if (firstCard) {
      window.setTimeout(function () {
        try { firstCard.focus(); } catch (e) {}
      }, 50);
    }
  }

  const editionRow = buildEditionFilterRow(sources, function (edition) {
    selectedEdition = edition;
    renderList();
  }, selectedEdition);
  if (editionRow) panel.appendChild(editionRow);

  const filterRow = buildLanguageFilterRow(sources, function (code) {
    selectedLanguage = code;
    renderList();
  });
  if (filterRow) {
    filterRow.insertBefore(buildRefreshChip(refreshStreams), filterRow.firstChild);
    panel.appendChild(filterRow);
  }
  const qualityRow = buildQualityFilterRow(sources, function (quality) {
    selectedQuality = quality;
    renderList();
  });
  if (qualityRow) panel.appendChild(qualityRow);

  panel.appendChild(count);
  renderList();
  panel.appendChild(list);

  overlay.appendChild(panel);
}
