// Audiobook player for Jellyfin AudioBook items. Jellyfin keeps one item
// per file and tracks resume position natively per file, so this screen
// stitches the book's files into one timeline (or uses the optional
// AudiobookLibrary plugin's own timeline when installed), plays them in
// sequence through one persistent audio session, and reports playback per file
// the normal Jellyfin way so resume and played state stay native.
import {
  getItemDetails,
  getAudiobookTracks,
  audiobookTitle,
  getAudiobookLibraryChapters,
  getImageUrl,
  getBookCoverUrl,
  TICKS_PER_SECOND,
} from '../runtime/api.js';
import { findDownload, getOfflineObjectUrl, getLocalProgress } from '../runtime/offline.js';
import { navigateTo, setTitle } from '../runtime/router.js';
import { renderLoading, renderRetry } from '../components/networkState.js';
import { invalidateHomeSections } from './home.js';
import { el } from '../runtime/dom.js';
import { showToast } from '../components/toast.js';
import {
  startAudioSession,
  getActiveAudioSession,
  setAudioSessionListeners,
  seekBook,
  togglePlay,
  jumpChapter,
  setAudioSpeed,
  setAudioSleep,
  getBookTime,
  chapterIndexAt,
  formatClock,
  loadTrack,
  getDefaultAudiobookSpeed,
  syncMiniPlayer,
} from '../components/audioMiniPlayer.js';

const SKIP_SECONDS_BACK = 15;
const SKIP_SECONDS_FORWARD = 30;
const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
const SLEEP_OPTIONS = [0, 15, 30, 45, 60, -1]; // minutes, -1 = end of chapter

function ticksToSeconds(ticks) {
  return (ticks || 0) / TICKS_PER_SECOND;
}

function iconButton(icon, label, className) {
  const button = el('button', 'jellio-listen-button' + (className ? ' ' + className : ''));
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.appendChild(el('span', 'material-icons ' + icon));
  return button;
}

function readNumber(key, fallback) {
  try {
    const value = Number(window.localStorage.getItem(key));
    return value > 0 ? value : fallback;
  } catch (err) {
    return fallback;
  }
}

// One timeline for the whole book: tracks laid end to end, chapters
// positioned on that same timeline in seconds.
function buildTimeline(tracks, pluginTimeline) {
  if (pluginTimeline) {
    const pluginTracks = pluginTimeline.Tracks || pluginTimeline.tracks || [];
    const pluginChapters = pluginTimeline.Chapters || pluginTimeline.chapters || [];
    const byId = new Map(
      tracks.map(function (track) {
        return [String(track.Id).replace(/-/g, ''), track];
      }),
    );
    const mappedTracks = pluginTracks
      .map(function (entry) {
        const item = byId.get(String(entry.ItemId || entry.itemId).replace(/-/g, ''));
        return item
          ? { item: item, startSec: entry.StartSec || entry.startSec || 0, durationSec: entry.DurationSec || entry.durationSec || 0 }
          : null;
      })
      .filter(Boolean);
    if (mappedTracks.length === pluginTracks.length && mappedTracks.length) {
      return {
        durationSec: pluginTimeline.DurationSec || pluginTimeline.durationSec || 0,
        tracks: mappedTracks,
        chapters: pluginChapters.map(function (chapter) {
          return {
            title: chapter.Title || chapter.title || '',
            startSec: chapter.StartSec || chapter.startSec || 0,
            endSec: chapter.EndSec || chapter.endSec || 0,
          };
        }),
      };
    }
  }

  let cursor = 0;
  const timelineTracks = tracks.map(function (track) {
    const entry = { item: track, startSec: cursor, durationSec: ticksToSeconds(track.RunTimeTicks) };
    cursor += entry.durationSec;
    return entry;
  });
  const durationSec = cursor;

  let chapters = [];
  if (timelineTracks.length === 1) {
    const embedded = (tracks[0].Chapters || []).slice().sort(function (a, b) {
      return (a.StartPositionTicks || 0) - (b.StartPositionTicks || 0);
    });
    chapters = embedded.map(function (chapter, index) {
      const next = embedded[index + 1];
      return {
        title: chapter.Name || 'Chapter ' + (index + 1),
        startSec: ticksToSeconds(chapter.StartPositionTicks),
        endSec: next ? ticksToSeconds(next.StartPositionTicks) : durationSec,
      };
    });
  } else {
    chapters = timelineTracks.map(function (entry, index) {
      return {
        title: entry.item.Name || 'Part ' + (index + 1),
        startSec: entry.startSec,
        endSec: entry.startSec + entry.durationSec,
      };
    });
  }
  if (!chapters.length) chapters = [{ title: 'Chapter 1', startSec: 0, endSec: durationSec }];
  return { durationSec: durationSec, tracks: timelineTracks, chapters: chapters };
}

// Where to pick up: the most recently played file that still has a
// resume position, else the first file not yet played, else the start.
function resumePoint(timeline) {
  let best = null;
  timeline.tracks.forEach(function (entry, index) {
    const userData = entry.item.UserData || {};
    if (userData.PlaybackPositionTicks > 0) {
      const lastPlayed = Date.parse(userData.LastPlayedDate || '') || 0;
      if (!best || lastPlayed > best.lastPlayed) {
        best = { index: index, offset: ticksToSeconds(userData.PlaybackPositionTicks), lastPlayed: lastPlayed };
      }
    }
  });
  if (best) return { index: best.index, offset: best.offset };
  const firstUnplayed = timeline.tracks.findIndex(function (entry) {
    return !(entry.item.UserData && entry.item.UserData.Played);
  });
  return { index: firstUnplayed === -1 ? 0 : firstUnplayed, offset: 0 };
}

function coverUrl(item) {
  if (item.ImageTags && item.ImageTags.Primary) {
    return getImageUrl(item.Id, 'Primary', { tag: item.ImageTags.Primary, maxWidth: 600 });
  }
  if (item.AlbumId && item.AlbumPrimaryImageTag) {
    return getImageUrl(item.AlbumId, 'Primary', { tag: item.AlbumPrimaryImageTag, maxWidth: 600 });
  }
  // Chaptarr's cover for the book; 404s when it has none.
  return getBookCoverUrl(item.Id);
}

export async function renderListen(root, params) {
  const itemId = params.get('id');
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-listen';
  if (!itemId) return;

  renderLoading(root, 'Opening audiobook…');

  let item;
  let timeline;
  try {
    item = await getItemDetails(itemId);
    const [tracks, pluginTimeline] = await Promise.all([getAudiobookTracks(item), getAudiobookLibraryChapters(itemId)]);
    timeline = buildTimeline(tracks, pluginTimeline);
  } catch (err) {
    // Offline and not downloaded ends up here too.
    console.warn('Jellio: could not open audiobook', err);
    renderRetry(root, 'Could not open this audiobook.', function () {
      renderListen(root, params);
    });
    return;
  }

  // A downloaded audiobook plays from this device (runtime/offline.js),
  // online or not: trackId -> object URL.
  const localTracks = {};
  const download = await findDownload(itemId).catch(() => null);
  if (download) {
    for (const entry of timeline.tracks) {
      const url = await getOfflineObjectUrl(download.Id, 'track-' + String(entry.item.Id).replace(/-/g, '').toLowerCase());
      if (url) localTracks[entry.item.Id] = url;
    }
  }

  if (!timeline.tracks.length) {
    renderRetry(root, 'This audiobook has no playable files.', function () {
      renderListen(root, params);
    });
    return;
  }

  const bookTitle = audiobookTitle(item, timeline.tracks.length) || 'Audiobook';
  const author = item.AlbumArtist || (item.Artists && item.Artists[0]) || '';
  const cover = coverUrl(item);
  const bookKey = String(item.ParentId || item.Id) + '|' + (item.Album || '');
  const speedKey = 'jellio-listen-speed:' + bookKey;
  setTitle(bookTitle + ' - Jellio');

  root.textContent = '';
  if (cover) root.style.setProperty('--listen-cover', 'url("' + cover + '")');
  root.appendChild(el('div', 'jellio-listen-backdrop'));

  const topbar = el('div', 'jellio-listen-topbar');
  const backButton = iconButton('arrow_back', 'Back');
  backButton.addEventListener('click', function () {
    navigateTo('#/item?id=' + itemId);
  });
  topbar.appendChild(backButton);
  root.appendChild(topbar);

  const main = el('div', 'jellio-listen-main');
  const art = el('div', 'jellio-listen-cover');
  if (cover) {
    const img = document.createElement('img');
    img.src = cover;
    img.alt = '';
    img.addEventListener('error', function () {
      img.replaceWith(el('span', 'material-icons headphones'));
      root.style.removeProperty('--listen-cover');
    });
    art.appendChild(img);
  } else {
    art.appendChild(el('span', 'material-icons headphones'));
  }
  main.appendChild(art);

  const meta = el('div', 'jellio-listen-meta');
  meta.appendChild(el('h1', 'jellio-listen-title', bookTitle));
  if (author) meta.appendChild(el('div', 'jellio-listen-author', author));
  const chapterLabel = el('div', 'jellio-listen-chapter', '');
  meta.appendChild(chapterLabel);
  main.appendChild(meta);

  const scrubWrap = el('div', 'jellio-listen-scrub');
  const scrubTrack = el('div', 'jellio-listen-scrub-track');
  const scrub = document.createElement('input');
  scrub.type = 'range';
  scrub.className = 'jellio-listen-scrub-input';
  scrub.min = '0';
  scrub.max = String(Math.max(1, Math.floor(timeline.durationSec)));
  scrub.step = '1';
  scrub.value = '0';
  scrub.setAttribute('aria-label', 'Position in book');
  scrubTrack.appendChild(scrub);
  if (timeline.durationSec > 0) {
    timeline.chapters.slice(1).forEach(function (chapter) {
      const tick = el('span', 'jellio-listen-scrub-tick');
      tick.style.left = (chapter.startSec / timeline.durationSec) * 100 + '%';
      scrubTrack.appendChild(tick);
    });
  }
  scrubWrap.appendChild(scrubTrack);
  const times = el('div', 'jellio-listen-times');
  const elapsedLabel = el('span', null, '0:00');
  const remainingLabel = el('span', null, '-' + formatClock(timeline.durationSec));
  times.appendChild(elapsedLabel);
  times.appendChild(remainingLabel);
  scrubWrap.appendChild(times);
  main.appendChild(scrubWrap);

  const transport = el('div', 'jellio-listen-transport');
  const prevChapterButton = iconButton('skip_previous', 'Previous chapter');
  const backSkipButton = iconButton('replay_15', 'Back ' + SKIP_SECONDS_BACK + ' seconds');
  const playButton = iconButton('play_arrow', 'Play', 'jellio-listen-play');
  const forwardSkipButton = iconButton('forward_30', 'Forward ' + SKIP_SECONDS_FORWARD + ' seconds');
  const nextChapterButton = iconButton('skip_next', 'Next chapter');
  [prevChapterButton, backSkipButton, playButton, forwardSkipButton, nextChapterButton].forEach(function (button) {
    transport.appendChild(button);
  });
  main.appendChild(transport);

  const extras = el('div', 'jellio-listen-extras');
  const speedButton = el('button', 'jellio-listen-pill');
  speedButton.type = 'button';
  const sleepButton = el('button', 'jellio-listen-pill');
  sleepButton.type = 'button';
  const chaptersButton = el('button', 'jellio-listen-pill');
  chaptersButton.type = 'button';
  chaptersButton.appendChild(el('span', 'material-icons list'));
  chaptersButton.appendChild(el('span', null, 'Chapters'));
  extras.appendChild(speedButton);
  extras.appendChild(sleepButton);
  extras.appendChild(chaptersButton);
  main.appendChild(extras);
  root.appendChild(main);

  const chaptersPanel = el('div', 'jellio-listen-panel jellio-listen-panel-hidden');
  root.appendChild(chaptersPanel);

  const existingSession = getActiveAudioSession();
  const isSameBook = existingSession && existingSession.itemId === itemId;

  let speed;
  if (isSameBook) {
    speed = existingSession.speed;
  } else {
    speed = readNumber(speedKey, getDefaultAudiobookSpeed());
    if (SPEEDS.indexOf(speed) === -1) speed = 1;
    startAudioSession({
      itemId: itemId,
      item: item,
      bookTitle: bookTitle,
      author: author,
      cover: cover,
      timeline: timeline,
      localTracks: localTracks,
      download: download,
      speed: speed,
      speedKey: speedKey,
    });
  }

  let scrubbing = false;

  function paintPosition() {
    const now = getBookTime();
    if (!scrubbing) scrub.value = String(Math.floor(now));
    elapsedLabel.textContent = formatClock(now);
    remainingLabel.textContent = '-' + formatClock(timeline.durationSec - now);
    const chapter = timeline.chapters[chapterIndexAt(now)];
    chapterLabel.textContent = chapter ? chapter.title : '';
  }

  function paintPlayState(playingState) {
    const session = getActiveAudioSession();
    const playing = playingState !== undefined ? playingState : (session && session.audio && !session.audio.paused);
    playButton.textContent = '';
    playButton.appendChild(el('span', 'material-icons ' + (playing ? 'pause' : 'play_arrow')));
    playButton.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    playButton.title = playing ? 'Pause' : 'Play';
  }

  function paintSpeed() {
    const session = getActiveAudioSession();
    const curSpeed = session ? session.speed : speed;
    speedButton.textContent = '';
    speedButton.appendChild(el('span', 'material-icons speed'));
    speedButton.appendChild(el('span', null, curSpeed + '×'));
    speedButton.setAttribute('aria-label', 'Playback speed ' + curSpeed + 'x');
  }

  function paintSleep() {
    const session = getActiveAudioSession();
    sleepButton.textContent = '';
    sleepButton.appendChild(el('span', 'material-icons bedtime'));
    let label = 'Sleep';
    if (session) {
      if (session.sleepEndOfChapter !== null) label = 'End of chapter';
      else if (session.sleepDeadline) label = formatClock((session.sleepDeadline - Date.now()) / 1000);
      sleepButton.classList.toggle('jellio-listen-pill-active', session.sleepEndOfChapter !== null || !!session.sleepDeadline);
    }
    sleepButton.appendChild(el('span', null, label));
  }

  function cycleSpeed(delta) {
    const session = getActiveAudioSession();
    const curSpeed = session ? session.speed : speed;
    const currentIndex = SPEEDS.indexOf(curSpeed);
    let nextIndex = (currentIndex === -1 ? 1 : currentIndex) + (delta || 1);
    if (nextIndex >= SPEEDS.length) nextIndex = 0;
    if (nextIndex < 0) nextIndex = SPEEDS.length - 1;
    speed = SPEEDS[nextIndex];
    setAudioSpeed(speed);
    paintSpeed();
  }

  setAudioSessionListeners({
    onPosition: function () {
      paintPosition();
    },
    onPlayState: function (playing) {
      paintPlayState(playing);
    },
    onSpeed: function (s) {
      speed = s;
      paintSpeed();
    },
    onSleep: function () {
      paintSleep();
    },
  });

  scrub.addEventListener('input', function () {
    scrubbing = true;
    elapsedLabel.textContent = formatClock(Number(scrub.value));
    remainingLabel.textContent = '-' + formatClock(timeline.durationSec - Number(scrub.value));
  });
  scrub.addEventListener('change', function () {
    scrubbing = false;
    seekBook(Number(scrub.value));
  });

  playButton.addEventListener('click', togglePlay);
  backSkipButton.addEventListener('click', function () {
    seekBook(getBookTime() - SKIP_SECONDS_BACK);
  });
  forwardSkipButton.addEventListener('click', function () {
    seekBook(getBookTime() + SKIP_SECONDS_FORWARD);
  });
  prevChapterButton.addEventListener('click', function () {
    jumpChapter(-1);
  });
  nextChapterButton.addEventListener('click', function () {
    jumpChapter(1);
  });

  speedButton.addEventListener('click', function () {
    cycleSpeed(1);
  });

  sleepButton.addEventListener('click', function () {
    const session = getActiveAudioSession();
    const currentMins = session ? session.sleepMinutes : 0;
    const next = SLEEP_OPTIONS[(SLEEP_OPTIONS.indexOf(currentMins) + 1) % SLEEP_OPTIONS.length];
    setAudioSleep(next);
    paintSleep();
  });

  function paintChapters() {
    chaptersPanel.textContent = '';
    chaptersPanel.appendChild(el('h2', 'jellio-listen-panel-title', 'Chapters'));

    let filterText = '';
    const filterWrap = el('div', 'jellio-listen-chapter-filter-wrap');
    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'jellio-listen-chapter-filter-input';
    input.placeholder = 'Filter chapters (e.g. 5, Epilogue)…';
    input.autocomplete = 'off';
    input.spellcheck = false;
    filterWrap.appendChild(input);
    chaptersPanel.appendChild(filterWrap);

    const list = el('div', 'jellio-listen-chapter-list');
    chaptersPanel.appendChild(list);

    function renderChapterRows() {
      list.textContent = '';
      const query = filterText.trim().toLowerCase();
      const current = chapterIndexAt(getBookTime());
      let matchedCount = 0;
      let activeRow = null;

      timeline.chapters.forEach(function (chapter, index) {
        const titleStr = (chapter.title || '').toLowerCase();
        const matches = !query || titleStr.includes(query) || String(index + 1).includes(query);
        if (!matches) return;
        matchedCount++;

        const isCurrent = index === current;
        const row = el('button', 'jellio-listen-chapter-row' + (isCurrent ? ' jellio-listen-chapter-row-active' : ''));
        row.type = 'button';
        row.appendChild(el('span', 'jellio-listen-chapter-name', chapter.title));
        row.appendChild(el('span', 'jellio-listen-chapter-time', formatClock(chapter.startSec)));
        row.addEventListener('click', function () {
          seekBook(chapter.startSec, true);
          chaptersPanel.classList.add('jellio-listen-panel-hidden');
        });
        if (isCurrent) activeRow = row;
        list.appendChild(row);
      });

      if (!matchedCount) {
        list.appendChild(el('p', 'jellio-listen-empty', 'No matching chapters.'));
      } else if (activeRow && !query) {
        window.setTimeout(function () {
          try {
            activeRow.scrollIntoView({ block: 'center', behavior: 'smooth' });
          } catch (e) {}
        }, 50);
      }
    }

    input.addEventListener('input', function () {
      filterText = input.value;
      renderChapterRows();
    });

    renderChapterRows();
    window.setTimeout(function () {
      try { input.focus(); } catch (e) {}
    }, 50);
  }

  chaptersButton.addEventListener('click', function () {
    const opening = chaptersPanel.classList.contains('jellio-listen-panel-hidden');
    if (opening) paintChapters();
    chaptersPanel.classList.toggle('jellio-listen-panel-hidden', !opening);
  });

  function handleKey(event) {
    if (event.target && /INPUT|TEXTAREA|SELECT/.test(event.target.tagName) && event.target !== scrub) return;
    const session = getActiveAudioSession();
    if (event.key === ' ' || event.key === 'k') {
      event.preventDefault();
      togglePlay();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      seekBook(getBookTime() - SKIP_SECONDS_BACK);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      seekBook(getBookTime() + SKIP_SECONDS_FORWARD);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (session && session.audio) {
        session.audio.volume = Math.min(1, Math.round(((session.audio.volume || 1) + 0.1) * 10) / 10);
        showToast('Volume ' + Math.round(session.audio.volume * 100) + '%');
      }
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (session && session.audio) {
        session.audio.volume = Math.max(0, Math.round(((session.audio.volume || 1) - 0.1) * 10) / 10);
        showToast('Volume ' + Math.round(session.audio.volume * 100) + '%');
      }
    } else if (event.key === 'm' || event.key === 'M') {
      event.preventDefault();
      if (session && session.audio) {
        session.audio.muted = !session.audio.muted;
        showToast(session.audio.muted ? 'Muted' : 'Unmuted');
      }
    } else if (event.key === '[') {
      event.preventDefault();
      cycleSpeed(-1);
    } else if (event.key === ']') {
      event.preventDefault();
      cycleSpeed(1);
    } else if (event.key === 'Escape') {
      chaptersPanel.classList.add('jellio-listen-panel-hidden');
    }
  }
  document.addEventListener('keydown', handleKey);

  paintSpeed();
  paintSleep();
  paintPlayState();
  paintPosition();

  if (!isSameBook) {
    const resume = resumePoint(timeline);
    const localPosition = download ? await getLocalProgress(download.Id) : null;
    const localIndex = localPosition ? timeline.tracks.findIndex((entry) => entry.item.Id === localPosition.TrackId) : -1;
    const serverLatest = Math.max.apply(
      null,
      timeline.tracks.map((entry) => Date.parse((entry.item.UserData && entry.item.UserData.LastPlayedDate) || '') || 0),
    );
    if (localIndex !== -1 && Date.parse(localPosition.UpdatedAt) > serverLatest) {
      resume.index = localIndex;
      resume.offset = localPosition.Offset || 0;
    }
    loadTrack(resume.index, resume.offset, false);
  }

  // Hide mini player while in full listen screen
  syncMiniPlayer();

  return function cleanup() {
    setAudioSessionListeners(null);
    document.removeEventListener('keydown', handleKey);
    invalidateHomeSections();
    syncMiniPlayer();
  };
}
