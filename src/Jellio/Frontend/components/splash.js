import { t } from '../runtime/i18n.js';
const SPLASH_ID = 'jellioSplash';
const HIDE_TRANSITION_MS = 420;

export function showSplash() {
  if (document.getElementById(SPLASH_ID)) return;

  const splash = document.createElement('div');
  splash.id = SPLASH_ID;

  const mark = document.createElement('div');
  mark.className = 'jellio-splash-mark';

  const logo = document.createElement('img');
  logo.className = 'jellio-splash-logo';
  logo.src = '/Jellio/frontend/img/jellio-mark-animated.svg';
  logo.alt = '';
  mark.appendChild(logo);

  const word = document.createElement('div');
  word.className = 'jellio-splash-word';
  word.textContent = 'Jellio';
  mark.appendChild(word);

  const loading = document.createElement('div');
  loading.className = 'jellio-splash-loading';
  loading.textContent = t('status_loading');
  mark.appendChild(loading);

  splash.appendChild(mark);
  document.body.appendChild(splash);
}

export function setSplashTotal() {}

export function reportSplashStep() {}

export function hideSplash() {
  const splash = document.getElementById(SPLASH_ID);
  if (!splash) return;
  splash.classList.add('jellio-splash-hidden');
  window.setTimeout(function () {
    splash.remove();
  }, HIDE_TRANSITION_MS);
}
