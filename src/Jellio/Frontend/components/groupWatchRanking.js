// The active Group Watch decision session: a real single elimination
// bracket (Services/GroupWatchRankingService.cs's own header explains
// the format), built from every current group member's own pooled
// Grouplist. Shared by components/groupWatch.js's own chat view and
// screens/player.js's own in-player chat, same real reason both already
// duplicate their own chat poll loop independently rather than sharing
// one timer: this rides each caller's own existing poll tick instead of
// starting a second timer of its own, renderRankingSession() below is a
// pure render call each caller's own poll() already makes room for
// right where it renders new chat messages.
//
// Participant user ids: a group's own real Participants array
// (runtime/syncPlay.js's own GroupInfoDto, confirmed against real
// source) is a plain list of display names, no user id of its own.
// components/groupWatch.js's own publicUsersByName (built off
// getPublicUsers(), the exact same real lookup its own member chips
// already use to find an avatar) is the one place those names already
// resolve to a real user id, so callers pass the resolved list in
// rather than this file trying to re-derive it a second time.
import { getRankingSession, startRankingSession, voteRankingSession, getItem, getImageUrl } from '../runtime/api.js';
import { el } from '../runtime/dom.js';

export function buildPickTrigger(onStart) {
  const button = el('button', 'jellio-pick-trigger');
  button.type = 'button';
  const icon = el('span', 'material-icons how_to_vote');
  icon.setAttribute('aria-hidden', 'true');
  button.appendChild(icon);
  button.appendChild(el('span', null, 'Start a Pick'));
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

// Real bug, found live while adding the countdown above: a setInterval
// tied to a container the reader had already navigated away from (Back
// to the group list, or the whole Group Watch panel closed outright)
// kept ticking forever, orphaned, the exact same class of leak an
// earlier real audit already found and fixed elsewhere in this
// codebase. Callers own calling this the moment their own chat/ranking
// view actually closes, the same real discipline components/
// groupWatch.js's own stopChatPoll() already applies to its own chat
// poll timer right alongside this one.
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

// Real feedback found live: a poster fetched once and cached (getItem()
// is already cached per item id, this file's own header on why that is
// safe to call freely) is not the real bottleneck a whole bracket's
// worth of items up front would be. Only the current round's own pairs
// are ever actually fetched, the exact same one-round-at-a-time real
// cost a reader actually sees on screen.
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
      poster.style.backgroundImage = "url('" + getImageUrl(artId, 'Primary', { maxWidth: 300 }) + "')";
      const title = el('div', 'jellio-pick-option-title', (item && item.Name) || 'Unknown title');
      poster.appendChild(title);
    })
    .catch(function () {
      poster.appendChild(el('div', 'jellio-pick-option-title', 'Unknown title'));
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

// Rebuilds container from scratch whenever it is actually called
// (components/groupWatch.js's own pollRanking() now skips calling this
// at all once a poll tick's own session matches what is already on
// screen, its own header explains why), same real discipline
// components/groupWatch.js's own renderMembers() already uses rather
// than trying to diff a real bracket's own round-to-round state by
// hand. Hidden outright once nothing is actually active: the finished
// state's own real announcement already lives in chat itself (the
// winner watch-card GroupWatchRankingService.cs's own
// ResolveRoundIfDue posts), nothing left here worth a reader's own
// attention once that has happened.
//
// The countdown below is its own real setInterval, deliberately not
// tied to the poll tick that calls this function at all: real feedback
// asked to actually see GroupWatchRankingService.cs's own flat per
// round timer counting down, and that poll tick fires only every
// CHAT_POLL_MS (components/groupWatch.js), skipped outright besides
// once nothing has changed, nowhere near once a second. Ticks off this
// reader's own local clock against the real RoundDeadlineUtc the server
// already sent, close enough for a countdown nobody is timing to the
// millisecond; stored on the container itself (the one real object
// both this call and the next one actually share) so a fresh call
// always clears whatever the last one started before it tears the DOM
// carrying it down, same real belt this file's own header already
// documents elsewhere in this codebase for a singleton timer.
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
