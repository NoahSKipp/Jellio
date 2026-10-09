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

// Left, right or the rear surround pair, through Web Audio. Resolves to
// the AudioContext, or null when the sound plays as is (both sides, no
// Web Audio, or a context the browser won't start without a click).
function routeDirection(audio, direction, volume) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx || !direction || direction === 'both') return Promise.resolve(null);
  let ctx;
  try {
    ctx = new Ctx();
  } catch (err) {
    return Promise.resolve(null);
  }
  const ready = ctx.state === 'running' ? Promise.resolve() : ctx.resume();
  return ready
    .then(function () {
      if (ctx.state !== 'running') throw new Error('suspended');
      const source = ctx.createMediaElementSource(audio);
      const gain = ctx.createGain();
      gain.gain.value = volume;
      // Mono clips become two channels so each side has something to carry.
      gain.channelCount = 2;
      gain.channelCountMode = 'explicit';
      gain.channelInterpretation = 'speakers';
      source.connect(gain);
      if (direction === 'rear' && ctx.destination.maxChannelCount >= 6) {
        ctx.destination.channelCount = 6;
        ctx.destination.channelCountMode = 'explicit';
        ctx.destination.channelInterpretation = 'discrete';
        const splitter = ctx.createChannelSplitter(2);
        const merger = ctx.createChannelMerger(6);
        gain.connect(splitter);
        // 5.1 order: front L, front R, center, LFE, rear L, rear R.
        splitter.connect(merger, 0, 4);
        splitter.connect(merger, 1, 5);
        merger.connect(ctx.destination);
      } else if (direction === 'left' || direction === 'right') {
        const panner = ctx.createStereoPanner();
        panner.pan.value = direction === 'left' ? -1 : 1;
        gain.connect(panner);
        panner.connect(ctx.destination);
      } else {
        gain.connect(ctx.destination);
      }
      audio.volume = 1;
      return ctx;
    })
    .catch(function () {
      ctx.close().catch(function () {});
      return null;
    });
}

function playNext() {
  if (playing || !queue.length) return;
  const sound = queue.shift();
  playing = true;
  const audio = new Audio();
  // Web Audio only hears a cross-origin clip fetched with CORS.
  try {
    if (new URL(soundUrl(sound.SoundId), window.location.href).origin !== window.location.origin) audio.crossOrigin = 'anonymous';
  } catch (err) {}
  audio.src = soundUrl(sound.SoundId);
  const volume = Math.min(1, Math.max(0, sound.Volume / 100));
  audio.volume = volume;
  let ducked = [];
  let finished = false;
  let context = null;
  const guard = window.setTimeout(function () {
    audio.pause();
    finish();
  }, MAX_SOUND_MS);
  function finish() {
    if (finished) return;
    finished = true;
    window.clearTimeout(guard);
    if (context) context.close().catch(function () {});
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
  routeDirection(audio, sound.Direction, volume)
    .then(function (ctx) {
      context = ctx;
      if (finished) return undefined;
      return audio.play();
    })
    .catch(function (err) {
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
