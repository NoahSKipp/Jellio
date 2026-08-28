// Ported in spirit from CodeDevMLH/Jellyfin-Seasonals, not installed as
// that plugin directly: its own real script patches index.html the same
// way this codebase's own IndexHtmlPatchService does, so both could
// coexist, but its own "hide during video playback" check reads native
// jellyfin-web's own .videoPlayerContainer/dashboardDocument, neither of
// which this runtime's own screens ever produce, since screens/player.js
// owns a real player of its own rather than reskinning a native one.
// A small Jellio-owned component instead, hidden during this runtime's
// own real player route the same way components/mobileNav.js and
// components/sidebar.js already are (css/app.css's own real
// .jellio-root-fullscreen rule), not the native selectors the original
// plugin depends on.
//
// Server side, admin controlled config, not a client only localStorage
// toggle this used to carry: Controllers/ConfigController.cs's own
// GetConfig endpoint is the one real source, applies to every user on
// this server the same way, confirmed against Moonfin-Client/Plugin's
// own real server side settings surface before choosing this shape
// rather than guessed, and the same real shape a future native client
// (an Android TV app, say) could read from too. Per user overrides may
// layer on top of this later; nothing here forecloses that.
//
// Every falling/rising theme below (winter, autumn, spring, summer,
// halloween) shares one real particle engine: each particle is a plain
// span with a CSS animation the browser runs entirely on the
// compositor, the exact real lesson this session's own mobile nav pill
// already paid for (css/app.css's own header on .jellio-mobile-nav-label
// documents the same real hard-cut-under-load failure a JS
// requestAnimationFrame loop driving per-frame style writes would risk
// here again). Only New Year's fireworks and Friday the 13th need their
// own real per-theme code, real canvas particle bursts and a real CSS
// flicker respectively, neither expressible as a falling span.
import { getJellioConfig } from '../runtime/api.js';

// Real priority when more than one real range matches at once (Halloween
// week sitting inside Autumn's own much wider window, New Year's own
// week sitting inside winter's): a rare, specific occasion before a
// wide ambient season, so only one real particle system ever renders
// at a time rather than stacking unrelated ones over each other.
// Ported in spirit from CodeDevMLH/Jellyfin-Seasonals' own real
// SeasonalRules ordering: birthday/eid/resurrection/nightsky/matrix/
// frost have no real fixed calendar window there either (a personal
// occasion, a lunar Islamic date, a movable Orthodox one, or just a
// generic mood board with no real date tied to it at all), off by
// default here for the same real reason, sitting ahead of the wide
// ambient seasons so an admin who does turn one on deliberately still
// sees it over top of whatever season would otherwise be active.
const THEME_ORDER = [
  'friday13',
  'birthday',
  'eid',
  'resurrection',
  'hearts',
  'carnival',
  'oscar',
  'marioday',
  'filmnoir',
  'space',
  'cherryblossom',
  'earthday',
  'starwars',
  'eurovision',
  'pride',
  'underwater',
  'oktoberfest',
  'spooky',
  'halloween',
  'santa',
  'newyear',
  'christmas',
  'snowflakes',
  'snowfall',
  'nightsky',
  'matrix',
  'frost',
  'storm',
  'rain',
  'sports',
  'snowstorm',
  'winter',
  'autumn',
  'summer',
  'spring',
];

// A day-of-year range comparison that wraps New Year's, the same real
// problem the server's own December to January windows (winter, New
// Year) both have: a plain start <= now <= end fails the moment the
// range crosses into a new calendar year.
function inRange(month, day, range) {
  if (!range) return false;
  const now = month * 100 + day;
  const start = range.StartMonth * 100 + range.StartDay;
  const end = range.EndMonth * 100 + range.EndDay;
  if (start <= end) return now >= start && now <= end;
  return now >= start || now <= end;
}

function isFriday13(date) {
  return date.getDate() === 13 && date.getDay() === 5;
}

// Real, singular "what's active right now" against
// ConfigController.cs's own real response shape
// ({ SeasonalEffectsEnabled, SeasonalEffects: { <key>: { Enabled, Range } } }).
export function activeSeasonalTheme(date, config) {
  if (!config || !config.SeasonalEffectsEnabled) return null;
  const effects = config.SeasonalEffects || {};
  const month = date.getMonth() + 1;
  const day = date.getDate();

  for (let i = 0; i < THEME_ORDER.length; i++) {
    const key = THEME_ORDER[i];
    const effect = effects[key];
    if (!effect || !effect.Enabled) continue;
    const active = key === 'friday13' ? isFriday13(date) : inRange(month, day, effect.Range);
    if (active) return key;
  }
  return null;
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

// One shared span-per-particle engine: glyphs (or, for earthday's own
// real coloured petals, a plain circle with no glyph at all) drift
// down (or up, for summer's/hearts' own rising ones) purely on a CSS
// animation, JS only ever sets each particle's own starting position,
// size and animation timing once, never touches it again after that.
// opts.glow ports CodeDevMLH/Jellyfin-Seasonals' own real per-theme
// text-shadow glow (spooky's own SpookyGlowSize, eurovision's own
// EurovisionGlowSize) as one shared CSS class rather than a second
// bespoke engine for what both real themes already build the same way.
function buildDrift(container, opts) {
  const count = opts.count;
  const isDot = opts.shape === 'dot';
  for (let i = 0; i < count; i++) {
    const span = document.createElement('span');
    span.className = 'jellio-seasonal-particle' + (opts.glow ? ' jellio-seasonal-particle-glow' : '');
    if (isDot) {
      span.classList.add('jellio-seasonal-particle-dot');
      span.style.background = opts.colors[Math.floor(Math.random() * opts.colors.length)];
      const size = rand(opts.minSize, opts.maxSize);
      span.style.width = size + 'px';
      span.style.height = size + 'px';
    } else {
      span.textContent = opts.glyphs[Math.floor(Math.random() * opts.glyphs.length)];
      span.style.fontSize = rand(opts.minSize, opts.maxSize) + 'px';
    }
    span.style.left = rand(0, 100) + 'vw';
    span.style.opacity = String(rand(opts.minOpacity, opts.maxOpacity));
    span.style.animationDuration = rand(opts.minDuration, opts.maxDuration) + 's';
    span.style.animationDelay = '-' + rand(0, opts.maxDuration) + 's';
    span.style.setProperty('--jellio-seasonal-sway', rand(-40, 40) + 'px');
    span.classList.add(opts.direction === 'up' ? 'jellio-seasonal-particle-rise' : 'jellio-seasonal-particle-fall');
    container.appendChild(span);
  }
}

const DRIFT_THEMES = {
  winter: { glyphs: ['❄'], count: 60, minSize: 10, maxSize: 22, minOpacity: 0.5, maxOpacity: 0.95, minDuration: 8, maxDuration: 16, direction: 'down' },
  autumn: { glyphs: ['🍂', '🍁'], count: 40, minSize: 14, maxSize: 24, minOpacity: 0.6, maxOpacity: 1, minDuration: 7, maxDuration: 14, direction: 'down' },
  spring: { glyphs: ['🌸', '🌷'], count: 35, minSize: 12, maxSize: 20, minOpacity: 0.6, maxOpacity: 1, minDuration: 9, maxDuration: 17, direction: 'down' },
  summer: { glyphs: ['✨'], count: 30, minSize: 8, maxSize: 16, minOpacity: 0.4, maxOpacity: 0.85, minDuration: 10, maxDuration: 18, direction: 'up' },
  halloween: { glyphs: ['🦇', '🎃'], count: 30, minSize: 16, maxSize: 26, minOpacity: 0.6, maxOpacity: 1, minDuration: 8, maxDuration: 15, direction: 'down' },
  hearts: { glyphs: ['❤️', '💕', '💞', '💓', '💗', '💖'], count: 25, minSize: 14, maxSize: 24, minOpacity: 0.6, maxOpacity: 1, minDuration: 12, maxDuration: 18, direction: 'up' },
  cherryblossom: { glyphs: ['🌸'], count: 25, minSize: 14, maxSize: 22, minOpacity: 0.6, maxOpacity: 1, minDuration: 9, maxDuration: 16, direction: 'down' },
  eid: { glyphs: ['🏮', '🌙', '⭐', '✨'], count: 12, minSize: 16, maxSize: 26, minOpacity: 0.6, maxOpacity: 1, minDuration: 10, maxDuration: 17, direction: 'down' },
  christmas: { glyphs: ['❆', '🎁', '❄️', '🎅', '🎊'], count: 30, minSize: 14, maxSize: 24, minOpacity: 0.6, maxOpacity: 1, minDuration: 8, maxDuration: 16, direction: 'down' },
  oktoberfest: { glyphs: ['🥨', '🍺', '🍻'], count: 25, minSize: 16, maxSize: 26, minOpacity: 0.6, maxOpacity: 1, minDuration: 8, maxDuration: 15, direction: 'down' },
  eurovision: { glyphs: ['♪', '♫', '♬', '♭', '♮', '♯'], count: 25, minSize: 14, maxSize: 22, minOpacity: 0.6, maxOpacity: 1, minDuration: 8, maxDuration: 15, direction: 'down', glow: true },
  earthday: { shape: 'dot', colors: ['#FF69B4', '#FFD700', '#87CEFA', '#FF4500', '#BA55D3', '#FFA500', '#FF1493'], count: 45, minSize: 6, maxSize: 12, minOpacity: 0.6, maxOpacity: 1, minDuration: 9, maxDuration: 16, direction: 'down' },
  pride: { glyphs: ['❤️', '🧡', '💛', '💚', '💙', '💜'], count: 20, minSize: 16, maxSize: 24, minOpacity: 0.6, maxOpacity: 1, minDuration: 10, maxDuration: 15, direction: 'up' },
  resurrection: { glyphs: ['✝️', '🕊️', '🌿'], count: 12, minSize: 18, maxSize: 28, minOpacity: 0.6, maxOpacity: 1, minDuration: 10, maxDuration: 17, direction: 'down' },
  snowflakes: { glyphs: ['❅', '❆'], count: 25, minSize: 12, maxSize: 22, minOpacity: 0.6, maxOpacity: 1, minDuration: 8, maxDuration: 16, direction: 'down' },
  birthday: { glyphs: ['🎈', '🎉', '🎊'], count: 12, minSize: 20, maxSize: 30, minOpacity: 0.7, maxOpacity: 1, minDuration: 11, maxDuration: 17, direction: 'up' },
  spooky: { glyphs: ['👻', '🦇', '🎃'], count: 25, minSize: 18, maxSize: 28, minOpacity: 0.6, maxOpacity: 1, minDuration: 8, maxDuration: 15, direction: 'down', glow: true },
};

// New Year's own real fireworks: a plain canvas particle burst, the one
// theme here that genuinely cannot be a CSS-only span (an expanding,
// fading ring of dots from a real random point needs real per-frame
// physics), kept small and bounded (one live burst at a time, a modest
// particle count) rather than anything close to a real fireworks show.
function buildFireworks(container) {
  const canvas = document.createElement('canvas');
  canvas.className = 'jellio-seasonal-fireworks-canvas';
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  let width = 0;
  let height = 0;
  let frameId = null;
  let bursts = [];
  const COLORS = ['#ff5e5e', '#ffd45e', '#5ecbff', '#8bff5e', '#ff8bf3'];

  function resize() {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  function spawnBurst() {
    const x = rand(width * 0.15, width * 0.85);
    const y = rand(height * 0.15, height * 0.55);
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    const particles = [];
    const count = 26;
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count;
      const speed = rand(1.5, 4);
      particles.push({
        x: x,
        y: y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1,
      });
    }
    bursts.push({ particles: particles, color: color });
  }

  let spawnTimer = window.setTimeout(function spawnLoop() {
    spawnBurst();
    spawnTimer = window.setTimeout(spawnLoop, rand(1500, 3200));
  }, rand(400, 1200));

  function tick() {
    ctx.clearRect(0, 0, width, height);
    bursts = bursts.filter(function (burst) {
      burst.particles.forEach(function (p) {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.02;
        p.life -= 0.012;
      });
      ctx.fillStyle = burst.color;
      burst.particles.forEach(function (p) {
        if (p.life <= 0) return;
        ctx.globalAlpha = Math.max(p.life, 0);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.globalAlpha = 1;
      return burst.particles.some(function (p) { return p.life > 0; });
    });
    frameId = window.requestAnimationFrame(tick);
  }
  tick();

  return function cleanup() {
    window.clearTimeout(spawnTimer);
    if (frameId) window.cancelAnimationFrame(frameId);
    window.removeEventListener('resize', resize);
  };
}

function buildFriday13(container) {
  container.appendChild(document.createElement('div')).className = 'jellio-seasonal-friday13-vignette';
  const cat = document.createElement('span');
  cat.className = 'jellio-seasonal-friday13-cat';
  cat.textContent = '🐈‍⬛';
  container.appendChild(cat);
}

// Ported in spirit from CodeDevMLH/Jellyfin-Seasonals' own real
// matrix.js: a canvas code rain, real per-column trail objects each
// tracking their own head position/speed/character buffer, redrawn
// every real tick rather than a CSS animation, since a trail's own
// characters genuinely mutate frame to frame (that real plugin's own
// Trail.update() does the same real per-char mutation this ports).
function buildMatrix(container) {
  const canvas = document.createElement('canvas');
  canvas.className = 'jellio-seasonal-fireworks-canvas';
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const chars = '0123456789'.split('');
  const fontSize = 18;
  let width = 0;
  let height = 0;
  let trails = [];
  let frameId = null;

  function makeTrail() {
    const cols = Math.max(1, Math.floor(width / fontSize));
    const trail = {
      x: Math.floor(rand(0, cols)),
      y: -Math.round(rand(0, 20)),
      speed: rand(0.5, 1),
      len: Math.floor(rand(10, 30)),
      chars: [],
    };
    for (let i = 0; i < trail.len; i++) {
      trail.chars.push(chars[Math.floor(Math.random() * chars.length)]);
    }
    return trail;
  }

  function resize() {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  const trailCount = 25;
  for (let i = 0; i < trailCount; i++) trails.push(makeTrail());

  function tick() {
    ctx.clearRect(0, 0, width, height);
    ctx.font = 'bold ' + fontSize + 'px monospace';
    ctx.textAlign = 'center';
    trails.forEach(function (t) {
      const oldY = Math.floor(t.y);
      t.y += t.speed;
      const newY = Math.floor(t.y);
      if (newY > oldY) {
        t.chars.unshift(chars[Math.floor(Math.random() * chars.length)]);
        t.chars.pop();
      }
      if (t.y - t.len > Math.ceil(height / fontSize)) {
        Object.assign(t, makeTrail());
      }
      const headY = Math.floor(t.y);
      for (let i = 0; i < t.len; i++) {
        const charY = headY - i;
        if (charY < 0 || charY * fontSize > height + fontSize) continue;
        const alpha = 1 - i / t.len;
        if (i === 0) {
          ctx.fillStyle = 'rgba(255, 255, 255, ' + alpha + ')';
        } else if (i === 1) {
          ctx.fillStyle = 'rgba(150, 255, 150, ' + alpha + ')';
        } else {
          ctx.fillStyle = 'rgba(0, 255, 0, ' + alpha * 0.8 + ')';
        }
        ctx.fillText(t.chars[i], t.x * fontSize + fontSize / 2, charY * fontSize);
      }
    });
    frameId = window.requestAnimationFrame(tick);
  }
  tick();

  return function cleanup() {
    if (frameId) window.cancelAnimationFrame(frameId);
    window.removeEventListener('resize', resize);
  };
}

// Ported in spirit from CodeDevMLH/Jellyfin-Seasonals' own real
// nightsky.js AND space.js: both of those real plugin files build this
// exact same parallax starfield (three depth layer CSS box-shadow dot
// clusters, each its own slow drift) and the same self-relaunching
// shooting stars, confirmed identical against both real sources rather
// than assumed, one real shared builder here instead of copying it
// twice the way that plugin's own two separate files do.
function buildStarfield(container, shootingStarCount) {
  const glow = document.createElement('div');
  glow.className = 'jellio-seasonal-nightsky-glow';
  container.appendChild(glow);

  const starfield = document.createElement('div');
  starfield.className = 'jellio-seasonal-nightsky-starfield';
  [
    { size: 1, count: 150, duration: 200 },
    { size: 2, count: 50, duration: 150 },
    { size: 3, count: 20, duration: 100 },
  ].forEach(function (layer) {
    const shadows = [];
    for (let i = 0; i < layer.count; i++) {
      const x = rand(0, 100).toFixed(2);
      const y = rand(0, 100).toFixed(2);
      shadows.push(x + 'vw ' + y + 'vh #fff');
      shadows.push(x + 'vw ' + (Number(y) + 100).toFixed(2) + 'vh #fff');
    }
    const dot = document.createElement('div');
    dot.style.width = layer.size + 'px';
    dot.style.height = layer.size + 'px';
    dot.style.borderRadius = '50%';
    dot.style.boxShadow = shadows.join(', ');
    dot.style.animation = 'jellio-seasonal-nightsky-drift ' + layer.duration + 's linear infinite';
    starfield.appendChild(dot);
  });
  container.appendChild(starfield);

  const cleanupTimers = [];

  function spawnShootingStar(streak) {
    const angle = rand(15, 165);
    streak.style.setProperty('--jellio-shoot-angle', angle + 'deg');
    streak.style.left = rand(0, 100) + 'vw';
    streak.style.top = rand(0, 100) + 'vh';
    const distance = rand(20, 60);
    streak.style.setProperty('--jellio-shoot-distance', distance + 'vw');
    streak.style.width = distance * 0.25 + 'vw';
    streak.style.animation = 'none';
    void streak.offsetWidth;
    const delayMs = rand(2000, 17000);
    const timer = window.setTimeout(function () {
      if (!streak.isConnected) return;
      const flightTime = rand(2, 4.5);
      streak.style.animation = 'jellio-seasonal-nightsky-shoot ' + flightTime + 's linear forwards';
    }, delayMs);
    cleanupTimers.push(timer);
  }

  for (let i = 0; i < shootingStarCount; i++) {
    const streak = document.createElement('span');
    streak.className = 'jellio-seasonal-nightsky-shooting-star';
    streak.addEventListener('animationend', function () {
      spawnShootingStar(streak);
    });
    spawnShootingStar(streak);
    container.appendChild(streak);
  }

  return function cleanup() {
    cleanupTimers.forEach(window.clearTimeout);
  };
}

function buildNightSky(container) {
  return buildStarfield(container, window.matchMedia('(max-width: 768px)').matches ? 3 : 6);
}

// Ported in spirit from CodeDevMLH/Jellyfin-Seasonals' own real
// space.js: that same real starfield above plus horizontally drifting
// objects (planets, an astronaut, satellites, the ISS, a rocket), each
// scattered at its own real depth (a random scale/blur/duration/z-index)
// and slowly self-rotating, real emoji standing in for that plugin's
// own bespoke image/GIF sprite sheet the same way batch 1 already did
// for Resurrection/Olympia-adjacent themes.
const SPACE_OBJECTS = [
  { glyphs: ['🪐', '🌍', '🌕', '🌑'], count: 6 },
  { glyphs: ['🧑‍🚀'], count: 1 },
  { glyphs: ['🛰️'], count: 4 },
  { glyphs: ['🚀'], count: 1 },
];

function buildSpace(container) {
  const cleanupStarfield = buildStarfield(container, window.matchMedia('(max-width: 768px)').matches ? 2 : 4);
  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  const divisor = isMobile ? 2 : 1;

  SPACE_OBJECTS.forEach(function (group) {
    const count = Math.max(1, Math.round(group.count / divisor));
    for (let i = 0; i < count; i++) {
      const depth = Math.random();
      const symbol = document.createElement('span');
      symbol.className = 'jellio-seasonal-space-object';
      symbol.textContent = group.glyphs[Math.floor(Math.random() * group.glyphs.length)];
      symbol.style.top = rand(0, 90) + 'vh';
      symbol.style.zIndex = String(Math.floor(depth * 30) + 20);
      symbol.style.fontSize = (0.6 + depth * 1.6) + 'rem';
      const duration = (1 - depth) * 40 + 30 + rand(-5, 5);
      const goRight = Math.random() > 0.5;
      symbol.classList.add(goRight ? 'jellio-seasonal-space-drift-right' : 'jellio-seasonal-space-drift-left');
      symbol.style.animationDuration = duration + 's';
      symbol.style.animationDelay = '-' + rand(0, duration) + 's';
      if (goRight) symbol.style.transform = 'scaleX(-1)';
      container.appendChild(symbol);
    }
  });

  return cleanupStarfield;
}

// Ported in spirit from CodeDevMLH/Jellyfin-Seasonals' own real
// filmnoir.js: a pure CSS overlay, no particles at all, a sepia tint
// plus grain/scratch/vignette layers already fully expressed as real
// CSS animations, nothing here to drive per frame.
function buildFilmNoir(container) {
  container.appendChild(document.createElement('div')).className = 'jellio-seasonal-filmnoir-tint';
  const effects = document.createElement('div');
  effects.className = 'jellio-seasonal-filmnoir-effects';
  effects.appendChild(document.createElement('div')).className = 'jellio-seasonal-filmnoir-grain';
  effects.appendChild(document.createElement('div')).className = 'jellio-seasonal-filmnoir-scratches';
  effects.appendChild(document.createElement('div')).className = 'jellio-seasonal-filmnoir-vignette';
  container.appendChild(effects);
}

// Ported in spirit from CodeDevMLH/Jellyfin-Seasonals' own real
// starwars.js: real hyperspace streaks radiating from a fixed center
// point, each one a plain span rotated to its own random angle with
// the real streak drawn by its own ::after in CSS.
function buildStarWars(container) {
  const center = document.createElement('div');
  center.className = 'jellio-seasonal-starwars-center';
  for (let i = 0; i < 60; i++) {
    const streak = document.createElement('span');
    streak.className = 'jellio-seasonal-starwars-streak';
    streak.style.transform = 'rotate(' + rand(0, 360) + 'deg)';
    streak.style.animationDelay = '-' + rand(0, 2) + 's';
    streak.style.animationDuration = rand(0.8, 2.3) + 's';
    center.appendChild(streak);
  }
  container.appendChild(center);
}

// Ported in spirit from CodeDevMLH/Jellyfin-Seasonals' own real
// oscar.js: a red carpet strip, three sweeping spotlights and a real
// randomised camera flash loop (its own timer reschedules itself
// rather than a fixed interval, same real technique here).
function buildOscar(container) {
  container.appendChild(document.createElement('div')).className = 'jellio-seasonal-oscar-carpet';

  const spotlights = document.createElement('div');
  spotlights.className = 'jellio-seasonal-oscar-spotlights';
  for (let i = 0; i < 3; i++) {
    const spot = document.createElement('span');
    spot.className = 'jellio-seasonal-oscar-spotlight';
    spot.style.animationDelay = '-' + rand(0, 8) + 's';
    spot.style.left = 20 + i * 30 + '%';
    spotlights.appendChild(spot);
  }
  container.appendChild(spotlights);

  let flashTimer = null;
  function flashLoop() {
    if (!container.isConnected) return;
    const flash = document.createElement('span');
    flash.className = 'jellio-seasonal-oscar-flash';
    flash.style.left = rand(0, 100) + '%';
    flash.style.top = rand(0, 100) + '%';
    container.appendChild(flash);
    window.setTimeout(function () {
      flash.remove();
    }, 200);
    flashTimer = window.setTimeout(flashLoop, rand(200, 1500));
  }
  flashLoop();

  return function cleanup() {
    if (flashTimer) window.clearTimeout(flashTimer);
  };
}

// Ported in spirit from CodeDevMLH/Jellyfin-Seasonals' own real
// frost.js: a simplified real vignette (that real plugin's own SVG
// feTurbulence displacement filter skipped here, an injected inline
// <svg><filter> id reference being real extra complexity this port
// isn't taking on for a corner effect), the real animated shimmer and
// creep-in kept as plain CSS.
function buildFrost(container) {
  container.appendChild(document.createElement('div')).className = 'jellio-seasonal-frost-layer';
}

// Ported in spirit from CodeDevMLH/Jellyfin-Seasonals' own real
// carnival.js: shaped, coloured confetti (circle/square/triangle/
// rect) that falls AND sways AND tumbles in 3D, three independent
// real CSS animations layered on three nested real elements (an outer
// fall wrapper, a middle sway wrapper, an inner flutter piece) rather
// than the one shared drift engine above, since that engine's own one
// combined transform keyframe has no real room left for a third,
// independent rotate3d on top of translate. Each piece really does
// respawn itself from the top on its own 'animationend', matching
// that real plugin's own real technique, instead of a fixed lifetime.
const CARNIVAL_COLORS = ['#fce18a', '#ff726d', '#b48def', '#f4306d', '#36c5f0', '#2ccc5d', '#e9b31d', '#9b59b6', '#3498db', '#e74c3c', '#1abc9c', '#f1c40f'];
const CARNIVAL_SHAPES = ['circle', 'square', 'triangle', 'rect'];

function spawnCarnivalPiece(container, colors) {
  const palette = colors || CARNIVAL_COLORS;
  const wrapper = document.createElement('div');
  wrapper.className = 'jellio-seasonal-carnival-wrapper';
  const sway = document.createElement('div');
  sway.className = 'jellio-seasonal-carnival-sway';
  const piece = document.createElement('div');
  const shape = CARNIVAL_SHAPES[Math.floor(Math.random() * CARNIVAL_SHAPES.length)];
  piece.className = 'jellio-seasonal-carnival-piece jellio-seasonal-carnival-' + shape;
  piece.style.backgroundColor = palette[Math.floor(Math.random() * palette.length)];

  wrapper.style.left = rand(0, 100) + '%';
  const duration = rand(5, 10);
  wrapper.style.animationDuration = duration + 's';
  wrapper.style.animationDelay = '-' + rand(0, duration) + 's';

  const swayDuration = rand(3, 5);
  sway.style.animationDuration = swayDuration + 's';
  sway.style.animationDelay = '-' + rand(0, 5) + 's';
  sway.style.setProperty('--jellio-carnival-sway', rand(30, 100) * (Math.random() > 0.5 ? 1 : -1) + 'px');

  piece.style.animationDuration = rand(1, 3) + 's';
  piece.style.setProperty('--jellio-carnival-rot', rand(0, 360) * (Math.random() > 0.5 ? 1 : -1) + 'deg');

  sway.appendChild(piece);
  wrapper.appendChild(sway);
  wrapper.addEventListener('animationend', function (event) {
    if (event.animationName !== 'jellio-seasonal-carnival-fall') return;
    wrapper.remove();
    if (container.isConnected) spawnCarnivalPiece(container, colors);
  });
  container.appendChild(wrapper);
}

function buildCarnival(container) {
  for (let i = 0; i < 60; i++) spawnCarnivalPiece(container);
}

// Ported in spirit from CodeDevMLH/Jellyfin-Seasonals' own real
// underwater.js: a deep blue overlay with light rays, swaying seaweed
// along the bottom, static bottom dwellers (crab/starfish/shell) and
// real swimmers (fish moving left/right, turtles the same but slower,
// jellyfish drifting up/down instead), each with its own real depth
// (blur/opacity/z-index) and a real inner sway div so the body sways
// independently of the direction it travels in, plus rising bubbles.
// Real emoji stand in for that plugin's own bespoke GIF sprites.
function buildUnderwater(container) {
  container.appendChild(document.createElement('div')).className = 'jellio-seasonal-underwater-bg';
  container.appendChild(document.createElement('div')).className = 'jellio-seasonal-underwater-rays';

  for (let i = 0; i < 14; i++) {
    const seaweed = document.createElement('span');
    seaweed.className = 'jellio-seasonal-underwater-seaweed';
    seaweed.textContent = '🌿';
    seaweed.style.left = rand(0, 95) + 'vw';
    seaweed.style.animationDelay = '-' + rand(0, 5) + 's';
    seaweed.style.fontSize = rand(1.6, 2.6) + 'rem';
    container.appendChild(seaweed);
  }

  [
    { glyph: '🦀', count: 2 },
    { glyph: '⭐', count: 2 },
    { glyph: '🐚', count: 2 },
  ].forEach(function (item) {
    for (let i = 0; i < item.count; i++) {
      const creature = document.createElement('span');
      creature.className = 'jellio-seasonal-underwater-bottom';
      creature.textContent = item.glyph;
      creature.style.left = rand(0, 95) + 'vw';
      creature.style.fontSize = rand(1.2, 1.8) + 'rem';
      container.appendChild(creature);
    }
  });

  function spawnSwimmer(glyph, baseSize, kind) {
    const depth = Math.random();
    const wrapper = document.createElement('span');
    wrapper.className = 'jellio-seasonal-underwater-swimmer';
    wrapper.style.opacity = String(0.4 + depth * 0.5);
    wrapper.style.zIndex = String(Math.floor(depth * 30) + 10);
    wrapper.style.fontSize = baseSize * (0.5 + depth) + 'rem';
    const duration = (1 - depth) * 20 + 15 + rand(0, 5);

    const inner = document.createElement('span');
    inner.className = 'jellio-seasonal-underwater-sway';
    inner.textContent = glyph;
    wrapper.appendChild(inner);

    if (kind === 'jellyfish') {
      wrapper.classList.add(Math.random() > 0.5 ? 'jellio-seasonal-underwater-up' : 'jellio-seasonal-underwater-down');
      wrapper.style.left = rand(0, 90) + 'vw';
    } else {
      wrapper.classList.add(Math.random() > 0.5 ? 'jellio-seasonal-underwater-right' : 'jellio-seasonal-underwater-left');
      wrapper.style.top = rand(5, 85) + 'vh';
    }
    wrapper.style.animationDuration = duration + 's';
    wrapper.style.animationDelay = '-' + rand(0, duration) + 's';
    container.appendChild(wrapper);
  }

  [
    { glyph: '🐟', size: 1.4, count: 10, kind: 'fish' },
    { glyph: '🐢', size: 2.2, count: 1, kind: 'turtle' },
    { glyph: '🪼', size: 1.8, count: 3, kind: 'jellyfish' },
  ].forEach(function (group) {
    for (let i = 0; i < group.count; i++) spawnSwimmer(group.glyph, group.size, group.kind);
  });

  for (let i = 0; i < 24; i++) {
    const bubble = document.createElement('span');
    bubble.className = 'jellio-seasonal-underwater-bubble';
    const size = rand(5, 18);
    bubble.style.width = size + 'px';
    bubble.style.height = size + 'px';
    bubble.style.left = rand(0, 100) + 'vw';
    bubble.style.animationDuration = rand(4, 8) + 's';
    bubble.style.animationDelay = rand(0, 8) + 's';
    container.appendChild(bubble);
  }
}

// Shared by Santa/Snowfall/Snowstorm below: CodeDevMLH/Jellyfin-Seasonals'
// own real snowfall.js/snowstorm.js/santa.js each build this exact same
// canvas dot snowfall (only the wind and vertical variance differ),
// confirmed identical against all three real sources, one shared real
// canvas loop here instead of copying it three times.
function buildCanvasSnow(container, opts) {
  const canvas = document.createElement('canvas');
  canvas.className = 'jellio-seasonal-fireworks-canvas';
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  let width = 0;
  let height = 0;
  let frameId = null;

  function resize() {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  const count = window.matchMedia('(max-width: 768px)').matches ? Math.round(opts.count / 2) : opts.count;
  const flakes = [];
  for (let i = 0; i < count; i++) {
    flakes.push({
      x: rand(0, width),
      y: rand(0, height),
      radius: rand(1, 1.6),
      speed: rand(1, 1 + opts.speed),
      horizontal: rand(-opts.wind, opts.wind),
      vertical: rand(-opts.verticalVariation, opts.verticalVariation),
    });
  }

  function tick() {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'white';
    flakes.forEach(function (flake) {
      flake.y += flake.speed + flake.vertical;
      flake.x += flake.horizontal;
      if (flake.y > height) {
        flake.y = 0;
        flake.x = rand(0, width);
      }
      if (flake.x > width) flake.x = 0;
      if (flake.x < 0) flake.x = width;
      ctx.beginPath();
      ctx.arc(flake.x, flake.y, flake.radius, 0, Math.PI * 2);
      ctx.fill();
    });
    frameId = window.requestAnimationFrame(tick);
  }
  tick();

  return function cleanup() {
    if (frameId) window.cancelAnimationFrame(frameId);
    window.removeEventListener('resize', resize);
  };
}

function buildSnowfall(container) {
  return buildCanvasSnow(container, { count: 350, speed: 2, wind: 0.3, verticalVariation: 0 });
}

function buildSnowstorm(container) {
  return buildCanvasSnow(container, { count: 350, speed: 4, wind: 4, verticalVariation: 2 });
}

// Ported in spirit from CodeDevMLH/Jellyfin-Seasonals' own real
// santa.js: that same shared canvas snowfall, plus a real Santa
// element flying a parabolic arc from one side of the screen to the
// other (a sine-curve lift added to the straight-line vertical
// interpolation, exactly matching that real plugin's own
// currentY = startY + deltaY * progress - 50 * Math.sin(progress * PI)),
// occasionally dropping a present that falls straight down and removes
// itself, then resting before flying again from a random side.
function buildSanta(container) {
  const cleanupSnow = buildCanvasSnow(container, { count: 300, speed: 1.5, wind: 0, verticalVariation: 0 });

  const santa = document.createElement('span');
  santa.className = 'jellio-seasonal-santa';
  santa.textContent = '🎅';
  container.appendChild(santa);

  let frameId = null;
  let restTimer = null;
  const presentTimers = [];
  const gifts = ['🎁', '🎀'];

  function dropPresent(x, y) {
    const present = document.createElement('span');
    present.className = 'jellio-seasonal-santa-present';
    present.textContent = gifts[Math.floor(Math.random() * gifts.length)];
    present.style.left = x + 'px';
    present.style.top = y + 'px';
    const duration = rand(2, 5);
    present.style.transition = 'top ' + duration + 's linear';
    container.appendChild(present);
    window.requestAnimationFrame(function () {
      present.style.top = window.innerHeight + 'px';
    });
    const timer = window.setTimeout(function () {
      present.remove();
    }, duration * 1000 + 100);
    presentTimers.push(timer);
  }

  function flyOnce() {
    if (!container.isConnected) return;
    const fromLeft = Math.random() < 0.5;
    const screenWidth = window.innerWidth;
    const screenHeight = window.innerHeight;
    const startX = fromLeft ? -140 : screenWidth + 140;
    const endX = fromLeft ? screenWidth + 140 : -140;
    const startY = rand(20, screenHeight / 5);
    const endY = rand(20, screenHeight / 5);
    const angle = rand(-8, 8);
    santa.style.transform = 'rotate(' + angle + 'deg)' + (fromLeft ? ' scaleX(-1)' : '');

    const duration = window.matchMedia('(max-width: 768px)').matches ? 8000 : 10000;
    const deltaX = endX - startX;
    const deltaY = endY - startY;
    const startTime = performance.now();

    function move() {
      const elapsed = performance.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const currentY = startY + deltaY * progress - 50 * Math.sin(progress * Math.PI);
      const currentX = startX + deltaX * progress;
      santa.style.left = currentX + 'px';
      santa.style.top = currentY + 'px';
      if (Math.random() < 0.05) dropPresent(currentX, currentY + 30);
      if (progress < 1) {
        frameId = window.requestAnimationFrame(move);
      } else {
        restTimer = window.setTimeout(flyOnce, rand(3000, 8000));
      }
    }
    frameId = window.requestAnimationFrame(move);
  }
  flyOnce();

  return function cleanup() {
    if (frameId) window.cancelAnimationFrame(frameId);
    if (restTimer) window.clearTimeout(restTimer);
    presentTimers.forEach(window.clearTimeout);
    cleanupSnow();
  };
}

// Ported in spirit from CodeDevMLH/Jellyfin-Seasonals' own real
// marioday.js: a runner crossing the screen on a fixed real loop,
// occasionally jumping (a CSS class toggled on and off) and dropping a
// coin near its own current position, that real plugin's own
// getBoundingClientRect() read used the same way here to place the
// coin exactly where the runner actually is rather than a guess.
function buildMarioDay(container) {
  const wrapper = document.createElement('div');
  wrapper.className = 'jellio-seasonal-mario-wrapper';
  const runner = document.createElement('span');
  runner.className = 'jellio-seasonal-mario-runner';
  runner.textContent = '🍄';
  wrapper.appendChild(runner);
  container.appendChild(wrapper);

  let jumpCount = 0;
  let maxJumps = Math.floor(rand(0, 3));
  const resetInterval = window.setInterval(function () {
    jumpCount = 0;
    maxJumps = Math.floor(rand(0, 3));
  }, 9000);

  const coinInterval = window.setInterval(function () {
    if (!container.isConnected) return;
    const rect = wrapper.getBoundingClientRect();
    if (rect.left < 0 || rect.right > window.innerWidth) return;
    if (!runner.classList.contains('jellio-seasonal-mario-jump') && jumpCount < maxJumps) {
      runner.classList.add('jellio-seasonal-mario-jump');
      jumpCount++;
      window.setTimeout(function () {
        runner.classList.remove('jellio-seasonal-mario-jump');
      }, 800);
    }
    const coin = document.createElement('span');
    coin.className = 'jellio-seasonal-mario-coin';
    coin.textContent = '🪙';
    coin.style.left = rect.left + 16 + 'px';
    container.appendChild(coin);
    window.setTimeout(function () {
      coin.remove();
    }, 2000);
  }, 4000);

  return function cleanup() {
    window.clearInterval(resetInterval);
    window.clearInterval(coinInterval);
  };
}

// Shared by Storm/Rain below: CodeDevMLH/Jellyfin-Seasonals' own real
// storm.js and rain.js build this exact same falling raindrop streak,
// storm.js's own only addition being the lightning flash, confirmed
// against both real sources, one real shared builder for the drops.
function buildRainDrops(container, count) {
  for (let i = 0; i < count; i++) {
    const drop = document.createElement('span');
    drop.className = 'jellio-seasonal-raindrop';
    drop.style.left = rand(0, 140) + 'vw';
    drop.style.top = -20 - rand(0, 50) + 'vh';
    drop.style.animationDuration = rand(0.5, 1) + 's';
    drop.style.animationDelay = rand(0, 2) + 's';
    drop.style.opacity = String(rand(0.3, 0.8));
    container.appendChild(drop);
  }
}

function buildRain(container) {
  buildRainDrops(container, window.matchMedia('(max-width: 768px)').matches ? 150 : 300);
}

function buildStorm(container) {
  buildRainDrops(container, window.matchMedia('(max-width: 768px)').matches ? 150 : 300);
  const flash = document.createElement('div');
  flash.className = 'jellio-seasonal-lightning-flash';
  container.appendChild(flash);

  let timer = null;
  function triggerFlash() {
    const nextDelay = rand(5000, 15000);
    timer = window.setTimeout(function () {
      flash.style.opacity = '0.8';
      window.setTimeout(function () {
        flash.style.opacity = '0';
      }, 50);
      window.setTimeout(function () {
        flash.style.opacity = '0.5';
      }, 100);
      window.setTimeout(function () {
        flash.style.opacity = '0';
      }, 150);
      triggerFlash();
    }, nextDelay);
  }
  triggerFlash();

  return function cleanup() {
    if (timer) window.clearTimeout(timer);
  };
}

// Ported in spirit from CodeDevMLH/Jellyfin-Seasonals' own real
// sports.js: a turf gradient along the bottom, bouncing/spinning balls
// (one outer element bouncing, one inner element spinning, exactly
// that real plugin's own two-element split so the bounce and the spin
// never fight over the same transform) and falling confetti reusing
// carnival's own real shaped-confetti markup. The real trophy arc and
// per-category ball art aren't ported (real emoji standing in for a
// generic ball set instead), a corner of this theme left simplified.
function buildSports(container) {
  const turf = document.createElement('div');
  turf.className = 'jellio-seasonal-sports-turf';
  container.appendChild(turf);

  const balls = ['⚽', '🏀', '🎾', '🏐'];
  const count = window.matchMedia('(max-width: 768px)').matches ? 3 : 5;
  balls.forEach(function (glyph) {
    for (let i = 0; i < count; i++) {
      const outer = document.createElement('span');
      outer.className = 'jellio-seasonal-sports-ball';
      const inner = document.createElement('span');
      inner.className = 'jellio-seasonal-sports-ball-spin';
      inner.textContent = glyph;
      outer.appendChild(inner);
      outer.style.left = rand(0, 95) + 'vw';
      outer.style.animationDuration = rand(6, 10) + 's';
      outer.style.animationDelay = rand(0, 10) + 's';
      inner.style.animationDuration = rand(2, 4) + 's';
      inner.style.setProperty('--jellio-sports-spin', (Math.random() > 0.5 ? 360 : -360) + 'deg');
      container.appendChild(outer);
    }
  });

  const confettiColors = ['#000000', '#ff0000', '#ffcc00'];
  for (let i = 0; i < (window.matchMedia('(max-width: 768px)').matches ? 30 : 60); i++) {
    spawnCarnivalPiece(container, confettiColors);
  }
}

let mountedContainer = null;
let activeCleanup = null;
let activeTheme = null;

function teardownTheme() {
  if (activeCleanup) {
    activeCleanup();
    activeCleanup = null;
  }
  if (mountedContainer) mountedContainer.textContent = '';
  activeTheme = null;
}

function applyTheme(theme) {
  if (theme === activeTheme) return;
  teardownTheme();
  if (!theme) return;
  activeTheme = theme;
  mountedContainer.dataset.jellioSeasonalTheme = theme;

  if (theme === 'newyear') {
    activeCleanup = buildFireworks(mountedContainer);
  } else if (theme === 'friday13') {
    buildFriday13(mountedContainer);
  } else if (theme === 'matrix') {
    activeCleanup = buildMatrix(mountedContainer);
  } else if (theme === 'nightsky') {
    activeCleanup = buildNightSky(mountedContainer);
  } else if (theme === 'filmnoir') {
    buildFilmNoir(mountedContainer);
  } else if (theme === 'starwars') {
    buildStarWars(mountedContainer);
  } else if (theme === 'oscar') {
    activeCleanup = buildOscar(mountedContainer);
  } else if (theme === 'frost') {
    buildFrost(mountedContainer);
  } else if (theme === 'carnival') {
    buildCarnival(mountedContainer);
  } else if (theme === 'space') {
    activeCleanup = buildSpace(mountedContainer);
  } else if (theme === 'underwater') {
    buildUnderwater(mountedContainer);
  } else if (theme === 'santa') {
    activeCleanup = buildSanta(mountedContainer);
  } else if (theme === 'marioday') {
    activeCleanup = buildMarioDay(mountedContainer);
  } else if (theme === 'storm') {
    activeCleanup = buildStorm(mountedContainer);
  } else if (theme === 'rain') {
    buildRain(mountedContainer);
  } else if (theme === 'sports') {
    buildSports(mountedContainer);
  } else if (theme === 'snowfall') {
    activeCleanup = buildSnowfall(mountedContainer);
  } else if (theme === 'snowstorm') {
    activeCleanup = buildSnowstorm(mountedContainer);
  } else {
    buildDrift(mountedContainer, DRIFT_THEMES[theme]);
  }
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
    console.warn('Jellio: could not load seasonal effects config', err);
    return;
  }
  applyTheme(activeSeasonalTheme(new Date(), config));
}

// Called once from app.js, right where it already sets up the real
// root shell (idempotent the same way components/sidebar.js's own
// dataset marker keeps its own real one-time build from repeating on
// every ordinary navigation), appended as a real child of that same
// root rather than document.body: the sidebar and mobile nav mounts
// already hide during screens/player.js's own fullscreen route through
// a plain .jellio-root-fullscreen descendant rule in css/app.css, same
// real mechanism here, no separate hashchange listener or any other
// real coupling to this runtime's own router needed.
export function mountSeasonalEffects(root) {
  if (mountedContainer) return;
  mountedContainer = document.createElement('div');
  mountedContainer.className = 'jellio-seasonal-effects';
  root.appendChild(mountedContainer);
  refresh();
  // A reader who leaves this tab open across midnight (New Year's own
  // real edge case, or any other theme's own boundary), or across
  // whatever an admin just changed server side, still gets the right
  // real theme without a full reload.
  window.setInterval(refresh, 5 * 60 * 1000);
}
