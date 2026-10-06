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

// Halloween: the wash, fog, a breathing vignette and eyes in the dark,
// then hand drawn creatures (SVG, so they look the same on every device)
// all behind the page: bats that really flap, ghosts rising, spiders
// dropping on silk, flickering jack-o'-lanterns, cobwebs, a blood moon
// with the odd witch crossing it, embers and drifting skulls. Lightning
// is the one layer above the page: a flash that lights the whole screen
// and a forked bolt, every so often. Counts drop on a phone; with
// reduced motion only the wash stays.
const HALLOWEEN_ART = {
  bat: '<svg viewBox="0 0 64 34" aria-hidden="true"><g class="jellio-season-wing-r"><path d="M33 16C38 7 49 3 63 8C59 10 58 14 59 20C55 16 51 17 49 23C46 18 42 19 39 25C37 21 35 20 33 22Z" fill="#050308"/></g><g class="jellio-season-wing-l"><path d="M31 16C26 7 15 3 1 8C5 10 6 14 5 20C9 16 13 17 15 23C18 18 22 19 25 25C27 21 29 20 31 22Z" fill="#050308"/></g><path d="M27.5 9L26 1.5L30.5 6L32 4.5L33.5 6L38 1.5L36.5 9C37.5 12 37.5 17 35.5 22C34.5 26 33.2 29 32 33C30.8 29 29.5 26 28.5 22C26.5 17 26.5 12 27.5 9Z" fill="#050308"/><circle cx="30" cy="10.5" r="1" fill="#ff7518"/><circle cx="34" cy="10.5" r="1" fill="#ff7518"/></svg>',
  ghost: '<svg viewBox="0 0 60 72" aria-hidden="true"><defs><linearGradient id="jellio-season-ghost-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4f0ff"/><stop offset="1" stop-color="#b9a8ff" stop-opacity=".25"/></linearGradient></defs><path d="M30 2C14 2 5 15 5 32V68L13 59L21 69L30 59L39 69L47 59L55 68V32C55 15 46 2 30 2Z" fill="url(#jellio-season-ghost-fill)"/><path d="M5 40C-3 44-5 52 1 58C6 55 7 50 5 46Z M55 40C63 44 65 52 59 58C54 55 53 50 55 46Z" fill="#d8ccff" opacity=".6"/><ellipse cx="22" cy="28" rx="4" ry="6" fill="#1b1230"/><ellipse cx="38" cy="28" rx="4" ry="6" fill="#1b1230"/><ellipse cx="30" cy="43" rx="5" ry="7.5" fill="#1b1230"/></svg>',
  spider: '<svg viewBox="0 0 48 40" aria-hidden="true"><g class="jellio-season-legs" fill="none" stroke="#050308" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 20L10 8L2 14"/><path d="M22 23L7 18L1 28"/><path d="M22 26L8 30L4 39"/><path d="M23 28L14 36L12 40"/><path d="M26 20L38 8L46 14"/><path d="M26 23L41 18L47 28"/><path d="M26 26L40 30L44 39"/><path d="M25 28L34 36L36 40"/></g><ellipse cx="24" cy="26" rx="8.5" ry="10" fill="#050308"/><circle cx="24" cy="15" r="5" fill="#050308"/><path d="M21 28L24 24L27 28L24 31Z" fill="#c1121f"/><circle cx="22" cy="14" r="1" fill="#ff3b3b"/><circle cx="26" cy="14" r="1" fill="#ff3b3b"/></svg>',
  pumpkin: '<svg viewBox="0 0 80 72" aria-hidden="true"><defs><radialGradient id="jellio-season-pumpkin-fill" cx=".5" cy=".4" r=".7"><stop offset="0" stop-color="#ff9a2e"/><stop offset=".7" stop-color="#e2560a"/><stop offset="1" stop-color="#8f2a04"/></radialGradient></defs><path d="M37 14C36 8 38 4 43 1L46 4C43 6 43 9 44 14Z" fill="#3b4a14"/><ellipse cx="22" cy="43" rx="19" ry="25" fill="url(#jellio-season-pumpkin-fill)"/><ellipse cx="58" cy="43" rx="19" ry="25" fill="url(#jellio-season-pumpkin-fill)"/><ellipse cx="40" cy="43" rx="22" ry="27" fill="url(#jellio-season-pumpkin-fill)"/><path d="M40 16C33 28 33 58 40 70M24 20C14 32 14 56 24 66M56 20C66 32 66 56 56 66" fill="none" stroke="#7a2503" stroke-width="1.6" opacity=".55"/><g class="jellio-season-face"><path d="M23 34L33 40L21 44Z M57 34L47 40L59 44Z" fill="#ffd36b"/><path d="M40 46L36 53H44Z" fill="#ffd36b"/><path d="M22 53L26 58L31 55L35 61L40 56L45 61L49 55L54 58L58 53C54 66 26 66 22 53Z" fill="#ffd36b"/></g></svg>',
  skull: '<svg viewBox="0 0 48 56" aria-hidden="true"><path d="M24 2C11 2 3 11 3 23C3 31 7 36 12 39V48C12 51 14 53 17 53H31C34 53 36 51 36 48V39C41 36 45 31 45 23C45 11 37 2 24 2Z" fill="#e9e4d4"/><ellipse cx="16" cy="25" rx="6.5" ry="7.5" fill="#15101c"/><ellipse cx="32" cy="25" rx="6.5" ry="7.5" fill="#15101c"/><path d="M24 31L20 40H28Z" fill="#15101c"/><path d="M17 44V52M22 44V53M27 44V53M32 44V52" stroke="#15101c" stroke-width="1.6"/></svg>',
  witch: '<svg viewBox="0 0 120 60" aria-hidden="true"><path d="M2 46L98 32" stroke="#050308" stroke-width="3" stroke-linecap="round"/><path d="M96 26L119 19C117 28 117 38 119 47L96 38Z" fill="#050308"/><path d="M104 28L118 24M104 33L118 33M104 38L118 42" stroke="#2a1a38" stroke-width="1"/><path d="M52 15L60 -2L67 15Z" fill="#050308"/><ellipse cx="60" cy="15" rx="13" ry="3.2" fill="#050308"/><circle cx="60" cy="21" r="5.5" fill="#050308"/><path d="M54 25C48 32 49 38 58 40L74 36L66 25Z" fill="#050308"/><path d="M52 27C38 24 26 31 14 42L44 39Z" fill="#050308"/></svg>',
};

function halloweenArt(tag, cls, name) {
  const node = el(tag, cls);
  node.innerHTML = HALLOWEEN_ART[name];
  return node;
}

function cobwebSvg() {
  const rings = [34, 68, 102, 136, 168];
  const spokes = 6;
  const point = (r, i) => {
    const t = (i / (spokes - 1)) * (Math.PI / 2);
    return [r * Math.cos(t), r * Math.sin(t)];
  };
  let d = '';
  for (let i = 0; i < spokes; i++) {
    const [x, y] = point(170, i);
    d += 'M0 0L' + x.toFixed(1) + ' ' + y.toFixed(1);
  }
  rings.forEach(function (r) {
    const first = point(r, 0);
    d += 'M' + first[0].toFixed(1) + ' ' + first[1].toFixed(1);
    for (let i = 1; i < spokes; i++) {
      const a = point(r, i - 1);
      const b = point(r, i);
      d += 'Q' + (((a[0] + b[0]) / 2) * 0.8).toFixed(1) + ' ' + (((a[1] + b[1]) / 2) * 0.8).toFixed(1) + ' ' + b[0].toFixed(1) + ' ' + b[1].toFixed(1);
    }
  });
  return '<svg viewBox="0 0 170 170" aria-hidden="true"><path d="' + d + '" fill="none" stroke="#e9e4ff" stroke-width="1" stroke-linecap="round" opacity=".8"/></svg>';
}

// Lightning above the page: a violet white flash that stutters twice, a
// forked bolt drawn on a canvas, and a short shake of the page.
function mountHalloweenSky() {
  const sky = el('div', 'jellio-season-sky');
  const flash = el('div', 'jellio-season-flash');
  const canvas = document.createElement('canvas');
  canvas.className = 'jellio-season-bolt';
  sky.appendChild(flash);
  sky.appendChild(canvas);
  rootEl.appendChild(sky);
  const ctx = canvas.getContext('2d');
  const timers = [];
  let strikeTimer = null;
  let shape = [];

  function fit() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  fit();
  window.addEventListener('resize', fit);

  function fork(x1, y1, x2, y2, spread, out) {
    if (spread < 3) {
      out.push([x2, y2]);
      return;
    }
    const mx = (x1 + x2) / 2 + rand(-spread, spread);
    const my = (y1 + y2) / 2 + rand(-spread * 0.3, spread * 0.3);
    fork(x1, y1, mx, my, spread / 2, out);
    fork(mx, my, x2, y2, spread / 2, out);
  }
  function route(x1, y1, x2, y2, spread) {
    const points = [[x1, y1]];
    fork(x1, y1, x2, y2, spread, points);
    return points;
  }
  function line(points, width, alpha) {
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
    ctx.lineWidth = width;
    ctx.strokeStyle = 'rgba(235,225,255,' + alpha + ')';
    ctx.stroke();
  }
  function draw(alpha) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!alpha) return;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(150,110,255,1)';
    ctx.shadowBlur = 30;
    shape.forEach((points, i) => line(points, i === 0 ? 6 : 3, alpha * 0.5));
    ctx.shadowBlur = 10;
    shape.forEach((points, i) => line(points, i === 0 ? 2.4 : 1.2, alpha));
  }

  function strike() {
    const w = canvas.width;
    const h = canvas.height;
    const x = rand(w * 0.25, w * 0.8);
    const main = route(x, 0, x + rand(-120, 120), rand(h * 0.45, h * 0.8), rand(70, 110));
    shape = [main];
    for (let i = 0; i < 3; i++) {
      const from = main[Math.floor(rand(main.length * 0.25, main.length * 0.7))];
      shape.push(route(from[0], from[1], from[0] + rand(-170, 170), from[1] + rand(80, 220), 50));
    }
    sky.style.setProperty('--jellio-season-flash-x', (x / w) * 100 + '%');
    [[0, 0.62, 1], [70, 0, 0], [130, 0.35, 0.8], [190, 0, 0], [260, 0.22, 0.5], [380, 0, 0]].forEach(function (step) {
      timers.push(window.setTimeout(function () {
        flash.style.setProperty('--jellio-season-flash-opacity', String(step[1]));
        flash.classList.toggle('jellio-season-flash-on', step[1] > 0);
        draw(step[2]);
      }, step[0]));
    });
    const page = rootEl.querySelector('.jellio-content');
    if (page) {
      page.classList.add('jellio-season-rumble');
      timers.push(window.setTimeout(() => page.classList.remove('jellio-season-rumble'), 420));
    }
  }

  function schedule(first) {
    strikeTimer = window.setTimeout(function () {
      if (!document.hidden) strike();
      schedule(false);
    }, first ? rand(6000, 12000) : rand(12000, 26000));
  }
  schedule(true);

  return function cleanup() {
    window.clearTimeout(strikeTimer);
    timers.forEach((id) => window.clearTimeout(id));
    window.removeEventListener('resize', fit);
    sky.remove();
  };
}

function mountHalloween(container) {
  buildWash(container);
  if (reduceMotion()) return undefined;

  const phone = window.innerWidth < 700;
  const scale = phone ? 0.6 : 1;
  const count = (n) => Math.max(1, Math.round(n * scale));
  const place = (node, parent) => {
    (parent || container).appendChild(node);
    return node;
  };

  const moon = el('div', 'jellio-season-moon');
  place(moon);
  place(halloweenArt('div', 'jellio-season-witch', 'witch'));
  place(el('div', 'jellio-season-fog'));
  place(el('div', 'jellio-season-flicker'));

  ['var(--jellio-season-accent)', '#7cff6b', '#ff3b3b'].slice(0, phone ? 2 : 3).forEach(function (color) {
    const eyes = el('div', 'jellio-season-eyes');
    eyes.style.left = rand(15, 80) + 'vw';
    eyes.style.top = rand(34, 74) + 'vh';
    eyes.style.animationDelay = '-' + rand(0, 14) + 's';
    eyes.style.animationDuration = rand(12, 19) + 's';
    eyes.style.setProperty('--jellio-season-eye', color);
    eyes.innerHTML = '<span></span><span></span>';
    place(eyes);
  });

  const bats = count(14);
  for (let i = 0; i < bats; i++) {
    const near = i < count(4);
    const bat = halloweenArt('span', 'jellio-season-bat', 'bat');
    const width = near ? rand(40, 56) : rand(20, 30);
    bat.style.left = rand(0, 90) + 'vw';
    bat.style.width = width + 'px';
    bat.style.height = width * 0.53 + 'px';
    bat.style.setProperty('--jellio-season-dx', rand(-30, -60) + 'vw');
    bat.style.setProperty('--jellio-season-flap', rand(0.26, 0.4) + 's');
    bat.style.animationDuration = (near ? rand(9, 13) : rand(15, 24)) + 's';
    bat.style.animationDelay = '-' + rand(0, 20) + 's';
    bat.style.opacity = near ? '0.6' : '0.34';
    place(bat);
  }

  for (let i = 0; i < count(3); i++) {
    const ghost = halloweenArt('span', 'jellio-season-ghost', 'ghost');
    ghost.style.left = rand(8, 88) + 'vw';
    ghost.style.setProperty('--jellio-season-size', rand(34, 62) + 'px');
    ghost.style.setProperty('--jellio-season-opacity', String(rand(0.18, 0.34)));
    ghost.style.animationDuration = rand(20, 32) + 's';
    ghost.style.animationDelay = '-' + rand(0, 28) + 's';
    place(ghost);
  }

  for (let i = 0; i < count(2); i++) {
    const drop = el('div', 'jellio-season-spider');
    drop.style.left = rand(14, 88) + 'vw';
    drop.style.setProperty('--jellio-season-drop', rand(22, 55) + 'vh');
    drop.style.setProperty('--jellio-season-size', rand(22, 32) + 'px');
    drop.style.animationDuration = rand(15, 24) + 's';
    drop.style.animationDelay = '-' + rand(0, 20) + 's';
    drop.appendChild(el('i'));
    drop.appendChild(halloweenArt('b', null, 'spider'));
    place(drop);
  }

  [['left', '10%', '70px', '0s'], ['right', '8%', '56px', '-1.4s']].forEach(function (spec) {
    const pumpkin = el('div', 'jellio-season-pumpkin');
    pumpkin.style[spec[0]] = spec[1];
    pumpkin.style.setProperty('--jellio-season-size', spec[2]);
    const art = halloweenArt('span', null, 'pumpkin');
    art.style.animationDelay = spec[3];
    pumpkin.appendChild(art);
    place(pumpkin);
  });
  ['jellio-season-cobweb-left', 'jellio-season-cobweb-right'].forEach(function (cls) {
    const web = el('div', 'jellio-season-cobweb ' + cls);
    web.innerHTML = cobwebSvg();
    place(web);
  });

  for (let i = 0; i < count(26); i++) {
    const ember = el('span', 'jellio-season-ember');
    ember.style.left = rand(0, 100) + 'vw';
    ember.style.setProperty('--jellio-season-size', rand(2, 4.5) + 'px');
    ember.style.setProperty('--jellio-season-sway', rand(-60, 60) + 'px');
    ember.style.animationDuration = rand(8, 15) + 's';
    ember.style.animationDelay = '-' + rand(0, 15) + 's';
    place(ember);
  }

  for (let i = 0; i < count(3); i++) {
    const skull = halloweenArt('span', 'jellio-season-skull', 'skull');
    skull.style.left = rand(6, 92) + 'vw';
    skull.style.top = rand(18, 80) + 'vh';
    skull.style.setProperty('--jellio-season-size', rand(22, 36) + 'px');
    skull.style.animationDuration = rand(22, 34) + 's';
    skull.style.animationDelay = '-' + rand(0, 30) + 's';
    place(skull);
  }

  return mountHalloweenSky();
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
