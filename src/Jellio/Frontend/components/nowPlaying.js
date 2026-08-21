// Now playing panel: shows every active session on the server, usernames
// included, real endpoint backed by Jellio's own ISessionManager reader
// (Controllers/NowPlayingController.cs, ported verbatim from the original
// Jellio codebase), no cron job or static file needed the way community
// scripts without a plugin backend have to do it. Self starting, module
// level singleton (an ES module only ever runs once), so this file's own
// poll loop and panel element exist for the lifetime of the page rather
// than being recreated on every sidebar render the way the original
// reskin's own IIFE version had to coordinate over a DOM CustomEvent
// between two independently loaded classic scripts, not needed here
// since sidebar.js can just import and call this module's own exports
// directly.
import { getNowPlayingSessions, getImageUrl } from '../runtime/api.js';
import { isAuthenticated } from '../runtime/auth.js';

const POLL_INTERVAL_MS = 10000;

let panel = null;
let started = false;
let lastCount = 0;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function subtitle(item) {
  if (item.Type === 'Episode') {
    const parts = [];
    if (item.ParentIndexNumber != null && item.IndexNumber != null) {
      parts.push('S' + item.ParentIndexNumber + ' E' + item.IndexNumber);
    }
    return parts.join(' • ');
  }
  return item.ProductionYear ? String(item.ProductionYear) : '';
}

function displayTitle(item) {
  if (item.Type === 'Episode' && item.SeriesName) return item.SeriesName;
  return item.Name || '';
}

function buildRow(session) {
  const row = el('div', 'jellio-now-playing-row');

  const item = session.Item;
  const poster = el('div', 'jellio-now-playing-row-poster');
  const imageId = item.Type === 'Episode' && item.SeriesId ? item.SeriesId : item.Id;
  poster.style.backgroundImage = 'url(' + getImageUrl(imageId, 'Primary', { maxWidth: 200 }) + ')';
  row.appendChild(poster);

  const text = el('div', null);
  text.appendChild(el('p', 'jellio-now-playing-row-title', displayTitle(item)));
  const metaBits = [session.UserName];
  const sub = subtitle(item);
  if (sub) metaBits.push(sub);
  metaBits.push(session.IsPaused ? 'Paused' : 'Playing');
  text.appendChild(el('p', 'jellio-now-playing-row-meta', metaBits.filter(Boolean).join(' • ')));
  row.appendChild(text);

  return row;
}

function render(sessions) {
  const button = document.querySelector('.jellio-sidebar-now-playing');
  const badge = document.querySelector('.jellio-sidebar-now-playing-badge');
  lastCount = sessions.length;
  if (badge) badge.textContent = String(sessions.length);
  if (button) button.classList.toggle('jellio-sidebar-now-playing-active', sessions.length > 0);

  panel.textContent = '';
  if (!sessions.length) {
    panel.appendChild(el('div', 'jellio-now-playing-empty', 'Nothing playing right now'));
    return;
  }
  sessions.forEach(function (session) {
    panel.appendChild(buildRow(session));
  });
}

function poll() {
  getNowPlayingSessions()
    .then(function (sessions) {
      render(sessions || []);
    })
    .catch(function () {
      // Leave whatever was last shown, a failed poll is not worth
      // disrupting the panel over, it will try again on the next tick.
    })
    .then(function () {
      window.setTimeout(poll, POLL_INTERVAL_MS);
    });
}

function createPanel() {
  panel = el('div', 'jellio-now-playing-panel');
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'Now playing');
  document.body.appendChild(panel);

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && panel.classList.contains('jellio-now-playing-panel-visible')) {
      hideNowPlayingPanel();
      const trigger = document.querySelector('.jellio-sidebar-now-playing');
      if (trigger) trigger.focus();
    }
  });
}

export function toggleNowPlayingPanel() {
  if (!panel) return;
  const visible = panel.classList.toggle('jellio-now-playing-panel-visible');
  const button = document.querySelector('.jellio-sidebar-now-playing');
  if (button) button.setAttribute('aria-expanded', String(visible));
}

export function hideNowPlayingPanel() {
  if (!panel) return;
  panel.classList.remove('jellio-now-playing-panel-visible');
  const button = document.querySelector('.jellio-sidebar-now-playing');
  if (button) button.setAttribute('aria-expanded', 'false');
}

// Called from app.js's own sync() once a session is confirmed
// authenticated, not at module load: this runtime's own session may not
// exist yet on first page load, and there is no point polling a real
// endpoint before there is a real token to send it.
export function startNowPlaying() {
  if (started || !isAuthenticated()) return;
  started = true;
  createPanel();
  poll();
}

export function nowPlayingCount() {
  return lastCount;
}
