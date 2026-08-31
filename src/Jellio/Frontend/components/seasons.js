// Four real occasions (Halloween, New Year's, Valentine's, Christmas),
// replacing the old catalogue of three dozen themes ported
// wholesale from CodeDevMLH/Jellyfin-Seasonals: real feedback was that
// flooding the page with falling emoji read as spam rather than a themed
// page, and asked specifically for a reskin (colours, background) rather
// than more particles. Every theme here does two real things: it sets
// css/app.css's own --jellio-season-* tokens (via a data-jellio-season
// attribute on #jellioRoot itself, so every descendant's var() lookup
// picks the new values up for free, --jellio-trending-color and
// --jellio-focus-color-rgb included, no other file needs to know a
// season is active), and it mounts a themed ambient layer positioned
// behind the real page rather than over it: css/app.css's own header on
// .jellio-seasons explains the z-index: -1 trick that makes that true.
import { getJellioConfig } from '../runtime/api.js';
import { el } from '../runtime/dom.js';

const THEME_ORDER = ['halloween', 'newyear', 'valentine', 'christmas'];

// A day-of-year range comparison that wraps New Year's: a plain
// start <= now <= end fails the moment a range (December into January,
// New Year's own default) crosses into a new calendar year.
function inRange(month, day, range) {
  if (!range) return false;
  const now = month * 100 + day;
  const start = range.StartMonth * 100 + range.StartDay;
  const end = range.EndMonth * 100 + range.EndDay;
  if (start <= end) return now >= start && now <= end;
  return now >= start || now <= end;
}

// Real, singular "what's active right now" against ConfigController.cs's
// own real response shape ({ SeasonalEffectsEnabled, SeasonalEffects:
// { <key>: { Enabled, Range } } }). First match in THEME_ORDER wins, so
// an admin who sets overlapping custom ranges still only ever sees one
// theme at a time rather than two stacked on top of each other.
export function activeSeasonalTheme(date, config) {
  if (!config || !config.SeasonalEffectsEnabled) return null;
  const effects = config.SeasonalEffects || {};
  const month = date.getMonth() + 1;
  const day = date.getDate();

  for (let i = 0; i < THEME_ORDER.length; i++) {
    const key = THEME_ORDER[i];
    const effect = effects[key];
    if (effect && effect.Enabled && inRange(month, day, effect.Range)) return key;
  }
  return null;
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function reduceMotion() {
  return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function buildWash(container) {
  container.appendChild(el('div', 'jellio-seasons-wash'));
}

function cssVar(container, name, fallback) {
  const value = getComputedStyle(container).getPropertyValue(name).trim();
  return value || fallback;
}

function buildFall(container, cls, count, opts) {
  for (let i = 0; i < count; i++) {
    const span = document.createElement('span');
    span.className = 'jellio-season-particle jellio-season-particle-fall ' + cls;
    if (opts.text) span.textContent = opts.text;
    span.style.left = rand(0, 100) + 'vw';
    span.style.setProperty('--jellio-season-sway', rand(-opts.sway, opts.sway) + 'px');
    if (opts.minSize) span.style.fontSize = rand(opts.minSize, opts.maxSize) + 'px';
    span.style.opacity = String(rand(opts.minOpacity, opts.maxOpacity));
    span.style.animationDuration = rand(opts.minDuration, opts.maxDuration) + 's';
    span.style.animationDelay = '-' + rand(0, opts.maxDuration) + 's';
    container.appendChild(span);
  }
}

// Fog breathing at the foot of the screen, a vignette that pulses like a
// held breath rather than sitting static, a pair of eyes that opens
// somewhere in the dark every so often and blinks out again, and bats
// mixed near/far so a couple read as close overhead rather than a
// uniform swarm.
function mountHalloween(container) {
  buildWash(container);
  if (reduceMotion()) return;

  container.appendChild(el('div', 'jellio-season-fog'));
  container.appendChild(el('div', 'jellio-season-flicker'));

  const eyes = el('div', 'jellio-season-eyes');
  eyes.style.left = rand(15, 80) + 'vw';
  eyes.style.top = rand(30, 70) + 'vh';
  eyes.style.animationDelay = '-' + rand(0, 14) + 's';
  eyes.innerHTML = '<span></span><span></span>';
  container.appendChild(eyes);

  for (let i = 0; i < 8; i++) {
    const near = i < 2;
    const bat = document.createElement('span');
    bat.className = 'jellio-season-bat';
    bat.textContent = '\u{1F987}';
    bat.style.left = rand(0, 90) + 'vw';
    bat.style.setProperty('--jellio-season-dx', rand(-30, -60) + 'vw');
    bat.style.animationDuration = (near ? rand(9, 13) : rand(15, 24)) + 's';
    bat.style.animationDelay = '-' + rand(0, 20) + 's';
    bat.style.fontSize = (near ? rand(26, 34) : rand(12, 18)) + 'px';
    bat.style.opacity = near ? '0.55' : '0.32';
    container.appendChild(bat);
  }
}

// A canvas particle burst, the one theme here that genuinely cannot be a
// CSS-only span (an expanding, fading ring of dots from a random point
// needs real per-frame physics), fired every second or two, sometimes
// two at once, spread across the top half of the screen rather than one
// fixed corner, each with a brief sparkle trail as it fades. Colours
// read straight off the same tokens css/app.css just set, so a firework
// and the sidebar's own recoloured badges never fall out of sync.
function runFireworks(canvas, container) {
  const ctx = canvas.getContext('2d');
  const colors = [
    cssVar(container, '--jellio-season-accent', '#d4af37'),
    cssVar(container, '--jellio-season-accent-2', '#eef0f5'),
  ];
  let width = 0;
  let height = 0;
  let frameId = null;
  let bursts = [];

  function resize() {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  function spawn() {
    const x = rand(width * 0.08, width * 0.92);
    const y = rand(height * 0.08, height * 0.5);
    const color = colors[Math.floor(Math.random() * colors.length)];
    const count = Math.floor(rand(26, 36));
    const particles = [];
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + rand(-0.1, 0.1);
      const speed = rand(1.2, 3.6);
      particles.push({ x: x, y: y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: 1, trail: Math.random() < 0.35 });
    }
    bursts.push({ particles: particles, color: color });
  }

  let spawnTimer = null;
  function spawnLoop() {
    if (!canvas.isConnected) return;
    spawn();
    if (Math.random() < 0.4) window.setTimeout(spawn, rand(120, 260));
    spawnTimer = window.setTimeout(spawnLoop, rand(900, 1900));
  }
  spawnTimer = window.setTimeout(spawnLoop, rand(200, 500));
  spawn();

  function tick() {
    ctx.clearRect(0, 0, width, height);
    bursts = bursts.filter(function (burst) {
      burst.particles.forEach(function (p) {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.015;
        p.life -= 0.012;
      });
      burst.particles.forEach(function (p) {
        if (p.life <= 0) return;
        ctx.globalAlpha = Math.max(p.life, 0);
        ctx.fillStyle = burst.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.trail ? 1.1 : 1.9, 0, Math.PI * 2);
        ctx.fill();
        if (p.trail && p.life > 0.15) {
          ctx.globalAlpha = Math.max(p.life, 0) * 0.35;
          ctx.beginPath();
          ctx.arc(p.x - p.vx * 1.6, p.y - p.vy * 1.6, 0.9, 0, Math.PI * 2);
          ctx.fill();
        }
      });
      ctx.globalAlpha = 1;
      return burst.particles.some(function (p) { return p.life > 0; });
    });
    frameId = window.requestAnimationFrame(tick);
  }
  tick();

  return function cleanup() {
    window.cancelAnimationFrame(frameId);
    window.clearTimeout(spawnTimer);
    window.removeEventListener('resize', resize);
  };
}

function mountNewYear(container) {
  buildWash(container);
  container.appendChild(el('div', 'jellio-season-shimmer'));
  if (reduceMotion()) return undefined;
  const canvas = document.createElement('canvas');
  canvas.className = 'jellio-season-canvas';
  container.appendChild(canvas);
  return runFireworks(canvas, container);
}

// Hearts drift up across the whole page now, not confined to one corner,
// plus a few larger blurred "bokeh" hearts for depth; still slow and low
// opacity, just a lot more of them than a single accent corner needs.
function mountValentine(container) {
  buildWash(container);
  if (reduceMotion()) return;

  for (let i = 0; i < 18; i++) {
    const big = i % 5 === 0;
    const heart = document.createElement('span');
    heart.className = 'jellio-season-particle jellio-season-particle-rise ' + (big ? 'jellio-season-heart-soft' : 'jellio-season-heart');
    heart.textContent = '♥';
    heart.style.left = rand(0, 96) + 'vw';
    heart.style.bottom = rand(-40, 0) + 'vh';
    heart.style.setProperty('--jellio-season-sway', rand(-28, 28) + 'px');
    heart.style.fontSize = (big ? rand(26, 38) : rand(12, 22)) + 'px';
    heart.style.opacity = big ? '0.22' : '0.42';
    heart.style.animationDuration = rand(10, 18) + 's';
    heart.style.animationDelay = '-' + rand(0, 18) + 's';
    container.appendChild(heart);
  }
}

// A thin string of fairy lights along the very top edge of the screen
// (twinkling on their own schedule, not tied to the snow below) plus
// sparse, slow snow across the whole page, a fifth the density of the
// old Snowfall theme's own canvas storm.
function mountChristmas(container) {
  buildWash(container);

  const lights = el('div', 'jellio-season-lights');
  for (let i = 0; i < 18; i++) {
    const dot = document.createElement('span');
    dot.style.background = i % 2 ? 'var(--jellio-season-accent-2)' : 'var(--jellio-season-accent)';
    dot.style.boxShadow = '0 0 6px ' + (i % 2 ? 'var(--jellio-season-accent-2)' : 'var(--jellio-season-accent)');
    dot.style.animationDelay = '-' + rand(0, 2.6) + 's';
    lights.appendChild(dot);
  }
  container.appendChild(lights);

  if (reduceMotion()) return;
  buildFall(container, 'jellio-season-flake', 22, {
    text: '❄', sway: 16, minSize: 9, maxSize: 15, minOpacity: 0.4, maxOpacity: 0.7, minDuration: 9, maxDuration: 16,
  });
}

const MOUNTERS = {
  halloween: mountHalloween,
  newyear: mountNewYear,
  valentine: mountValentine,
  christmas: mountChristmas,
};

let rootEl = null;
let mountedContainer = null;
let activeCleanup = null;
let activeTheme = null;

function teardownTheme() {
  if (activeCleanup) {
    activeCleanup();
    activeCleanup = null;
  }
  if (mountedContainer) mountedContainer.textContent = '';
  if (rootEl) delete rootEl.dataset.jellioSeason;
  activeTheme = null;
}

function applyTheme(theme) {
  if (theme === activeTheme) return;
  teardownTheme();
  if (!theme) return;
  activeTheme = theme;
  rootEl.dataset.jellioSeason = theme;
  activeCleanup = MOUNTERS[theme](mountedContainer) || null;
}

// runtime/api.js's own getJellioConfig() caches this for a few minutes
// (SHORT_CACHE_TTL_MS), so a periodic real refetch here is cheap and
// picks up whatever an admin just changed in the plugin's own
// dashboard within a few minutes, no reload required, without this
// file polling the network on every single one of these ticks.
async function refresh() {
  if (!mountedContainer) return;
  let config;
  try {
    config = await getJellioConfig();
  } catch (err) {
    console.warn('Jellio: could not load seasonal theme config', err);
    return;
  }
  applyTheme(activeSeasonalTheme(new Date(), config));
}

// Called once from app.js, right where it already sets up the real root
// shell (idempotent the same way components/sidebar.js's own dataset
// marker keeps its own real one-time build from repeating on every
// ordinary navigation), appended as a real child of #jellioRoot itself
// rather than document.body: css/app.css's own .jellio-root-fullscreen
// rule already hides this the same way the sidebar and mobile nav
// mounts do, no separate hashchange listener or any other real coupling
// to this runtime's own router needed.
export function mountSeasons(root) {
  if (mountedContainer) return;
  rootEl = root;
  mountedContainer = document.createElement('div');
  mountedContainer.className = 'jellio-seasons';
  root.appendChild(mountedContainer);
  refresh();
  // A reader who leaves this tab open across midnight (New Year's own
  // real edge case, or any other theme's own boundary), or across
  // whatever an admin just changed server side, still gets the right
  // real theme without a full reload.
  window.setInterval(refresh, 5 * 60 * 1000);
}
