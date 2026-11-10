// Sources and episodes side panels.
// Built by screens/player.js; live is its playerLive accessor object.

import {
  avoidingVideoTranscodes,
  classifySource,
  getVideoTranscodePolicy,
  playbackOutlook,
} from '../../runtime/transcodePolicy.js';
import {
  buildLanguageFilterRow,
  buildOutlookBadge,
  buildQualityFilterRow,
  buildSourceCard,
  filterSources,
} from '../streamPicker.js';
import { buildRatingBadge } from '../ratingBadge.js';
import { canBrowserDirectPlay, getEpisodes, getImageUrl, getSeasons } from '../../runtime/api.js';
import { cssUrl } from '../../runtime/safeUrl.js';
import { el } from '../../runtime/dom.js';
import { navigateTo } from '../../runtime/router.js';
import { t } from '../../runtime/i18n.js';
import { videoInfoOf } from '../../runtime/transcodeClassifier.js';

export function buildSidePanels(deps, live) {
  const {
    closePopovers, episodesButton, isEpisodeItem, itemId, root, shell, showPlayerToast, sourceButton,
    switchSource, wakeControls,
  } = deps;

  const sourcePanel = el('div', 'jellio-player-sidepanel jellio-player-sidepanel-hidden');
  const sourcePanelHeader = el('div', 'jellio-player-sidepanel-header');
  sourcePanelHeader.appendChild(el('div', 'jellio-player-sidepanel-title', t('player_sources')));
  const sourceCloseButton = el('button', 'jellio-player-sidepanel-close', t('action_close'));
  sourceCloseButton.type = 'button';
  sourcePanelHeader.appendChild(sourceCloseButton);
  sourcePanel.appendChild(sourcePanelHeader);
  const sourceFilterContainer = el('div', 'jellio-player-sidepanel-filters');
  sourcePanel.appendChild(sourceFilterContainer);
  const sourceList = el('div', 'jellio-player-sidepanel-list');
  sourcePanel.appendChild(sourceList);

  let selectedSourceLanguage = null;
  let selectedSourceQuality = null;

  function closeSidePanels() {
    sourcePanel.classList.add('jellio-player-sidepanel-hidden');
    episodesPanel.classList.add('jellio-player-sidepanel-hidden');
    sourceButton.setAttribute('aria-expanded', 'false');
    episodesButton.setAttribute('aria-expanded', 'false');
    if (shell) shell.scrollLeft = 0;
    if (root) root.scrollLeft = 0;
    wakeControls();
  }

  function rebuildSourceFilter() {
    sourceFilterContainer.textContent = '';
    selectedSourceLanguage = null;
    const filterRow = buildLanguageFilterRow(live.sourceOptions, function (code) {
      selectedSourceLanguage = code;
      rebuildSourceMenu();
    });
    if (filterRow) sourceFilterContainer.appendChild(filterRow);
    selectedSourceQuality = null;
    const qualityRow = buildQualityFilterRow(live.sourceOptions, function (quality) {
      selectedSourceQuality = quality;
      rebuildSourceMenu();
    });
    if (qualityRow) sourceFilterContainer.appendChild(qualityRow);
  }

  function rebuildSourceMenu() {
    sourceList.textContent = '';
    const blocking = getVideoTranscodePolicy() === 'Block';
    const filtered = filterSources(live.sourceOptions, selectedSourceLanguage, selectedSourceQuality)
      .map(function (source, index) {
        const judged = avoidingVideoTranscodes() && videoInfoOf(source) ? classifySource(source, canBrowserDirectPlay(source)) : null;
        return {
          source: source,
          verdict: judged && judged.needsVideoTranscode ? judged : null,
          outlook: judged ? playbackOutlook(judged) : null,
          index: index,
        };
      })
      .sort(function (a, b) {
        return (a.verdict ? 1 : 0) - (b.verdict ? 1 : 0) || a.index - b.index;
      });
    filtered.forEach(function (entry) {
      const source = entry.source;
      const verdict = entry.verdict;
      const card = buildSourceCard(
        source,
        function (picked) {
          if (verdict && blocking && picked.Id !== live.mediaSource.Id) {
            showPlayerToast(t('player_reencode_blocked'));
            return;
          }
          closeSidePanels();
          if (picked.Id !== live.mediaSource.Id) switchSource(picked);
        },
        source.Id === live.mediaSource.Id,
      );
      const outlook = entry.outlook;
      if (outlook) card.insertBefore(buildOutlookBadge(outlook), card.children[1] || null);
      if (verdict) {
        card.classList.add(blocking ? 'jellio-player-source-blocked' : 'jellio-player-source-warn');
        if (blocking) card.setAttribute('aria-disabled', 'true');
      }
      sourceList.appendChild(card);
    });
  }

  sourceButton.addEventListener('click', function () {
    closePopovers(null);
    const willOpen = sourcePanel.classList.contains('jellio-player-sidepanel-hidden');
    episodesPanel.classList.add('jellio-player-sidepanel-hidden');
    episodesButton.setAttribute('aria-expanded', 'false');
    if (willOpen) {
      sourcePanel.classList.remove('jellio-player-sidepanel-hidden');
      sourceButton.setAttribute('aria-expanded', 'true');
    } else {
      sourcePanel.classList.add('jellio-player-sidepanel-hidden');
      sourceButton.setAttribute('aria-expanded', 'false');
    }
    wakeControls();
  });
  sourceCloseButton.addEventListener('click', function (e) {
    e.stopPropagation();
    closeSidePanels();
  });

  const episodesPanel = el('div', 'jellio-player-sidepanel jellio-player-sidepanel-hidden');
  const episodesPanelHeader = el('div', 'jellio-player-sidepanel-header');
  episodesPanelHeader.appendChild(el('div', 'jellio-player-sidepanel-title', t('player_episodes')));
  const episodesCloseButton = el('button', 'jellio-player-sidepanel-close', t('action_close'));
  episodesCloseButton.type = 'button';
  episodesPanelHeader.appendChild(episodesCloseButton);
  episodesPanel.appendChild(episodesPanelHeader);
  const seasonTabs = el('div', 'jellio-player-sidepanel-tabs');
  episodesPanel.appendChild(seasonTabs);
  const episodeList = el('div', 'jellio-player-sidepanel-list');
  episodesPanel.appendChild(episodeList);
  episodesCloseButton.addEventListener('click', function (e) {
    e.stopPropagation();
    closeSidePanels();
  });

  function buildEpisodeRow(episode) {
    const row = el('button', 'jellio-player-episode-row' + (episode.Id === itemId ? ' jellio-player-episode-row-active' : ''));
    row.type = 'button';
    const thumbTag = (episode.ImageTags && episode.ImageTags.Primary) || episode.ParentThumbImageTag;
    const thumb = el('div', 'jellio-player-episode-thumb');
    if (thumbTag) {
      thumb.style.backgroundImage = cssUrl(getImageUrl(episode.Id, 'Primary', { tag: thumbTag, maxWidth: 400 }));
    }
    if (episode.CommunityRating) {
      thumb.appendChild(buildRatingBadge(episode.CommunityRating, 'jellio-player-episode-rating'));
    }
    const hasCode = typeof episode.ParentIndexNumber === 'number' && typeof episode.IndexNumber === 'number';
    if (hasCode) {
      thumb.appendChild(el('span', 'jellio-player-episode-code', 'S' + episode.ParentIndexNumber + 'E' + episode.IndexNumber));
    }
    row.appendChild(thumb);
    const body = el('div', 'jellio-player-episode-body');
    body.appendChild(el('div', 'jellio-player-episode-title', episode.Name || ''));
    if (episode.Overview) {
      body.appendChild(el('p', 'jellio-player-episode-overview', episode.Overview));
    }
    row.appendChild(body);
    row.addEventListener('click', function () {
      if (episode.Id === itemId) {
        closeSidePanels();
        return;
      }
      navigateTo('#/play?id=' + episode.Id);
    });
    return row;
  }

  // Only the latest season asked for fills the list: an earlier answer
  // arriving late used to be appended to it as well.
  let episodeListRequest = 0;
  function loadSeasonEpisodes(seriesId, season, tabButton) {
    Array.prototype.forEach.call(seasonTabs.children, function (child) {
      child.classList.remove('jellio-player-sidepanel-tab-active');
    });
    if (tabButton) tabButton.classList.add('jellio-player-sidepanel-tab-active');
    episodeList.textContent = '';
    const request = ++episodeListRequest;
    getEpisodes(seriesId, season.Id)
      .then(function (episodes) {
        if (request !== episodeListRequest) return;
        episodeList.textContent = '';
        episodes.forEach(function (episode) {
          episodeList.appendChild(buildEpisodeRow(episode));
        });
        revealCurrentEpisode();
      })
      .catch(function (err) {
        console.warn('Jellio: could not load episodes for player episode panel', err);
      });
  }

  function isSpecialsSeason(season) {
    if (season.IndexNumber === 0) return true;
    return /special/i.test(season.Name || '');
  }

  if (isEpisodeItem && live.item.SeriesId) {
    getSeasons(live.item.SeriesId)
      .then(function (seasons) {
        if (!seasons.length) return;
        episodesButton.disabled = false;
        const orderedSeasons = seasons.slice().sort(function (a, b) {
          return (isSpecialsSeason(a) ? 1 : 0) - (isSpecialsSeason(b) ? 1 : 0);
        });
        let currentSeasonLoaded = false;
        orderedSeasons.forEach(function (season) {
          const tab = el('button', 'jellio-player-sidepanel-tab', season.Name || '');
          tab.type = 'button';
          tab.addEventListener('click', function () {
            loadSeasonEpisodes(live.item.SeriesId, season, tab);
          });
          seasonTabs.appendChild(tab);
          if (season.Id === live.item.SeasonId) {
            currentSeasonLoaded = true;
            loadSeasonEpisodes(live.item.SeriesId, season, tab);
          }
        });
        if (!currentSeasonLoaded && orderedSeasons[0]) {
          loadSeasonEpisodes(live.item.SeriesId, orderedSeasons[0], seasonTabs.firstChild);
        }
      })
      .catch(function (err) {
        console.warn('Jellio: could not load seasons for player episode panel', err);
      });
  }

  // The playing episode (highlighted) and its season tab scrolled into
  // view whenever the panel is open.
  function revealCurrentEpisode() {
    if (episodesPanel.classList.contains('jellio-player-sidepanel-hidden')) return;
    const activeTab = seasonTabs.querySelector('.jellio-player-sidepanel-tab-active');
    if (activeTab && seasonTabs) {
      const targetLeft = activeTab.offsetLeft - (seasonTabs.clientWidth / 2) + (activeTab.offsetWidth / 2);
      seasonTabs.scrollTo({ left: Math.max(0, targetLeft), behavior: 'auto' });
    }
    const activeRow = episodeList.querySelector('.jellio-player-episode-row-active');
    if (activeRow && episodeList) {
      const targetTop = activeRow.offsetTop - (episodeList.clientHeight / 2) + (activeRow.offsetHeight / 2);
      episodeList.scrollTo({ top: Math.max(0, targetTop), behavior: 'auto' });
    }
  }

  episodesButton.addEventListener('click', function () {
    closePopovers(null);
    const willOpen = episodesPanel.classList.contains('jellio-player-sidepanel-hidden');
    sourcePanel.classList.add('jellio-player-sidepanel-hidden');
    sourceButton.setAttribute('aria-expanded', 'false');
    if (willOpen) {
      episodesPanel.classList.remove('jellio-player-sidepanel-hidden');
      episodesButton.setAttribute('aria-expanded', 'true');
      window.requestAnimationFrame(revealCurrentEpisode);
    } else {
      episodesPanel.classList.add('jellio-player-sidepanel-hidden');
      episodesButton.setAttribute('aria-expanded', 'false');
    }
    wakeControls();
  });
  return { sourcePanel, episodesPanel, closeSidePanels, rebuildSourceMenu, rebuildSourceFilter };
}
