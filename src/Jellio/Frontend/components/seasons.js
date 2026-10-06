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

// Halloween: the wash, fog, a breathing vignette and eyes in the dark,
// then hand drawn creatures (SVG, so they look the same on every device)
// all behind the page: bats that really flap, ghosts rising, spiders
// dropping on silk, flickering jack-o'-lanterns, cobwebs, a blood moon and
// embers. Lightning
// is the one layer above the page: a flash that lights the whole screen
// and a forked bolt, every so often. Counts drop on a phone; with
// reduced motion only the wash stays.
const HALLOWEEN_ART = {
  bat: '<svg viewBox="0 0 64 34" aria-hidden="true"><g class="jellio-season-wing-r"><path d="M33 16C38 7 49 3 63 8C59 10 58 14 59 20C55 16 51 17 49 23C46 18 42 19 39 25C37 21 35 20 33 22Z" fill="#050308"/></g><g class="jellio-season-wing-l"><path d="M31 16C26 7 15 3 1 8C5 10 6 14 5 20C9 16 13 17 15 23C18 18 22 19 25 25C27 21 29 20 31 22Z" fill="#050308"/></g><path d="M27.5 9L26 1.5L30.5 6L32 4.5L33.5 6L38 1.5L36.5 9C37.5 12 37.5 17 35.5 22C34.5 26 33.2 29 32 33C30.8 29 29.5 26 28.5 22C26.5 17 26.5 12 27.5 9Z" fill="#050308"/><circle cx="30" cy="10.5" r="1" fill="#ff7518"/><circle cx="34" cy="10.5" r="1" fill="#ff7518"/></svg>',
  ghost: '<svg viewBox="0 0 60 72" aria-hidden="true"><defs><linearGradient id="jellio-season-ghost-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4f0ff"/><stop offset="1" stop-color="#b9a8ff" stop-opacity=".25"/></linearGradient></defs><path d="M30 2C14 2 5 15 5 32V68L13 59L21 69L30 59L39 69L47 59L55 68V32C55 15 46 2 30 2Z" fill="url(#jellio-season-ghost-fill)"/><path d="M5 40C-3 44-5 52 1 58C6 55 7 50 5 46Z M55 40C63 44 65 52 59 58C54 55 53 50 55 46Z" fill="#d8ccff" opacity=".6"/><ellipse cx="22" cy="28" rx="4" ry="6" fill="#1b1230"/><ellipse cx="38" cy="28" rx="4" ry="6" fill="#1b1230"/><ellipse cx="30" cy="43" rx="5" ry="7.5" fill="#1b1230"/></svg>',
  spider: '<svg viewBox="0 0 48 40" aria-hidden="true"><g class="jellio-season-legs" fill="none" stroke="#050308" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 20L10 8L2 14"/><path d="M22 23L7 18L1 28"/><path d="M22 26L8 30L4 39"/><path d="M23 28L14 36L12 40"/><path d="M26 20L38 8L46 14"/><path d="M26 23L41 18L47 28"/><path d="M26 26L40 30L44 39"/><path d="M25 28L34 36L36 40"/></g><ellipse cx="24" cy="26" rx="8.5" ry="10" fill="#050308"/><circle cx="24" cy="15" r="5" fill="#050308"/><path d="M21 28L24 24L27 28L24 31Z" fill="#c1121f"/><circle cx="22" cy="14" r="1" fill="#ff3b3b"/><circle cx="26" cy="14" r="1" fill="#ff3b3b"/></svg>',
  pumpkin: '<svg viewBox="0 0 80 72" aria-hidden="true"><defs><radialGradient id="jellio-season-pumpkin-fill" cx=".5" cy=".4" r=".7"><stop offset="0" stop-color="#ff9a2e"/><stop offset=".7" stop-color="#e2560a"/><stop offset="1" stop-color="#8f2a04"/></radialGradient></defs><path d="M37 14C36 8 38 4 43 1L46 4C43 6 43 9 44 14Z" fill="#3b4a14"/><ellipse cx="22" cy="43" rx="19" ry="25" fill="url(#jellio-season-pumpkin-fill)"/><ellipse cx="58" cy="43" rx="19" ry="25" fill="url(#jellio-season-pumpkin-fill)"/><ellipse cx="40" cy="43" rx="22" ry="27" fill="url(#jellio-season-pumpkin-fill)"/><path d="M40 16C33 28 33 58 40 70M24 20C14 32 14 56 24 66M56 20C66 32 66 56 56 66" fill="none" stroke="#7a2503" stroke-width="1.6" opacity=".55"/><g class="jellio-season-face"><path d="M23 34L33 40L21 44Z M57 34L47 40L59 44Z" fill="#ffd36b"/><path d="M40 46L36 53H44Z" fill="#ffd36b"/><path d="M22 53L26 58L31 55L35 61L40 56L45 61L49 55L54 58L58 53C54 66 26 66 22 53Z" fill="#ffd36b"/></g></svg>',
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

  return mountHalloweenSky();
}

// Shared by the Christmas and New Year canvases: a requestAnimationFrame
// loop that stops while the tab is hidden, and a canvas kept at the size
// of the window (and its pixel ratio) behind everything else.
function startLoop(step) {
  let frameId = 0;
  let running = true;
  function frame(now) {
    if (!running) return;
    step(now);
    frameId = window.requestAnimationFrame(frame);
  }
  function onVisibility() {
    window.cancelAnimationFrame(frameId);
    if (!document.hidden && running) frameId = window.requestAnimationFrame(frame);
  }
  document.addEventListener('visibilitychange', onVisibility);
  frameId = window.requestAnimationFrame(frame);
  return function stop() {
    running = false;
    window.cancelAnimationFrame(frameId);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

function fullCanvas(container) {
  const canvas = document.createElement('canvas');
  canvas.className = 'jellio-season-canvas';
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const size = { w: 0, h: 0 };
  function fit() {
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    size.w = window.innerWidth;
    size.h = window.innerHeight;
    canvas.width = size.w * ratio;
    canvas.height = size.h * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }
  fit();
  window.addEventListener('resize', fit);
  return { ctx: ctx, size: size, dispose: () => window.removeEventListener('resize', fit) };
}

function pickOne(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function svgNode(tag, attrs) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.keys(attrs).forEach((key) => node.setAttribute(key, attrs[key]));
  return node;
}

// New Year: rockets that climb on a trail and burst as peonies, drooping
// willows, rings or a double burst, each lighting the page around it for
// a moment; gold and white confetti, streamers, champagne bubbles and a
// starry sky. At midnight on 1 January, once a year, a "Happy New Year"
// finale. Everything sits behind the page except that title.
const NY_MIX = ['#d4af37', '#eef0f5', '#ffe08a', '#ff7a59', '#7fb2ff'];
const NY_CONFETTI = ['#d4af37', '#eef0f5', '#ffe08a', '#c9a227', '#f6e7b4'];
const NY_MIDNIGHT_KEY = 'jellioNewYearMidnight';

function mountNewYear(container) {
  buildWash(container);
  if (reduceMotion()) return undefined;

  const phone = window.innerWidth < 700;
  const scale = phone ? 0.6 : 1;
  const count = (n) => Math.max(1, Math.round(n * scale));

  for (let i = 0; i < count(52); i++) {
    const star = el('span', 'jellio-season-nstar');
    const size = rand(1, 2.4);
    star.style.width = size + 'px';
    star.style.height = size + 'px';
    star.style.left = rand(0, 100) + 'vw';
    star.style.top = rand(0, 62) + 'vh';
    star.style.setProperty('--jellio-season-t', rand(2.5, 6) + 's');
    star.style.animationDelay = '-' + rand(0, 6) + 's';
    container.appendChild(star);
  }
  for (let i = 0; i < count(28); i++) {
    const bubble = el('span', 'jellio-season-bubble');
    const size = rand(4, 11);
    bubble.style.width = size + 'px';
    bubble.style.height = size + 'px';
    bubble.style.left = rand(2, 98) + 'vw';
    bubble.style.setProperty('--jellio-season-sway', rand(-14, 14) + 'px');
    bubble.style.setProperty('--jellio-season-t', rand(8, 14) + 's');
    bubble.style.animationDelay = '-' + rand(0, 14) + 's';
    container.appendChild(bubble);
  }
  [['left', '#d4af37'], ['right', '#eef0f5']].forEach(function (spec, index) {
    const box = el('div', 'jellio-season-streamer');
    box.style[spec[0]] = '2%';
    box.style.animationDelay = index * -2.2 + 's';
    const svg = svgNode('svg', { viewBox: '0 0 120 360', width: '100%', height: '100%' });
    [['#d4af37', 18], ['#eef0f5', 52], ['#c9a227', 86]].forEach(function (ribbon, j) {
      const dir = j % 2 ? 1 : -1;
      const d = 'M' + ribbon[1] + ' 0 c ' + dir * 26 + ' 30, ' + -dir * 26 + ' 60, 0 90 s ' + -dir * 26 + ' 60, 0 90 s ' + dir * 26 + ' 60, 0 ' + (60 + j * 20);
      svg.appendChild(svgNode('path', { d: d, fill: 'none', stroke: ribbon[0], 'stroke-width': 4, 'stroke-linecap': 'round', opacity: 0.85 }));
    });
    box.appendChild(svg);
    container.appendChild(box);
  });

  const canvas = fullCanvas(container);
  const ctx = canvas.ctx;
  let parts = [];
  let rockets = [];
  const confetti = [];
  let nextLaunch = 0;
  const timers = [];
  const later = (fn, ms) => timers.push(window.setTimeout(fn, ms));

  function glow(x, y, color) {
    const flash = el('div', 'jellio-season-burstflash');
    flash.style.left = x + 'px';
    flash.style.top = y + 'px';
    flash.style.background = 'radial-gradient(circle, ' + color + '66 0%, ' + color + '22 38%, transparent 68%)';
    container.insertBefore(flash, container.children[1] || null);
    if (flash.animate) {
      const run = flash.animate([{ opacity: 0.9, transform: 'scale(.5)' }, { opacity: 0, transform: 'scale(1.15)' }], { duration: 900, easing: 'ease-out' });
      run.onfinish = () => flash.remove();
    } else {
      later(() => flash.remove(), 900);
    }
  }

  function explode(type, x, y, color) {
    glow(x, y, color);
    if (type === 'peony') {
      const n = Math.round(98 * scale + 14);
      for (let i = 0; i < n; i++) {
        const a = (Math.PI * 2 * i) / n;
        const sp = rand(1.4, 4.1);
        parts.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, g: 0.028, life: 1, d: rand(0.011, 0.016), c: color, s: 1.8, tr: [] });
      }
    } else if (type === 'willow') {
      const n = Math.round(80 * scale);
      for (let i = 0; i < n; i++) {
        const a = (Math.PI * 2 * i) / n;
        const sp = rand(0.9, 2.6);
        parts.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, g: 0.04, life: 1, d: rand(0.0055, 0.008), c: '#ffd36b', s: 1.5, tr: [], long: true });
      }
    } else if (type === 'ring') {
      const tilt = rand(0.35, 1);
      for (let i = 0; i < 48; i++) {
        const a = (Math.PI * 2 * i) / 48;
        parts.push({ x: x, y: y, vx: Math.cos(a) * 3.1, vy: Math.sin(a) * 3.1 * tilt, g: 0.012, life: 1, d: 0.012, c: color, s: 2, tr: [] });
      }
    } else {
      explode('peony', x, y, color);
      later(() => explode('ring', x, y, pickOne(NY_MIX)), 240);
    }
  }

  function launch(type) {
    const tx = rand(canvas.size.w * 0.1, canvas.size.w * 0.9);
    rockets.push({
      x: tx + rand(-40, 40),
      y: canvas.size.h + 10,
      ty: rand(canvas.size.h * 0.1, canvas.size.h * 0.45),
      vy: -rand(5.5, 7.5),
      type: type || pickOne(['peony', 'willow', 'ring', 'double']),
      c: pickOne(NY_MIX),
      tr: [],
    });
  }

  function addConfetti(n, fromTop) {
    for (let i = 0; i < n; i++) {
      confetti.push({
        x: rand(0, canvas.size.w), y: fromTop ? rand(-canvas.size.h * 0.2, 0) : rand(-20, canvas.size.h),
        w: rand(4, 8), h: rand(6, 12), vy: rand(0.7, 1.7), sw: rand(0.5, 1.6), ph: rand(0, 7),
        rot: rand(0, 6), vr: rand(-0.05, 0.05), c: pickOne(NY_CONFETTI), a: rand(0.55, 0.85),
      });
    }
  }
  addConfetti(count(96));
  launch();

  let sky = null;
  function finale() {
    if (!sky) {
      sky = el('div', 'jellio-season-sky');
      const title = el('div', 'jellio-season-hny');
      title.appendChild(el('span', null, 'Happy New Year'));
      sky.appendChild(title);
      rootEl.appendChild(sky);
    }
    const title = sky.firstChild;
    title.classList.remove('jellio-season-hny-show');
    void title.offsetWidth;
    title.classList.add('jellio-season-hny-show');
    ['peony', 'willow', 'ring', 'double', 'peony', 'willow', 'double', 'ring', 'peony', 'double'].forEach((type, i) => later(() => launch(type), i * 260));
    addConfetti(count(120), true);
  }
  // Once a year, on 1 January.
  const today = new Date();
  if (today.getMonth() === 0 && today.getDate() === 1) {
    let seen = null;
    try {
      seen = window.localStorage.getItem(NY_MIDNIGHT_KEY);
    } catch (err) {
      seen = null;
    }
    if (seen !== String(today.getFullYear())) {
      try {
        window.localStorage.setItem(NY_MIDNIGHT_KEY, String(today.getFullYear()));
      } catch (err) {
        // Without storage it just plays on every load of the day.
      }
      later(finale, 2500);
    }
  }

  const stop = startLoop(function (now) {
    const w = canvas.size.w;
    const h = canvas.size.h;
    if (now > nextLaunch) {
      launch();
      if (Math.random() < 0.4) later(() => launch(), rand(150, 400));
      nextLaunch = now + rand(1100, 2300) / 1.3;
    }
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    confetti.forEach(function (c) {
      c.y += c.vy;
      c.x += Math.sin(now * 0.001 * c.sw + c.ph) * 0.6;
      c.rot += c.vr;
      if (c.y > h + 14) {
        c.y = -14;
        c.x = rand(0, w);
      }
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.rot);
      ctx.scale(1, Math.abs(Math.sin(now * 0.003 * c.sw + c.ph)) * 0.9 + 0.1);
      ctx.globalAlpha = c.a;
      ctx.fillStyle = c.c;
      ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
      ctx.restore();
    });
    ctx.globalCompositeOperation = 'lighter';
    rockets = rockets.filter(function (r) {
      r.y += r.vy;
      r.vy *= 0.985;
      r.tr.push([r.x, r.y]);
      if (r.tr.length > 12) r.tr.shift();
      ctx.strokeStyle = '#ffe9a8';
      ctx.lineWidth = 1.6;
      for (let i = 1; i < r.tr.length; i++) {
        ctx.globalAlpha = (i / r.tr.length) * 0.8;
        ctx.beginPath();
        ctx.moveTo(r.tr[i - 1][0], r.tr[i - 1][1]);
        ctx.lineTo(r.tr[i][0], r.tr[i][1]);
        ctx.stroke();
      }
      if (r.y <= r.ty || r.vy > -1.2) {
        explode(r.type, r.x, r.y, r.c);
        return false;
      }
      return true;
    });
    parts = parts.filter(function (p) {
      p.tr.push([p.x, p.y]);
      if (p.tr.length > (p.long ? 9 : 4)) p.tr.shift();
      p.x += p.vx;
      p.y += p.vy;
      p.vy += p.g;
      p.vx *= 0.992;
      p.life -= p.d;
      if (p.life <= 0) return false;
      ctx.strokeStyle = p.c;
      ctx.lineWidth = p.s;
      for (let i = 1; i < p.tr.length; i++) {
        ctx.globalAlpha = (p.life * i) / p.tr.length;
        ctx.beginPath();
        ctx.moveTo(p.tr[i - 1][0], p.tr[i - 1][1]);
        ctx.lineTo(p.tr[i][0], p.tr[i][1]);
        ctx.stroke();
      }
      ctx.globalAlpha = p.life;
      ctx.fillStyle = p.c;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.s * 0.7, 0, Math.PI * 2);
      ctx.fill();
      return true;
    });
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  });

  return function cleanup() {
    stop();
    canvas.dispose();
    timers.forEach((id) => window.clearTimeout(id));
    if (sky) sky.remove();
  };
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

// Christmas: a draped string of bulbs along the top, pine garland and
// swinging baubles in the corners, snow in three depths with wind that
// gusts now and then, a snow drift along the bottom, frost in the bottom
// corners, a warm hearth glow, and a shooting star with a few sparkles.
// All of it behind the page; with reduced motion only the wash stays.
const XMAS_BULBS = ['#ff4d4d', '#ffd36b', '#4dff88', '#5aa8ff', '#ff8fd6'];

function buildStringLights(container) {
  const w = window.innerWidth;
  const svg = svgNode('svg', { class: 'jellio-season-swag', viewBox: '0 0 ' + w + ' 110', preserveAspectRatio: 'none' });
  const swags = Math.max(3, Math.round(w / 280));
  const seg = w / swags;
  let d = 'M0 0';
  for (let i = 0; i < swags; i++) d += ' Q' + (seg * i + seg / 2) + ' ' + (58 + (i % 2) * 8) + ' ' + seg * (i + 1) + ' 6';
  const wire = svgNode('path', { d: d, class: 'jellio-season-wire' });
  svg.appendChild(wire);
  const length = wire.getTotalLength();
  const total = Math.round(length / 38);
  for (let b = 0; b < total; b++) {
    const p = wire.getPointAtLength(((b + 0.5) * length) / total);
    const color = XMAS_BULBS[b % XMAS_BULBS.length];
    const group = svgNode('g', { class: 'jellio-season-bulb', style: 'animation-delay:-' + (b % 5) * 0.64 + 's' });
    group.appendChild(svgNode('circle', { cx: p.x, cy: p.y + 9, r: 13, fill: color, opacity: 0.28 }));
    group.appendChild(svgNode('rect', { x: p.x - 2.5, y: p.y - 1, width: 5, height: 5, fill: '#10261a' }));
    group.appendChild(svgNode('path', { d: 'M' + (p.x - 4.5) + ' ' + (p.y + 4) + 'Q' + (p.x - 7) + ' ' + (p.y + 15) + ' ' + p.x + ' ' + (p.y + 17) + 'Q' + (p.x + 7) + ' ' + (p.y + 15) + ' ' + (p.x + 4.5) + ' ' + (p.y + 4) + 'Z', fill: color }));
    group.appendChild(svgNode('ellipse', { cx: p.x - 1.6, cy: p.y + 9, rx: 1.3, ry: 2.6, fill: '#fff', opacity: 0.55 }));
    svg.appendChild(group);
  }
  container.appendChild(svg);
  return svg;
}

function baubleSvg(color, id) {
  return (
    '<svg viewBox="0 0 40 46" aria-hidden="true"><defs><radialGradient id="' + id + '" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#fff" stop-opacity=".9"/><stop offset=".25" stop-color="' + color + '"/><stop offset="1" stop-color="#000" stop-opacity=".55"/></radialGradient></defs>' +
    '<rect x="16" y="1" width="8" height="7" rx="1.5" fill="#d4af37"/><circle cx="20" cy="28" r="17" fill="url(#' + id + ')"/>' +
    '<path d="M8 26C14 31 26 31 32 26" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="1.4"/></svg>'
  );
}

function buildGarlands(container) {
  ['left', 'right'].forEach(function (side) {
    const box = el('div', 'jellio-season-garland jellio-season-garland-' + side);
    const svg = svgNode('svg', { viewBox: '0 0 280 120', width: '100%', height: '100%' });
    svg.appendChild(svgNode('path', { d: 'M-4 18C60 40 120 30 190 62C230 80 262 92 284 118', fill: 'none', stroke: '#0f3d22', 'stroke-width': 16, 'stroke-linecap': 'round' }));
    svg.appendChild(svgNode('path', { d: 'M-4 18C60 40 120 30 190 62C230 80 262 92 284 118', fill: 'none', stroke: '#1d6b3a', 'stroke-width': 7, 'stroke-linecap': 'round', 'stroke-dasharray': '2 5' }));
    for (let i = 0; i < 30; i++) {
      const t = i / 30;
      const x = -4 + t * 288;
      const y = 18 + 100 * Math.pow(t, 1.4) + Math.sin(t * 9) * 5;
      svg.appendChild(svgNode('path', { d: 'M' + x + ' ' + y + 'l' + rand(-9, 9) + ' ' + rand(8, 16), stroke: pickOne(['#1d6b3a', '#2a8a4c', '#0f3d22']), 'stroke-width': 2, 'stroke-linecap': 'round' }));
    }
    [[60, 34, '#c0392b'], [130, 40, '#d4af37'], [205, 70, '#c0392b']].forEach((berry) => svg.appendChild(svgNode('circle', { cx: berry[0], cy: berry[1], r: 5, fill: berry[2] })));
    box.appendChild(svg);
    container.appendChild(box);
  });
  [['14%', '#c0392b', 38, 120, '#ff6a5a'], ['86%', '#d4af37', 34, 150, '#ffe08a'], ['50%', '#3b82f6', 30, 96, '#7fb2ff']].forEach(function (spec, i) {
    const wrap = el('div', 'jellio-season-bauble');
    wrap.style.left = spec[0];
    wrap.style.setProperty('--jellio-season-len', spec[3] + 'px');
    wrap.style.setProperty('--jellio-season-size', spec[2] + 'px');
    wrap.style.setProperty('--jellio-season-glow', spec[4]);
    wrap.style.animationDelay = '-' + i * 1.7 + 's';
    wrap.style.animationDuration = 4.5 + i + 's';
    wrap.appendChild(el('i'));
    wrap.insertAdjacentHTML('beforeend', baubleSvg(spec[1], 'jellio-season-bauble-' + i));
    container.appendChild(wrap);
  });
}

function buildFrost(container) {
  ['left', 'right'].forEach(function (side) {
    const box = el('div', 'jellio-season-frost jellio-season-frost-' + side);
    const svg = svgNode('svg', { viewBox: '0 0 260 260', width: '100%', height: '100%' });
    let d = '';
    const branch = function (x, y, a, len, depth) {
      if (depth === 0 || len < 6) return;
      const x2 = x + Math.cos(a) * len;
      const y2 = y + Math.sin(a) * len;
      d += 'M' + x.toFixed(1) + ' ' + y.toFixed(1) + 'L' + x2.toFixed(1) + ' ' + y2.toFixed(1);
      branch(x2, y2, a - 0.55, len * 0.62, depth - 1);
      branch(x2, y2, a + 0.55, len * 0.62, depth - 1);
      branch(x2, y2, a, len * 0.74, depth - 1);
    };
    [-1.2, -0.95, -0.7, -0.45, -0.2].forEach((a) => branch(0, 260, a, 70, 4));
    svg.appendChild(svgNode('path', { d: d, fill: 'none', stroke: '#cfe6ff', 'stroke-width': 1, 'stroke-linecap': 'round', opacity: 0.7 }));
    box.appendChild(svg);
    container.appendChild(box);
  });
}

function mountChristmas(container) {
  buildWash(container);
  if (reduceMotion()) return undefined;

  const phone = window.innerWidth < 700;
  const scale = phone ? 0.6 : 1;

  container.appendChild(el('div', 'jellio-season-hearth'));
  buildFrost(container);
  const drift = el('div', 'jellio-season-drift');
  drift.innerHTML =
    '<svg viewBox="0 0 1200 120" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="jellio-season-drift-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4f9ff"/><stop offset="1" stop-color="#9fb8d6"/></linearGradient></defs><path d="M0 120V70C80 40 160 38 260 62C360 86 440 36 560 40C680 44 740 84 860 66C960 50 1060 28 1200 58V120Z" fill="url(#jellio-season-drift-fill)" opacity=".92"/><path d="M0 120V92C120 70 220 86 340 82C480 78 560 58 700 70C840 82 960 62 1200 84V120Z" fill="#fff" opacity=".55"/></svg>';
  container.appendChild(drift);

  const shoot = el('div', 'jellio-season-shoot');
  shoot.style.left = rand(10, 40) + '%';
  shoot.style.top = rand(8, 25) + '%';
  container.appendChild(shoot);
  for (let i = 0; i < Math.max(4, Math.round(11 * scale)); i++) {
    const spark = el('div', 'jellio-season-spark');
    const size = rand(8, 16);
    spark.style.width = size + 'px';
    spark.style.height = size + 'px';
    spark.style.left = rand(3, 96) + '%';
    spark.style.top = rand(6, 92) + '%';
    spark.style.setProperty('--jellio-season-t', rand(3, 7) + 's');
    spark.style.animationDelay = '-' + rand(0, 7) + 's';
    spark.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 0C11 6 14 9 20 10C14 11 11 14 10 20C9 14 6 11 0 10C6 9 9 6 10 0Z" fill="' + pickOne(['#fff', '#ffe08a', '#bfe3ff']) + '"/></svg>';
    container.appendChild(spark);
  }

  buildGarlands(container);
  let lights = buildStringLights(container);
  let relight = null;
  const onResize = function () {
    window.clearTimeout(relight);
    relight = window.setTimeout(function () {
      lights.remove();
      lights = buildStringLights(container);
    }, 200);
  };
  window.addEventListener('resize', onResize);

  const canvas = fullCanvas(container);
  const ctx = canvas.ctx;
  const flakes = [];
  const addFlakes = function (depth, n) {
    for (let i = 0; i < n; i++) {
      flakes.push({
        depth: depth, x: rand(0, canvas.size.w), y: rand(0, canvas.size.h),
        r: depth === 0 ? rand(0.8, 1.6) : depth === 1 ? rand(1.8, 3) : rand(5, 9),
        v: depth === 0 ? rand(0.25, 0.5) : depth === 1 ? rand(0.6, 1.1) : rand(1.3, 2),
        ph: rand(0, 7), a: rand(0.2, 0.6), rot: rand(0, 6),
      });
    }
  };
  addFlakes(0, Math.round(64 * scale));
  addFlakes(1, Math.round(34 * scale));
  addFlakes(2, Math.max(3, Math.round(9 * scale)));
  const crystal = function (x, y, r, rot) {
    ctx.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = rot + (k * Math.PI) / 3;
      const cx = Math.cos(a);
      const cy = Math.sin(a);
      ctx.moveTo(x, y);
      ctx.lineTo(x + cx * r, y + cy * r);
      ctx.moveTo(x + cx * r * 0.55, y + cy * r * 0.55);
      ctx.lineTo(x + Math.cos(a + 0.6) * r * 0.8, y + Math.sin(a + 0.6) * r * 0.8);
      ctx.moveTo(x + cx * r * 0.55, y + cy * r * 0.55);
      ctx.lineTo(x + Math.cos(a - 0.6) * r * 0.8, y + Math.sin(a - 0.6) * r * 0.8);
    }
    ctx.stroke();
  };
  const started = performance.now();
  let gustUntil = 0;
  const stop = startLoop(function (now) {
    const w = canvas.size.w;
    const h = canvas.size.h;
    if (now > gustUntil && Math.random() < 0.0006) gustUntil = now + 3500;
    const wind = Math.sin((now - started) * 0.0004) * 0.35 + (now < gustUntil ? 1.4 : 0);
    ctx.clearRect(0, 0, w, h);
    flakes.forEach(function (f) {
      f.y += f.v;
      f.x += Math.sin(now * 0.001 * (1 + f.depth * 0.3) + f.ph) * (0.3 + f.depth * 0.25) + wind * (0.4 + f.depth * 0.5);
      f.rot += 0.004 * (f.depth + 1);
      if (f.y > h + 12) {
        f.y = -12;
        f.x = rand(0, w);
      }
      if (f.x > w + 12) f.x = -12;
      else if (f.x < -12) f.x = w + 12;
      ctx.globalAlpha = f.depth === 2 ? 0.85 : f.a + 0.2;
      if (f.depth === 2) {
        ctx.strokeStyle = '#f2f8ff';
        ctx.lineWidth = 1.1;
        ctx.shadowColor = '#bfe3ff';
        ctx.shadowBlur = 6;
        crystal(f.x, f.y, f.r, f.rot);
        ctx.shadowBlur = 0;
      } else {
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
        ctx.fill();
      }
    });
    ctx.globalAlpha = 1;
  });

  return function cleanup() {
    stop();
    canvas.dispose();
    window.clearTimeout(relight);
    window.removeEventListener('resize', onResize);
  };
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
