import { t } from '../runtime/i18n.js';
import { getRankingSession, startRankingSession } from '../runtime/apiSocial.js';
import { getItem, getImageUrl } from '../runtime/api.js';
import { el } from '../runtime/dom.js';
import { cssUrl } from '../runtime/safeUrl.js';

export function buildPickTrigger(onStart) {
  const button = el('button', 'jellio-pick-trigger');
  button.type = 'button';
  const icon = el('span', 'material-icons how_to_vote');
  icon.setAttribute('aria-hidden', 'true');
  button.appendChild(icon);
  button.appendChild(el('span', null, t('gw_start_pick')));
  button.addEventListener('click', function () {
    button.disabled = true;
    onStart()
      .catch(function (err) {
        console.warn('Jellio: could not start a Group Watch pick', err);
      })
      .finally(function () {
        button.disabled = false;
      });
  });
  return button;
}

export function stopRankingCountdown(container) {
  if (container && container._jellioPickCountdownTimer) {
    window.clearInterval(container._jellioPickCountdownTimer);
    container._jellioPickCountdownTimer = null;
  }
}

export function fetchRankingSession(groupId) {
  return getRankingSession(groupId).catch(function () {
    return null;
  });
}

export function startPick(groupId, participantUserIds) {
  return startRankingSession(groupId, participantUserIds);
}

function buildOption(itemId, isPicked, isDisabled, onPick) {
  const option = el('button', 'jellio-pick-option' + (isPicked ? ' jellio-pick-option-picked' : ''));
  option.type = 'button';
  option.disabled = isDisabled;

  const poster = el('div', 'jellio-pick-option-poster');
  option.appendChild(poster);

  if (isPicked) {
    const badge = el('span', 'jellio-pick-option-badge');
    const badgeIcon = el('span', 'material-icons check');
    badgeIcon.setAttribute('aria-hidden', 'true');
    badge.appendChild(badgeIcon);
    option.appendChild(badge);
  }

  getItem(itemId)
    .then(function (item) {
      const isEpisode = item && item.Type === 'Episode';
      const artId = isEpisode && item.SeriesId ? item.SeriesId : itemId;
      poster.style.backgroundImage = cssUrl(getImageUrl(artId, 'Primary', { maxWidth: 300 }));
      const title = el('div', 'jellio-pick-option-title', (item && item.Name) || 'Unknown title');
      poster.appendChild(title);
    })
    .catch(function () {
      poster.appendChild(el('div', 'jellio-pick-option-title', t('gw_unknown_title')));
    });

  option.addEventListener('click', function () {
    onPick(itemId);
  });

  return option;
}

function buildPairCard(pair, currentUserId, onPick) {
  const myVote = pair.Votes && pair.Votes[currentUserId];
  const card = el('div', 'jellio-pick-pair');
  const options = el('div', 'jellio-pick-options');
  options.appendChild(buildOption(pair.ItemA, myVote === pair.ItemA, !!myVote, onPick));
  if (pair.ItemB) {
    const vs = el('div', 'jellio-pick-vs', 'VS');
    options.appendChild(vs);
    options.appendChild(buildOption(pair.ItemB, myVote === pair.ItemB, !!myVote, onPick));
  }
  card.appendChild(options);
  return card;
}

export function renderRankingSession(container, session, currentUserId, onVote) {
  if (container._jellioPickCountdownTimer) {
    window.clearInterval(container._jellioPickCountdownTimer);
    container._jellioPickCountdownTimer = null;
  }
  container.textContent = '';
  if (!session || session.Status === 'Finished') {
    return;
  }

  const card = el('div', 'jellio-pick-card');
  const head = el('div', 'jellio-pick-head');
  const eyebrow = el('div', 'jellio-pick-eyebrow');
  const eyebrowIcon = el('span', 'material-icons how_to_vote');
  eyebrowIcon.setAttribute('aria-hidden', 'true');
  eyebrow.appendChild(eyebrowIcon);
  eyebrow.appendChild(el('span', null, 'Round ' + session.Round));
  head.appendChild(eyebrow);

  const countdownLabel = el('span', 'jellio-pick-countdown-label');
  const countdownTrack = el('div', 'jellio-pick-countdown');
  const countdownFill = el('div', 'jellio-pick-countdown-fill');
  countdownTrack.appendChild(countdownFill);
  head.appendChild(countdownTrack);
  head.appendChild(countdownLabel);
  card.appendChild(head);

  (session.Pairs || []).forEach(function (pair) {
    card.appendChild(
      buildPairCard(pair, currentUserId, function (itemId) {
        onVote(itemId);
      }),
    );
  });

  container.appendChild(card);

  const deadlineMs = new Date(session.RoundDeadlineUtc).getTime();
  const totalMs = Math.max(1, (session.RoundLengthSeconds || 45) * 1000);
  function tickCountdown() {
    const remainingMs = deadlineMs - Date.now();
    const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
    countdownLabel.textContent =
      remainingSeconds > 0 ? 'Auto-picks in ' + remainingSeconds + 's' : 'Picking…';
    countdownFill.style.transform = 'scaleX(' + Math.max(0, Math.min(1, remainingMs / totalMs)) + ')';
    if (remainingMs <= 0) {
      window.clearInterval(container._jellioPickCountdownTimer);
      container._jellioPickCountdownTimer = null;
    }
  }
  tickCountdown();
  container._jellioPickCountdownTimer = window.setInterval(tickCountdown, 1000);
}
