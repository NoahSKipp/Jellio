// Audiobook player for Jellyfin AudioBook items. Jellyfin keeps one item
// per file and tracks resume position natively per file, so this screen
// stitches the book's files into one timeline (or uses the optional
// AudiobookLibrary plugin's own timeline when installed), plays them in
// sequence through one <audio> element, and reports playback per file
// the normal Jellyfin way so resume and played state stay native.
import {
  getItemDetails,
  getAudiobookTracks,
  getAudiobookLibraryChapters,
  buildAudioStreamUrl,
  getImageUrl,
  reportPlaybackStart,
  reportPlaybackProgress,
  reportPlaybackStopped,
  TICKS_PER_SECOND,
} from '../runtime/api.js';
import { navigateTo, setTitle } from '../runtime/router.js';
import { renderLoading, renderRetry } from '../components/networkState.js';
import { invalidateHomeSections } from './home.js';
import { el } from '../runtime/dom.js';

const SKIP_SECONDS = 30;
const PROGRESS_REPORT_MS = 10000;
const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
const SLEEP_OPTIONS = [0, 15, 30, 45, 60, -1]; // minutes, -1 = end of chapter
// Jumping back to the previous chapter from more than this far into the
// current one restarts the current chapter instead, like most players.
const RESTART_CHAPTER_THRESHOLD = 5;

function formatClock(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
}

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

function writeValue(key, value) {
  try {
    window.localStorage.setItem(key, String(value));
  } catch (err) {
    // Storage blocked: speed just won't be remembered.
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
  return null;
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
    console.warn('Jellio: could not open audiobook', err);
    renderRetry(root, 'Could not open this audiobook.', function () {
      renderListen(root, params);
    });
    return;
  }

  if (!timeline.tracks.length) {
    renderRetry(root, 'This audiobook has no playable files.', function () {
      renderListen(root, params);
    });
    return;
  }

  const bookTitle = item.Album || item.Name || 'Audiobook';
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
  const backSkipButton = iconButton('replay_30', 'Back ' + SKIP_SECONDS + ' seconds');
  const playButton = iconButton('play_arrow', 'Play', 'jellio-listen-play');
  const forwardSkipButton = iconButton('forward_30', 'Forward ' + SKIP_SECONDS + ' seconds');
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

  const audio = document.createElement('audio');
  audio.preload = 'auto';
  root.appendChild(audio);

  let trackIndex = -1;
  let pendingOffset = 0;
  let pendingPlay = false;
  let usingFallback = false;
  let reportedTrackId = null;
  let progressTimer = null;
  let sleepMinutes = 0;
  let sleepDeadline = null;
  let sleepEndOfChapter = null;
  let sleepTicker = null;
  let scrubbing = false;
  let tornDown = false;
  let speed = readNumber(speedKey, 1);
  if (SPEEDS.indexOf(speed) === -1) speed = 1;

  function currentTrack() {
    return timeline.tracks[trackIndex];
  }

  function bookTime() {
    const entry = currentTrack();
    return entry ? entry.startSec + (audio.currentTime || 0) : 0;
  }

  function chapterIndexAt(seconds) {
    let found = 0;
    timeline.chapters.forEach(function (chapter, index) {
      if (seconds + 0.25 >= chapter.startSec) found = index;
    });
    return found;
  }

  function positionTicks() {
    return Math.floor((audio.currentTime || 0) * TICKS_PER_SECOND);
  }

  function startReport() {
    const entry = currentTrack();
    if (!entry) return;
    reportedTrackId = entry.item.Id;
    reportPlaybackStart(reportedTrackId, reportedTrackId, positionTicks());
  }

  function stopReport(finishedTrack) {
    if (!reportedTrackId) return;
    const entry = currentTrack();
    const ticks = finishedTrack && entry ? Math.floor(entry.durationSec * TICKS_PER_SECOND) : positionTicks();
    reportPlaybackStopped(reportedTrackId, reportedTrackId, ticks);
    reportedTrackId = null;
  }

  function loadTrack(index, offset, autoplay) {
    const entry = timeline.tracks[index];
    if (!entry) return;
    if (index !== trackIndex) stopReport(false);
    trackIndex = index;
    pendingOffset = offset || 0;
    pendingPlay = autoplay;
    usingFallback = false;
    audio.src = buildAudioStreamUrl(entry.item.Id, false);
    audio.load();
  }

  function seekBook(seconds, autoplay) {
    const target = Math.min(Math.max(0, seconds), Math.max(0, timeline.durationSec - 0.5));
    let index = timeline.tracks.length - 1;
    for (let i = 0; i < timeline.tracks.length; i += 1) {
      const entry = timeline.tracks[i];
      if (target < entry.startSec + entry.durationSec) {
        index = i;
        break;
      }
    }
    const offset = target - timeline.tracks[index].startSec;
    const play = autoplay === undefined ? !audio.paused : autoplay;
    if (index === trackIndex && audio.readyState > 0) {
      audio.currentTime = offset;
      paintPosition();
    } else {
      loadTrack(index, offset, play);
    }
  }

  function paintPosition() {
    const now = bookTime();
    if (!scrubbing) scrub.value = String(Math.floor(now));
    elapsedLabel.textContent = formatClock(now);
    remainingLabel.textContent = '-' + formatClock(timeline.durationSec - now);
    const chapter = timeline.chapters[chapterIndexAt(now)];
    chapterLabel.textContent = chapter ? chapter.title : '';
    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && timeline.durationSec > 0) {
      try {
        navigator.mediaSession.setPositionState({
          duration: timeline.durationSec,
          playbackRate: audio.playbackRate || 1,
          position: Math.min(now, timeline.durationSec),
        });
      } catch (err) {
        // Some browsers reject a position state mid track change.
      }
    }
  }

  function paintPlayState() {
    const playing = !audio.paused;
    playButton.textContent = '';
    playButton.appendChild(el('span', 'material-icons ' + (playing ? 'pause' : 'play_arrow')));
    playButton.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    playButton.title = playing ? 'Pause' : 'Play';
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }

  function paintSpeed() {
    speedButton.textContent = '';
    speedButton.appendChild(el('span', 'material-icons speed'));
    speedButton.appendChild(el('span', null, speed + '×'));
    speedButton.setAttribute('aria-label', 'Playback speed ' + speed + 'x');
  }

  function paintSleep() {
    sleepButton.textContent = '';
    sleepButton.appendChild(el('span', 'material-icons bedtime'));
    let label = 'Sleep';
    if (sleepEndOfChapter !== null) label = 'End of chapter';
    else if (sleepDeadline) label = formatClock((sleepDeadline - Date.now()) / 1000);
    sleepButton.appendChild(el('span', null, label));
    sleepButton.classList.toggle('jellio-listen-pill-active', sleepEndOfChapter !== null || !!sleepDeadline);
  }

  function togglePlay() {
    if (audio.paused) {
      audio.play().catch(function (err) {
        console.warn('Jellio: audiobook playback did not start', err);
      });
    } else {
      audio.pause();
    }
  }

  function jumpChapter(delta) {
    const now = bookTime();
    const current = chapterIndexAt(now);
    let target = current + delta;
    if (delta < 0 && now - timeline.chapters[current].startSec > RESTART_CHAPTER_THRESHOLD) target = current;
    target = Math.min(timeline.chapters.length - 1, Math.max(0, target));
    seekBook(timeline.chapters[target].startSec);
  }

  audio.addEventListener('loadedmetadata', function () {
    if (pendingOffset > 0) {
      try {
        audio.currentTime = pendingOffset;
      } catch (err) {
        console.warn('Jellio: could not seek audiobook track', err);
      }
    }
    pendingOffset = 0;
    audio.playbackRate = speed;
    startReport();
    paintPosition();
    if (pendingPlay) {
      audio.play().catch(function (err) {
        // Autoplay without a user gesture can be refused; the play button
        // is right there.
        console.warn('Jellio: audiobook autoplay was blocked', err);
      });
    }
  });

  audio.addEventListener('error', function () {
    const entry = currentTrack();
    if (!entry || usingFallback || tornDown) return;
    // The browser could not decode the original file: ask Jellyfin for MP3.
    usingFallback = true;
    const offset = audio.currentTime || pendingOffset;
    pendingOffset = offset;
    audio.src = buildAudioStreamUrl(entry.item.Id, true);
    audio.load();
  });

  audio.addEventListener('timeupdate', function () {
    paintPosition();
    if (sleepEndOfChapter !== null && bookTime() >= timeline.chapters[sleepEndOfChapter].endSec - 0.3) {
      sleepEndOfChapter = null;
      sleepMinutes = 0;
      audio.pause();
      paintSleep();
    }
  });

  audio.addEventListener('play', paintPlayState);
  audio.addEventListener('pause', function () {
    paintPlayState();
    if (reportedTrackId) reportPlaybackProgress(reportedTrackId, reportedTrackId, positionTicks(), true);
  });

  audio.addEventListener('ended', function () {
    stopReport(true);
    if (trackIndex < timeline.tracks.length - 1) {
      loadTrack(trackIndex + 1, 0, true);
    } else {
      paintPlayState();
    }
  });

  progressTimer = window.setInterval(function () {
    if (reportedTrackId && !audio.paused) {
      reportPlaybackProgress(reportedTrackId, reportedTrackId, positionTicks(), false);
    }
  }, PROGRESS_REPORT_MS);

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
    seekBook(bookTime() - SKIP_SECONDS);
  });
  forwardSkipButton.addEventListener('click', function () {
    seekBook(bookTime() + SKIP_SECONDS);
  });
  prevChapterButton.addEventListener('click', function () {
    jumpChapter(-1);
  });
  nextChapterButton.addEventListener('click', function () {
    jumpChapter(1);
  });

  speedButton.addEventListener('click', function () {
    speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    audio.playbackRate = speed;
    writeValue(speedKey, speed);
    paintSpeed();
  });

  function clearSleep() {
    sleepDeadline = null;
    sleepEndOfChapter = null;
    if (sleepTicker) {
      window.clearInterval(sleepTicker);
      sleepTicker = null;
    }
  }

  sleepButton.addEventListener('click', function () {
    const next = SLEEP_OPTIONS[(SLEEP_OPTIONS.indexOf(sleepMinutes) + 1) % SLEEP_OPTIONS.length];
    sleepMinutes = next;
    clearSleep();
    if (next === -1) {
      sleepEndOfChapter = chapterIndexAt(bookTime());
    } else if (next > 0) {
      sleepDeadline = Date.now() + next * 60000;
      sleepTicker = window.setInterval(function () {
        if (sleepDeadline && Date.now() >= sleepDeadline) {
          audio.pause();
          sleepMinutes = 0;
          clearSleep();
        }
        paintSleep();
      }, 1000);
    }
    paintSleep();
  });

  function paintChapters() {
    chaptersPanel.textContent = '';
    chaptersPanel.appendChild(el('h2', 'jellio-listen-panel-title', 'Chapters'));
    const current = chapterIndexAt(bookTime());
    timeline.chapters.forEach(function (chapter, index) {
      const row = el('button', 'jellio-listen-chapter-row' + (index === current ? ' jellio-listen-chapter-row-active' : ''));
      row.type = 'button';
      row.appendChild(el('span', 'jellio-listen-chapter-name', chapter.title));
      row.appendChild(el('span', 'jellio-listen-chapter-time', formatClock(chapter.startSec)));
      row.addEventListener('click', function () {
        seekBook(chapter.startSec, true);
        chaptersPanel.classList.add('jellio-listen-panel-hidden');
      });
      chaptersPanel.appendChild(row);
    });
  }

  chaptersButton.addEventListener('click', function () {
    const opening = chaptersPanel.classList.contains('jellio-listen-panel-hidden');
    if (opening) paintChapters();
    chaptersPanel.classList.toggle('jellio-listen-panel-hidden', !opening);
  });

  function handleKey(event) {
    if (event.target && /INPUT|TEXTAREA|SELECT/.test(event.target.tagName) && event.target !== scrub) return;
    if (event.key === ' ' || event.key === 'k') {
      event.preventDefault();
      togglePlay();
    } else if (event.key === 'ArrowLeft') {
      seekBook(bookTime() - SKIP_SECONDS);
    } else if (event.key === 'ArrowRight') {
      seekBook(bookTime() + SKIP_SECONDS);
    } else if (event.key === 'Escape') {
      chaptersPanel.classList.add('jellio-listen-panel-hidden');
    }
  }
  document.addEventListener('keydown', handleKey);

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: bookTitle,
        artist: author,
        artwork: cover ? [{ src: cover, sizes: '600x600' }] : [],
      });
    } catch (err) {
      // MediaMetadata missing in older browsers: lock screen just shows less.
    }
    const handlers = {
      play: function () {
        audio.play();
      },
      pause: function () {
        audio.pause();
      },
      seekbackward: function () {
        seekBook(bookTime() - SKIP_SECONDS);
      },
      seekforward: function () {
        seekBook(bookTime() + SKIP_SECONDS);
      },
      previoustrack: function () {
        jumpChapter(-1);
      },
      nexttrack: function () {
        jumpChapter(1);
      },
      seekto: function (details) {
        if (details && typeof details.seekTime === 'number') seekBook(details.seekTime);
      },
    };
    Object.keys(handlers).forEach(function (action) {
      try {
        navigator.mediaSession.setActionHandler(action, handlers[action]);
      } catch (err) {
        // Action not supported by this browser.
      }
    });
  }

  paintSpeed();
  paintSleep();
  paintPlayState();

  const resume = resumePoint(timeline);
  loadTrack(resume.index, resume.offset, false);

  return function cleanup() {
    tornDown = true;
    stopReport(false);
    window.clearInterval(progressTimer);
    clearSleep();
    document.removeEventListener('keydown', handleKey);
    if ('mediaSession' in navigator) {
      ['play', 'pause', 'seekbackward', 'seekforward', 'previoustrack', 'nexttrack', 'seekto'].forEach(function (action) {
        try {
          navigator.mediaSession.setActionHandler(action, null);
        } catch (err) {
          // Not supported, nothing to clear.
        }
      });
    }
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    invalidateHomeSections();
  };
}
