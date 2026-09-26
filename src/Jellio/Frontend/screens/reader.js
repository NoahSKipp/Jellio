// In-browser EPUB/PDF reader for a Jellyfin Book item. epub.js (with
// JSZip) and pdf.js are vendored under Frontend/vendor and only loaded
// when a book is actually opened. The file itself comes through
// Controllers/ReadingController.cs as an ArrayBuffer, and where the reader
// got to is saved back there (an EPUB CFI, or "page:N" for a PDF).
import { getItem, getReadingProgress, saveReadingProgress, fetchBookFile, setPlayed } from '../runtime/api.js';
import { navigateTo, setTitle } from '../runtime/router.js';
import { loadVendorScript, vendorUrl } from '../runtime/vendorScript.js';
import { renderLoading, renderRetry } from '../components/networkState.js';
import { invalidateHomeSections } from './home.js';
import { el } from '../runtime/dom.js';

const SETTINGS_KEY = 'jellio-reader-settings';
const SAVE_DEBOUNCE_MS = 2000;
const FINISHED_THRESHOLD = 0.98;
const THEMES = ['dark', 'sepia', 'light'];
const THEME_LABELS = { dark: 'Dark', sepia: 'Sepia', light: 'Light' };
// Colours applied inside the EPUB's own iframe, which the page's own CSS
// cannot reach.
const EPUB_THEMES = {
  dark: { body: { background: '#121212', color: '#e6e6e6' }, a: { color: '#8ab4f8' } },
  sepia: { body: { background: '#f4ecd8', color: '#433422' }, a: { color: '#7a4b12' } },
  light: { body: { background: '#ffffff', color: '#1a1a1a' }, a: { color: '#1a55c4' } },
};

function loadSettings() {
  const defaults = { theme: 'dark', fontSize: 100 };
  try {
    const saved = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || 'null');
    if (!saved) return defaults;
    return {
      theme: THEMES.indexOf(saved.theme) !== -1 ? saved.theme : defaults.theme,
      fontSize: Math.min(200, Math.max(70, Number(saved.fontSize) || defaults.fontSize)),
    };
  } catch (err) {
    return defaults;
  }
}

function storeSettings(settings) {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (err) {
    // Private mode or storage blocked: the reader still works, it just
    // won't remember the theme next time.
  }
}

function iconButton(icon, label, className) {
  const button = el('button', 'jellio-reader-icon-button' + (className ? ' ' + className : ''));
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.appendChild(el('span', 'material-icons ' + icon));
  return button;
}

async function openEpub(stage, buffer, savedLocator, settings, onLocation) {
  await loadVendorScript('jszip.min.js');
  await loadVendorScript('epub.min.js');
  if (typeof window.ePub !== 'function') throw new Error('epub.js did not load');

  const book = window.ePub(buffer);
  const rendition = book.renderTo(stage, {
    width: '100%',
    height: '100%',
    flow: 'paginated',
    spread: 'auto',
    allowScriptedContent: false,
  });
  Object.keys(EPUB_THEMES).forEach(function (name) {
    rendition.themes.register(name, EPUB_THEMES[name]);
  });
  rendition.themes.select(settings.theme);
  rendition.themes.fontSize(settings.fontSize + '%');

  let locationsReady = false;
  let lastCfi = null;

  function report(location) {
    if (!location || !location.start) return;
    lastCfi = location.start.cfi;
    const progress = locationsReady ? book.locations.percentageFromCfi(lastCfi) : null;
    onLocation(lastCfi, progress);
  }

  rendition.on('relocated', report);

  await rendition.display(savedLocator || undefined);

  // Location generation walks the whole book, so it runs after the first
  // page is already on screen rather than holding it up.
  book.ready
    .then(function () {
      return book.locations.generate(1600);
    })
    .then(function () {
      locationsReady = true;
      if (lastCfi) onLocation(lastCfi, book.locations.percentageFromCfi(lastCfi));
    })
    .catch(function (err) {
      console.warn('Jellio: could not generate EPUB locations', err);
    });

  return {
    kind: 'epub',
    next: function () {
      rendition.next();
    },
    prev: function () {
      rendition.prev();
    },
    goTo: function (target) {
      rendition.display(target);
    },
    toc: function () {
      return book.loaded.navigation.then(function (navigation) {
        return (navigation && navigation.toc) || [];
      });
    },
    applySettings: function (next) {
      rendition.themes.select(next.theme);
      rendition.themes.fontSize(next.fontSize + '%');
    },
    onKey: function (handler) {
      // Key presses inside the book's own iframe never reach document.
      rendition.on('keyup', handler);
    },
    resize: function () {},
    destroy: function () {
      book.destroy();
    },
  };
}

async function openPdf(stage, buffer, savedLocator, onLocation) {
  await loadVendorScript('pdf.min.js');
  const pdfjsLib = window.pdfjsLib;
  if (!pdfjsLib) throw new Error('pdf.js did not load');
  pdfjsLib.GlobalWorkerOptions.workerSrc = vendorUrl('pdf.worker.min.js');

  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const canvas = el('canvas', 'jellio-reader-pdf-canvas');
  stage.appendChild(canvas);

  const savedMatch = /^page:(\d+)$/.exec(savedLocator || '');
  let pageNumber = savedMatch ? Math.min(pdf.numPages, Math.max(1, Number(savedMatch[1]))) : 1;
  let renderTask = null;

  async function renderPage() {
    const page = await pdf.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(stage.clientWidth / base.width, stage.clientHeight / base.height) || 1;
    const ratio = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: scale * ratio });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = Math.floor(viewport.width / ratio) + 'px';
    canvas.style.height = Math.floor(viewport.height / ratio) + 'px';
    if (renderTask) renderTask.cancel();
    renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport });
    try {
      await renderTask.promise;
    } catch (err) {
      if (!err || err.name !== 'RenderingCancelledException') throw err;
    }
    onLocation('page:' + pageNumber, pdf.numPages > 1 ? (pageNumber - 1) / (pdf.numPages - 1) : 1, pageNumber, pdf.numPages);
  }

  function go(delta) {
    const target = Math.min(pdf.numPages, Math.max(1, pageNumber + delta));
    if (target === pageNumber) return;
    pageNumber = target;
    renderPage();
  }

  await renderPage();

  return {
    kind: 'pdf',
    next: function () {
      go(1);
    },
    prev: function () {
      go(-1);
    },
    goTo: function () {},
    toc: function () {
      return Promise.resolve([]);
    },
    applySettings: function () {},
    onKey: function () {},
    resize: function () {
      renderPage();
    },
    destroy: function () {
      if (renderTask) renderTask.cancel();
      pdf.destroy();
    },
  };
}

export async function renderReader(root, params) {
  const itemId = params.get('id');
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-reader';
  if (!itemId) return;

  renderLoading(root, 'Opening book…');

  let item;
  let saved;
  let file;
  try {
    [item, saved, file] = await Promise.all([
      getItem(itemId),
      getReadingProgress(itemId).catch(function () {
        return null;
      }),
      fetchBookFile(itemId),
    ]);
  } catch (err) {
    console.warn('Jellio: could not open book', err);
    renderRetry(
      root,
      err && err.status === 415
        ? 'This book’s format can’t be opened in the reader yet. EPUB and PDF are supported.'
        : 'Could not open this book.',
      function () {
        renderReader(root, params);
      },
    );
    return;
  }

  setTitle((item.Name || 'Reader') + ' - Jellio');
  const settings = loadSettings();

  root.textContent = '';
  root.classList.add('jellio-reader-theme-' + settings.theme);

  const topbar = el('div', 'jellio-reader-topbar');
  const backButton = iconButton('arrow_back', 'Back');
  backButton.addEventListener('click', function () {
    navigateTo('#/item?id=' + itemId);
  });
  topbar.appendChild(backButton);
  topbar.appendChild(el('div', 'jellio-reader-title', item.Name || ''));
  const tocButton = iconButton('toc', 'Contents');
  const settingsButton = iconButton('text_fields', 'Reading settings');
  topbar.appendChild(tocButton);
  topbar.appendChild(settingsButton);
  root.appendChild(topbar);

  const body = el('div', 'jellio-reader-body');
  const prevButton = iconButton('chevron_left', 'Previous page', 'jellio-reader-turn jellio-reader-turn-prev');
  const nextButton = iconButton('chevron_right', 'Next page', 'jellio-reader-turn jellio-reader-turn-next');
  const stage = el('div', 'jellio-reader-stage');
  body.appendChild(prevButton);
  body.appendChild(stage);
  body.appendChild(nextButton);
  root.appendChild(body);

  const footer = el('div', 'jellio-reader-footer');
  const progressLabel = el('span', 'jellio-reader-progress', '');
  footer.appendChild(progressLabel);
  root.appendChild(footer);

  const tocPanel = el('div', 'jellio-reader-panel jellio-reader-panel-hidden');
  const settingsPanel = el('div', 'jellio-reader-panel jellio-reader-panel-hidden');
  root.appendChild(tocPanel);
  root.appendChild(settingsPanel);

  let latestLocator = saved && saved.Locator ? saved.Locator : '';
  let latestProgress = saved && saved.Progress ? saved.Progress : 0;
  let saveTimer = null;
  let markedFinished = false;
  let dirty = false;

  function flushSave() {
    if (saveTimer) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!dirty || !latestLocator) return;
    dirty = false;
    saveReadingProgress(itemId, latestLocator, latestProgress).catch(function (err) {
      console.warn('Jellio: could not save reading progress', err);
    });
  }

  function onLocation(locator, progress, pageNumber, pageCount) {
    latestLocator = locator;
    if (typeof progress === 'number' && !Number.isNaN(progress)) latestProgress = progress;
    dirty = true;
    if (pageCount) {
      progressLabel.textContent = 'Page ' + pageNumber + ' of ' + pageCount;
    } else {
      progressLabel.textContent = Math.round(latestProgress * 100) + '%';
    }
    if (!markedFinished && latestProgress >= FINISHED_THRESHOLD) {
      markedFinished = true;
      setPlayed(itemId, true).catch(function (err) {
        console.warn('Jellio: could not mark book as read', err);
      });
    }
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(flushSave, SAVE_DEBOUNCE_MS);
  }

  let reader;
  try {
    const isPdf = /pdf/i.test(file.contentType);
    reader = isPdf
      ? await openPdf(stage, file.buffer, latestLocator, onLocation)
      : await openEpub(stage, file.buffer, latestLocator, settings, onLocation);
  } catch (err) {
    console.warn('Jellio: could not render book', err);
    renderRetry(root, 'Could not open this book.', function () {
      renderReader(root, params);
    });
    return;
  }

  if (reader.kind === 'pdf') tocButton.hidden = true;

  prevButton.addEventListener('click', function () {
    reader.prev();
  });
  nextButton.addEventListener('click', function () {
    reader.next();
  });

  function closePanels() {
    tocPanel.classList.add('jellio-reader-panel-hidden');
    settingsPanel.classList.add('jellio-reader-panel-hidden');
  }

  function handleKey(event) {
    if (event.key === 'ArrowRight' || event.key === 'PageDown') reader.next();
    else if (event.key === 'ArrowLeft' || event.key === 'PageUp') reader.prev();
    else if (event.key === 'Escape') closePanels();
  }
  document.addEventListener('keydown', handleKey);
  reader.onKey(handleKey);

  // Swipe to turn pages on touch screens; the EPUB's own iframe swallows
  // its own touches, so this only fires on the chrome around it and on
  // PDF pages.
  let touchStartX = null;
  body.addEventListener('touchstart', function (event) {
    touchStartX = event.touches[0].clientX;
  }, { passive: true });
  body.addEventListener('touchend', function (event) {
    if (touchStartX === null) return;
    const delta = event.changedTouches[0].clientX - touchStartX;
    touchStartX = null;
    if (delta < -50) reader.next();
    else if (delta > 50) reader.prev();
  });

  let resizeTimer = null;
  function handleResize() {
    if (resizeTimer) window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(reader.resize, 200);
  }
  window.addEventListener('resize', handleResize);

  tocButton.addEventListener('click', function () {
    const opening = tocPanel.classList.contains('jellio-reader-panel-hidden');
    closePanels();
    if (!opening) return;
    tocPanel.textContent = '';
    tocPanel.appendChild(el('h2', 'jellio-reader-panel-title', 'Contents'));
    const list = el('div', 'jellio-reader-toc');
    tocPanel.appendChild(list);
    tocPanel.classList.remove('jellio-reader-panel-hidden');
    reader.toc().then(function (toc) {
      if (!toc.length) {
        list.appendChild(el('p', 'jellio-reader-empty', 'This book has no table of contents.'));
        return;
      }
      function addEntries(entries, depth) {
        entries.forEach(function (entry) {
          const button = el('button', 'jellio-reader-toc-entry', (entry.label || '').trim());
          button.type = 'button';
          button.style.paddingLeft = 0.75 + depth * 1 + 'em';
          button.addEventListener('click', function () {
            reader.goTo(entry.href);
            closePanels();
          });
          list.appendChild(button);
          if (entry.subitems && entry.subitems.length) addEntries(entry.subitems, depth + 1);
        });
      }
      addEntries(toc, 0);
    });
  });

  function paintSettings() {
    settingsPanel.textContent = '';
    settingsPanel.appendChild(el('h2', 'jellio-reader-panel-title', 'Reading settings'));

    const themeRow = el('div', 'jellio-reader-setting-row');
    THEMES.forEach(function (theme) {
      const button = el(
        'button',
        'jellio-reader-chip jellio-reader-chip-' + theme + (settings.theme === theme ? ' jellio-reader-chip-active' : ''),
        THEME_LABELS[theme],
      );
      button.type = 'button';
      button.addEventListener('click', function () {
        root.classList.remove('jellio-reader-theme-' + settings.theme);
        settings.theme = theme;
        root.classList.add('jellio-reader-theme-' + theme);
        storeSettings(settings);
        reader.applySettings(settings);
        paintSettings();
      });
      themeRow.appendChild(button);
    });
    settingsPanel.appendChild(themeRow);

    if (reader.kind === 'epub') {
      const sizeRow = el('div', 'jellio-reader-setting-row');
      const smaller = iconButton('text_decrease', 'Smaller text');
      const larger = iconButton('text_increase', 'Larger text');
      const sizeLabel = el('span', 'jellio-reader-size-label', settings.fontSize + '%');
      function changeSize(delta) {
        settings.fontSize = Math.min(200, Math.max(70, settings.fontSize + delta));
        storeSettings(settings);
        reader.applySettings(settings);
        sizeLabel.textContent = settings.fontSize + '%';
      }
      smaller.addEventListener('click', function () {
        changeSize(-10);
      });
      larger.addEventListener('click', function () {
        changeSize(10);
      });
      sizeRow.appendChild(smaller);
      sizeRow.appendChild(sizeLabel);
      sizeRow.appendChild(larger);
      settingsPanel.appendChild(sizeRow);
    }
  }

  settingsButton.addEventListener('click', function () {
    const opening = settingsPanel.classList.contains('jellio-reader-panel-hidden');
    closePanels();
    if (!opening) return;
    paintSettings();
    settingsPanel.classList.remove('jellio-reader-panel-hidden');
  });

  return function cleanup() {
    flushSave();
    document.removeEventListener('keydown', handleKey);
    window.removeEventListener('resize', handleResize);
    if (resizeTimer) window.clearTimeout(resizeTimer);
    try {
      reader.destroy();
    } catch (err) {
      console.warn('Jellio: reader cleanup failed', err);
    }
    invalidateHomeSections();
  };
}
