// Sounds an admin sends from the dashboard (Controllers/SoundsController.cs):
// no toast, the clip just plays, and any video or audiobook on the page is
// turned down to the sound's DuckVolume until it ends.
import { isAuthenticated, getServerAddress, getAccessToken } from '../runtime/auth.js';
import { getPendingSounds } from '../runtime/api.js';
import { beginDuck, endDuck } from '../runtime/duck.js';

const POLL_MS = 5000;
// A clip that stalls can't keep other media turned down past this.
const MAX_SOUND_MS = 90000;

let started = false;
let after = -1;
let queue = [];
let playing = false;

function soundUrl(id) {
  return getServerAddress() + '/Jellio/sounds/file/' + encodeURIComponent(id) + '?ApiKey=' + encodeURIComponent(getAccessToken() || '');
}

function duckMedia(own, level) {
  const ducked = [];
  document.querySelectorAll('video, audio').forEach(function (media) {
    if (media === own || media.paused) return;
    const original = media.volume;
    const lowered = original * level;
    media.volume = lowered;
    ducked.push({ media: media, original: original, lowered: media.volume });
  });
  return ducked;
}

function restoreMedia(ducked) {
  ducked.forEach(function (entry) {
    // Left alone if the reader changed the volume meanwhile.
    if (Math.abs(entry.media.volume - entry.lowered) < 0.001) entry.media.volume = entry.original;
  });
}

function playNext() {
  if (playing || !queue.length) return;
  const sound = queue.shift();
  playing = true;
  const audio = new Audio(soundUrl(sound.SoundId));
  audio.volume = Math.min(1, Math.max(0, sound.Volume / 100));
  let ducked = [];
  let finished = false;
  const guard = window.setTimeout(function () {
    audio.pause();
    finish();
  }, MAX_SOUND_MS);
  function finish() {
    if (finished) return;
    finished = true;
    window.clearTimeout(guard);
    restoreMedia(ducked);
    endDuck();
    playing = false;
    playNext();
  }
  beginDuck();
  audio.addEventListener('ended', finish);
  audio.addEventListener('error', finish);
  audio.addEventListener('playing', function () {
    if (!ducked.length && sound.DuckVolume < 100) ducked = duckMedia(audio, sound.DuckVolume / 100);
  }, { once: true });
  audio.play().catch(function (err) {
    console.warn('Jellio: could not play a sent sound', err);
    finish();
  });
}

function poll() {
  if (!isAuthenticated()) {
    window.setTimeout(poll, POLL_MS);
    return;
  }
  if (document.hidden) {
    window.setTimeout(poll, POLL_MS);
    return;
  }
  getPendingSounds(after)
    .then(function (data) {
      const first = after < 0;
      if (data && typeof data.Latest === 'number') after = data.Latest;
      if (!first && data && data.Sounds && data.Sounds.length) {
        queue = queue.concat(data.Sounds);
        playNext();
      }
    })
    .catch(function () {})
    .then(function () {
      window.setTimeout(poll, POLL_MS);
    });
}

export function startSounds() {
  if (started || !isAuthenticated()) return;
  started = true;
  poll();
}
