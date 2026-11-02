import { el } from '../runtime/dom.js';
import { TICKS_PER_SECOND, getImageUrl } from '../runtime/api.js';
import { t } from '../runtime/i18n.js';
import { navigateTo } from '../runtime/router.js';

export function buildUpNextOverlay(episode, onPlayNow, onDismiss) {
  const overlay = el('div', 'jellio-player-upnext jellio-player-upnext-hidden');

  const thumbTag = (episode.ImageTags && episode.ImageTags.Primary) || episode.ParentThumbImageTag;
  const thumb = el('div', 'jellio-player-upnext-thumb');
  if (thumbTag) {
    thumb.style.backgroundImage = 'url(' + getImageUrl(episode.Id, 'Primary', { tag: thumbTag, maxWidth: 400 }) + ')';
  }
  overlay.appendChild(thumb);

  const body = el('div', 'jellio-player-upnext-body');
  body.appendChild(el('div', 'jellio-player-upnext-eyebrow', t('player_next_episode')));
  const epLabel =
    episode.IndexNumber != null && episode.ParentIndexNumber != null
      ? 'S' + episode.ParentIndexNumber + ' E' + episode.IndexNumber + ' · '
      : '';
  body.appendChild(el('div', 'jellio-player-upnext-title', epLabel + (episode.Name || '')));

  const actions = el('div', 'jellio-player-upnext-actions');
  const playButton = el('button', 'jellio-player-upnext-play', t('player_play_now'));
  playButton.type = 'button';
  playButton.addEventListener('click', onPlayNow);
  const dismissButton = el('button', 'jellio-player-upnext-dismiss', t('player_dismiss'));
  dismissButton.type = 'button';
  dismissButton.setAttribute('aria-label', t('player_dismiss_upnext'));
  dismissButton.addEventListener('click', onDismiss);
  actions.appendChild(playButton);
  actions.appendChild(dismissButton);
  body.appendChild(actions);
  overlay.appendChild(body);

  return { overlay: overlay, playButton: playButton };
}

export function buildEndScreenModal(options) {
  const item = options.item;
  const nextEpisode = options.nextEpisode;
  const onPlayNext = options.onPlayNext;
  const onReplay = options.onReplay;
  const onClose = options.onClose;
  const onBack = options.onBack;
  let countdownSecs = options.initialCountdown;

  const overlay = el('div', 'jellio-player-endscreen');
  const backdrop = el('div', 'jellio-player-endscreen-backdrop');
  backdrop.addEventListener('click', onClose);
  overlay.appendChild(backdrop);

  const card = el('div', 'jellio-player-endscreen-card');

  const closeButton = el('button', 'jellio-player-endscreen-close');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', t('player_close_endscreen'));
  const closeIcon = el('span', 'material-icons', 'close');
  closeIcon.setAttribute('aria-hidden', 'true');
  closeButton.appendChild(closeIcon);
  closeButton.addEventListener('click', onClose);
  card.appendChild(closeButton);

  const header = el('div', 'jellio-player-endscreen-header');
  const badge = el('div', 'jellio-player-endscreen-badge');
  const badgeIcon = el('span', 'material-icons', nextEpisode ? 'skip_next' : 'check_circle');
  badgeIcon.setAttribute('aria-hidden', 'true');
  badge.appendChild(badgeIcon);
  badge.appendChild(el('span', '', nextEpisode ? 'Up Next' : 'Completed'));
  header.appendChild(badge);

  const seriesTitle = (nextEpisode && (nextEpisode.SeriesName || item.SeriesName)) || (item.Type === 'Episode' ? item.SeriesName : null);
  if (seriesTitle) {
    header.appendChild(el('div', 'jellio-player-endscreen-series', seriesTitle));
  }
  card.appendChild(header);

  const content = el('div', 'jellio-player-endscreen-content');

  const targetItem = nextEpisode || item;
  const thumbTag = (targetItem.ImageTags && (targetItem.ImageTags.Primary || targetItem.ImageTags.Thumb)) ||
                   targetItem.ParentThumbImageTag ||
                   (targetItem.BackdropImageTags && targetItem.BackdropImageTags[0]);

  const thumb = el('div', 'jellio-player-endscreen-thumb');
  if (thumbTag) {
    const imgType = (targetItem.ImageTags && targetItem.ImageTags.Primary) ? 'Primary' :
                    (targetItem.BackdropImageTags && targetItem.BackdropImageTags[0]) ? 'Backdrop' : 'Thumb';
    thumb.style.backgroundImage = 'url(' + getImageUrl(targetItem.Id, imgType, { tag: thumbTag, maxWidth: 640 }) + ')';
  }

  if (targetItem.RunTimeTicks) {
    const mins = Math.round(targetItem.RunTimeTicks / (TICKS_PER_SECOND * 60));
    if (mins > 0) {
      thumb.appendChild(el('span', 'jellio-player-endscreen-duration', mins + ' min'));
    }
  }
  content.appendChild(thumb);

  const info = el('div', 'jellio-player-endscreen-info');
  if (nextEpisode) {
    const epLabel = (nextEpisode.ParentIndexNumber != null && nextEpisode.IndexNumber != null)
      ? 'Season ' + nextEpisode.ParentIndexNumber + ' · Episode ' + nextEpisode.IndexNumber
      : '';
    if (epLabel) {
      info.appendChild(el('div', 'jellio-player-endscreen-sub', epLabel));
    }
    info.appendChild(el('h2', 'jellio-player-endscreen-title', nextEpisode.Name || 'Next Episode'));
    if (nextEpisode.Overview) {
      info.appendChild(el('p', 'jellio-player-endscreen-overview', nextEpisode.Overview));
    }
  } else {
    info.appendChild(el('h2', 'jellio-player-endscreen-title', item.Name || 'Completed'));
    const sub = item.Type === 'Episode'
      ? (item.SeriesName ? item.SeriesName + ' · Season Finale' : 'Season Finale')
      : (item.ProductionYear ? String(item.ProductionYear) : 'Feature Film');
    info.appendChild(el('div', 'jellio-player-endscreen-sub', sub));
    if (item.Overview) {
      info.appendChild(el('p', 'jellio-player-endscreen-overview', item.Overview));
    }
  }
  content.appendChild(info);
  card.appendChild(content);

  const actions = el('div', 'jellio-player-endscreen-actions');
  let primaryBtn = null;
  let countdownTimer = null;

  if (nextEpisode) {
    primaryBtn = el('button', 'jellio-player-endscreen-btn jellio-player-endscreen-btn-primary');
    primaryBtn.type = 'button';
    const playIcon = el('span', 'material-icons', 'play_arrow');
    playIcon.setAttribute('aria-hidden', 'true');
    primaryBtn.appendChild(playIcon);
    const playText = el('span', 'jellio-player-endscreen-btn-text', t('player_play_next_episode'));
    primaryBtn.appendChild(playText);

    function updateBtnCountdown() {
      if (countdownSecs > 0) {
        playText.textContent = t('player_play_next_episode') + ' (' + countdownSecs + ')';
      } else {
        playText.textContent = t('player_play_next_episode');
      }
    }

    if (countdownSecs > 0) {
      updateBtnCountdown();
      countdownTimer = window.setInterval(function () {
        countdownSecs -= 1;
        updateBtnCountdown();
        if (countdownSecs <= 0) {
          if (countdownTimer) {
            window.clearInterval(countdownTimer);
            countdownTimer = null;
          }
          onPlayNext();
        }
      }, 1000);
    }

    primaryBtn.addEventListener('click', function () {
      if (countdownTimer) {
        window.clearInterval(countdownTimer);
        countdownTimer = null;
      }
      onPlayNext();
    });
    actions.appendChild(primaryBtn);

    const replayBtn = el('button', 'jellio-player-endscreen-btn jellio-player-endscreen-btn-secondary');
    replayBtn.type = 'button';
    const replayIcon = el('span', 'material-icons', 'replay');
    replayIcon.setAttribute('aria-hidden', 'true');
    replayBtn.appendChild(replayIcon);
    replayBtn.appendChild(el('span', '', t('player_replay')));
    replayBtn.addEventListener('click', function () {
      if (countdownTimer) {
        window.clearInterval(countdownTimer);
        countdownTimer = null;
      }
      onReplay();
    });
    actions.appendChild(replayBtn);

    const backBtn = el('button', 'jellio-player-endscreen-btn jellio-player-endscreen-btn-ghost');
    backBtn.type = 'button';
    const backIcon = el('span', 'material-icons', item.SeriesId ? 'arrow_back' : 'home');
    backIcon.setAttribute('aria-hidden', 'true');
    backBtn.appendChild(backIcon);
    backBtn.appendChild(el('span', '', item.SeriesId ? 'Back to Show' : 'Back to Home'));
    backBtn.addEventListener('click', function () {
      if (countdownTimer) {
        window.clearInterval(countdownTimer);
        countdownTimer = null;
      }
      onBack();
    });
    actions.appendChild(backBtn);
  } else {
    primaryBtn = el('button', 'jellio-player-endscreen-btn jellio-player-endscreen-btn-primary');
    primaryBtn.type = 'button';
    const replayIcon = el('span', 'material-icons', 'replay');
    replayIcon.setAttribute('aria-hidden', 'true');
    primaryBtn.appendChild(replayIcon);
    primaryBtn.appendChild(el('span', '', t('player_replay')));
    primaryBtn.addEventListener('click', onReplay);
    actions.appendChild(primaryBtn);

    const backBtn = el('button', 'jellio-player-endscreen-btn jellio-player-endscreen-btn-secondary');
    backBtn.type = 'button';
    const backIcon = el('span', 'material-icons', item.SeriesId ? 'arrow_back' : 'home');
    backIcon.setAttribute('aria-hidden', 'true');
    backBtn.appendChild(backIcon);
    backBtn.appendChild(el('span', '', item.SeriesId ? 'Back to Show' : 'Back to Home'));
    backBtn.addEventListener('click', onBack);
    actions.appendChild(backBtn);
  }

  card.appendChild(actions);
  overlay.appendChild(card);

  card.addEventListener('click', function (e) {
    if (primaryBtn && !primaryBtn.contains(e.target) && countdownTimer) {
      window.clearInterval(countdownTimer);
      countdownTimer = null;
      const playText = primaryBtn.querySelector('.jellio-player-endscreen-btn-text');
      if (playText) playText.textContent = t('player_play_next_episode');
    }
  });

  function cleanup() {
    if (countdownTimer) {
      window.clearInterval(countdownTimer);
      countdownTimer = null;
    }
    overlay.remove();
  }

  return {
    overlay: overlay,
    primaryBtn: primaryBtn,
    cleanup: cleanup,
  };
}

export function buildResumePrompt(percent, onResume, onRestart) {
  const overlay = el('div', 'jellio-player-resume-overlay');
  const panel = el('div', 'jellio-player-resume-panel');
  panel.appendChild(el('div', 'jellio-player-resume-title', t('player_resume_prompt')));
  if (percent != null) {
    panel.appendChild(el('div', 'jellio-player-resume-subtitle', percent + '% watched'));
  }
  const actions = el('div', 'jellio-player-resume-actions');
  const resumeButton = el('button', 'jellio-player-resume-play', t('player_resume'));
  resumeButton.type = 'button';
  resumeButton.addEventListener('click', onResume);
  const restartButton = el('button', 'jellio-player-resume-restart', t('player_start_over'));
  restartButton.type = 'button';
  restartButton.addEventListener('click', onRestart);
  actions.appendChild(resumeButton);
  actions.appendChild(restartButton);
  panel.appendChild(actions);
  overlay.appendChild(panel);
  return { overlay: overlay, resumeButton: resumeButton };
}

export function renderPlaybackError(root, itemId, message, onRetry) {
  root.textContent = '';
  const wrap = el('div', 'jellio-player-error');
  wrap.appendChild(el('p', 'jellio-service-empty', message));
  const actions = el('div', 'jellio-screen-retry-actions');
  if (onRetry) {
    const retry = el('button', 'jellio-player-error-back', t('action_retry'));
    retry.type = 'button';
    retry.addEventListener('click', onRetry);
    actions.appendChild(retry);
  }
  const back = el('button', 'jellio-player-error-back', t('onboarding_back'));
  back.type = 'button';
  back.addEventListener('click', function () {
    navigateTo(itemId ? '#/item?id=' + itemId : '#/home');
  });
  actions.appendChild(back);
  wrap.appendChild(actions);
  root.appendChild(wrap);
}
