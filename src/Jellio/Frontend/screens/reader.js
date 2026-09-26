// In-browser EPUB/PDF reader for a Jellyfin Book item. epub.js (with
// JSZip) and pdf.js are vendored under Frontend/vendor and only loaded
// when a book is actually opened. The file itself comes through
// Controllers/ReadingController.cs as an ArrayBuffer, and where the reader
// got to is saved back there (an EPUB CFI, or "page:N" for a PDF).
//
// Both formats sit behind one small reader interface (next/prev/goTo/
// seek/search/toc/applySettings/resize/destroy) so the chrome around them
// (panels, scrubber, keyboard, tap zones, immersive mode) is shared.
import { getItem, getReadingProgress, saveReadingProgress, fetchBookFile, setPlayed } from '../runtime/api.js';
import { navigateTo, setTitle } from '../runtime/router.js';
import { loadVendorScript, vendorUrl } from '../runtime/vendorScript.js';
import { renderLoading, renderRetry } from '../components/networkState.js';
import { invalidateHomeSections } from './home.js';
import { el } from '../runtime/dom.js';

const SETTINGS_KEY = 'jellio-reader-settings';
const SAVE_DEBOUNCE_MS = 2000;
const FINISHED_THRESHOLD = 0.98;
const SEARCH_RESULT_LIMIT = 200;
const SCRUB_STEPS = 1000;

const THEMES = ['dark', 'sepia', 'light'];
const THEME_LABELS = { dark: 'Dark', sepia: 'Sepia', light: 'Light' };
// Colours applied inside the EPUB's own iframe, which the page's own CSS
// cannot reach.
const EPUB_THEMES = {
  dark: { body: { background: '#121212', color: '#e6e6e6' }, a: { color: '#8ab4f8' } },
  sepia: { body: { background: '#f4ecd8', color: '#433422' }, a: { color: '#7a4b12' } },
  light: { body: { background: '#ffffff', color: '#1a1a1a' }, a: { color: '#1a55c4' } },
};

const FONTS = [
  { value: 'publisher', label: 'Original', css: null },
  { value: 'serif', label: 'Serif', css: 'Georgia, "Iowan Old Style", "Palatino Linotype", serif' },
  { value: 'sans', label: 'Sans', css: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  { value: 'mono', label: 'Mono', css: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace' },
];
const LINE_HEIGHTS = [
  { value: 'publisher', label: 'Original' },
  { value: '1.4', label: 'Tight' },
  { value: '1.65', label: 'Normal' },
  { value: '1.9', label: 'Loose' },
];
const WIDTHS = [
  { value: 'full', label: 'Full' },
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'narrow', label: 'Narrow' },
];
const LAYOUTS = [
  { value: 'paged', label: 'Single page' },
  { value: 'spread', label: 'Two pages' },
  { value: 'scroll', label: 'Scroll' },
];
const PDF_FITS = [
  { value: 'page', label: 'Fit page' },
  { value: 'width', label: 'Fit width' },
];

const DEFAULT_SETTINGS = {
  theme: 'dark',
  fontSize: 100,
  font: 'publisher',
  lineHeight: 'publisher',
  width: 'comfortable',
  layout: 'paged',
  pdfFit: 'page',
  pdfZoom: 100,
  pdfTint: false,
};

function pick(options, value, fallback) {
  return options.some((option) => option.value === value) ? value : fallback;
}

function loadSettings() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || 'null') || {};
    return {
      theme: THEMES.indexOf(saved.theme) !== -1 ? saved.theme : DEFAULT_SETTINGS.theme,
      fontSize: Math.min(200, Math.max(70, Number(saved.fontSize) || DEFAULT_SETTINGS.fontSize)),
      font: pick(FONTS, saved.font, DEFAULT_SETTINGS.font),
      lineHeight: pick(LINE_HEIGHTS, saved.lineHeight, DEFAULT_SETTINGS.lineHeight),
      width: pick(WIDTHS, saved.width, DEFAULT_SETTINGS.width),
      layout: pick(LAYOUTS, saved.layout, DEFAULT_SETTINGS.layout),
      pdfFit: pick(PDF_FITS, saved.pdfFit, DEFAULT_SETTINGS.pdfFit),
      pdfZoom: Math.min(300, Math.max(50, Number(saved.pdfZoom) || DEFAULT_SETTINGS.pdfZoom)),
      pdfTint: saved.pdfTint === true,
    };
  } catch (err) {
    return Object.assign({}, DEFAULT_SETTINGS);
  }
}

function storeSettings(settings) {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (err) {
    // Private mode or storage blocked: the reader still works, it just
    // won't remember these next time.
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

function excerptAround(text, index, length) {
  const start = Math.max(0, index - 50);
  const end = Math.min(text.length, index + length + 70);
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
}

// The reader's own CSS inside each EPUB section document: fonts and line
// spacing the publisher's stylesheet would otherwise win over.
function epubOverrideCss(settings) {
  const font = FONTS.find((option) => option.value === settings.font);
  const rules = [];
  if (font && font.css) {
    rules.push('body, body *:not(code):not(pre):not(kbd):not(samp) { font-family: ' + font.css + ' !important; }');
  }
  if (settings.lineHeight !== 'publisher') {
    rules.push('body, p, li, blockquote, dd, dt, div, span { line-height: ' + settings.lineHeight + ' !important; }');
  }
  rules.push('img, svg { max-width: 100%; height: auto; }');
  rules.push('::selection { background: rgb(255 196 0 / 0.35); }');
  return rules.join('\n');
}

function applyEpubCss(contents, settings) {
  const doc = contents && contents.document;
  if (!doc || !doc.head) return;
  let style = doc.getElementById('jellio-reader-style');
  if (!style) {
    style = doc.createElement('style');
    style.id = 'jellio-reader-style';
    doc.head.appendChild(style);
  }
  style.textContent = epubOverrideCss(settings);
}

function flattenToc(entries, depth, out) {
  (entries || []).forEach(function (entry) {
    out.push({ label: (entry.label || '').trim(), href: entry.href, depth: depth });
    flattenToc(entry.subitems, depth + 1, out);
  });
  return out;
}

function hrefPath(href) {
  return String(href || '')
    .split('#')[0]
    .replace(/^.*\//, '');
}

async function openEpub(stage, buffer, savedLocator, settings, handlers) {
  await loadVendorScript('jszip.min.js');
  await loadVendorScript('epub.min.js');
  if (typeof window.ePub !== 'function') throw new Error('epub.js did not load');

  const book = window.ePub(buffer);
  let rendition = null;
  let currentLayout = null;
  let locationsReady = false;
  let lastCfi = savedLocator || null;
  let flatToc = [];
  let searchHighlight = null;

  book.loaded.navigation
    .then(function (navigation) {
      flatToc = flattenToc(navigation && navigation.toc, 0, []);
    })
    .catch(function () {});

  function chapterFor(href) {
    const path = hrefPath(href);
    let match = null;
    flatToc.forEach(function (entry) {
      if (hrefPath(entry.href) === path) match = match || entry;
    });
    if (match) return match.label;
    // Sections between TOC entries belong to the last entry before them.
    const spineIndex = book.spine.spineItems.findIndex((section) => hrefPath(section.href) === path);
    for (let i = spineIndex; i >= 0; i--) {
      const sectionPath = hrefPath(book.spine.spineItems[i].href);
      const entry = flatToc.find((candidate) => hrefPath(candidate.href) === sectionPath);
      if (entry) return entry.label;
    }
    return '';
  }

  function report(location) {
    if (!location || !location.start) return;
    lastCfi = location.start.cfi;
    const progress = locationsReady ? book.locations.percentageFromCfi(lastCfi) : null;
    handlers.onLocation(lastCfi, progress, { chapter: chapterFor(location.start.href) });
  }

  // Layout changes are applied live (rendition.spread/flow): destroying
  // a rendition and rendering the same book again breaks epub.js.
  let scrolled = false;
  function applyLayout(layout) {
    scrolled = layout === 'scroll';
    rendition.spread(layout === 'spread' ? 'always' : 'none');
    rendition.flow(scrolled ? 'scrolled-doc' : 'paginated');
  }

  async function build(layout) {
    scrolled = layout === 'scroll';
    rendition = book.renderTo(stage, {
      width: '100%',
      height: '100%',
      flow: scrolled ? 'scrolled-doc' : 'paginated',
      spread: layout === 'spread' ? 'always' : 'none',
      allowScriptedContent: false,
    });
    Object.keys(EPUB_THEMES).forEach(function (name) {
      rendition.themes.register(name, EPUB_THEMES[name]);
    });
    rendition.themes.select(settings.theme);
    rendition.themes.fontSize(settings.fontSize + '%');
    rendition.hooks.content.register(function (contents) {
      applyEpubCss(contents, settings);
    });
    rendition.on('relocated', report);
    rendition.on('keyup', handlers.onKey);
    rendition.on('click', function (event) {
      if (event.target && event.target.closest && event.target.closest('a')) return;
      const view = event.view;
      const frame = view && view.frameElement;
      const frameLeft = frame ? frame.getBoundingClientRect().left : 0;
      handlers.onTap(frameLeft + event.clientX, scrolled, event.detail, function () {
        const selection = view && view.getSelection && view.getSelection();
        return !!(selection && String(selection).trim());
      });
    });
    await rendition.display(lastCfi || undefined);
  }

  currentLayout = settings.layout;
  await build(settings.layout);

  // Location generation walks the whole book, so it runs after the first
  // page is already on screen rather than holding it up.
  book.ready
    .then(function () {
      return book.locations.generate(1600);
    })
    .then(function () {
      locationsReady = true;
      handlers.onScrubReady(SCRUB_STEPS);
      if (lastCfi) {
        const location = rendition.currentLocation();
        handlers.onLocation(lastCfi, book.locations.percentageFromCfi(lastCfi), {
          chapter: location && location.start ? chapterFor(location.start.href) : '',
        });
      }
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
      return rendition.display(target);
    },
    seek: function (step) {
      if (!locationsReady) return;
      const cfi = book.locations.cfiFromPercentage(step / SCRUB_STEPS);
      if (cfi) rendition.display(cfi);
    },
    scrubValue: function (progress) {
      return Math.round((progress || 0) * SCRUB_STEPS);
    },
    toc: function () {
      return book.loaded.navigation.then(function (navigation) {
        return flattenToc(navigation && navigation.toc, 0, []).map(function (entry) {
          return { label: entry.label, depth: entry.depth, target: entry.href };
        });
      });
    },
    search: async function (query, isCurrent) {
      const results = [];
      for (const section of book.spine.spineItems) {
        if (!isCurrent()) return results;
        try {
          await section.load(book.load.bind(book));
          section.find(query).forEach(function (hit) {
            results.push({ target: hit.cfi, excerpt: hit.excerpt, label: chapterFor(section.href) });
          });
        } catch (err) {
          console.warn('Jellio: could not search a section', err);
        } finally {
          section.unload();
        }
        if (results.length >= SEARCH_RESULT_LIMIT) break;
      }
      return results.slice(0, SEARCH_RESULT_LIMIT);
    },
    showSearchHit: function (target) {
      if (searchHighlight) rendition.annotations.remove(searchHighlight, 'highlight');
      searchHighlight = target;
      return rendition.display(target).then(function () {
        rendition.annotations.highlight(target, {}, null, 'jellio-reader-search-hit', {
          fill: 'rgb(255, 196, 0)',
          'fill-opacity': '0.35',
        });
      });
    },
    applySettings: async function (next) {
      rendition.themes.select(next.theme);
      rendition.themes.fontSize(next.fontSize + '%');
      rendition.getContents().forEach(function (contents) {
        applyEpubCss(contents, next);
      });
      if (next.layout !== currentLayout) {
        currentLayout = next.layout;
        applyLayout(next.layout);
        if (lastCfi) await rendition.display(lastCfi);
      }
    },
    resize: function () {
      const rect = stage.getBoundingClientRect();
      if (rect.width && rect.height) rendition.resize(rect.width, rect.height);
    },
    destroy: function () {
      book.destroy();
    },
  };
}

// pdf.js outline destinations are either a named destination or an
// explicit one whose first element is a page reference (or index).
async function resolvePdfDest(pdf, dest) {
  const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
  if (!Array.isArray(explicit) || !explicit.length) return null;
  const ref = explicit[0];
  const index = typeof ref === 'number' ? ref : await pdf.getPageIndex(ref);
  return index + 1;
}

async function openPdf(stage, buffer, savedLocator, settings, handlers) {
  await loadVendorScript('pdf.min.js');
  const pdfjsLib = window.pdfjsLib;
  if (!pdfjsLib) throw new Error('pdf.js did not load');
  pdfjsLib.GlobalWorkerOptions.workerSrc = vendorUrl('pdf.worker.min.js');

  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  stage.classList.add('jellio-reader-stage-pdf');
  const pageWrap = el('div', 'jellio-reader-pdf-page');
  const canvas = el('canvas', 'jellio-reader-pdf-canvas');
  const textLayer = el('div', 'textLayer jellio-reader-pdf-text');
  pageWrap.appendChild(canvas);
  pageWrap.appendChild(textLayer);
  stage.appendChild(pageWrap);

  const savedMatch = /^page:(\d+)$/.exec(savedLocator || '');
  let pageNumber = savedMatch ? Math.min(pdf.numPages, Math.max(1, Number(savedMatch[1]))) : 1;
  let renderTask = null;
  let textTask = null;
  let renderToken = 0;
  let activeQuery = '';
  let current = Object.assign({}, settings);
  const pageTextCache = new Map();

  function paintTint() {
    const tint = current.pdfTint ? current.theme : 'none';
    pageWrap.dataset.tint = tint;
  }

  function markHits() {
    const query = activeQuery.toLowerCase();
    textLayer.querySelectorAll('span').forEach(function (span) {
      span.classList.toggle('jellio-reader-pdf-hit', !!query && span.textContent.toLowerCase().indexOf(query) !== -1);
    });
  }

  async function renderPage() {
    const token = ++renderToken;
    const page = await pdf.getPage(pageNumber);
    if (token !== renderToken) return;
    const base = page.getViewport({ scale: 1 });
    const availableWidth = Math.max(100, stage.clientWidth - 32);
    const availableHeight = Math.max(100, stage.clientHeight - 32);
    const fit =
      current.pdfFit === 'width'
        ? availableWidth / base.width
        : Math.min(availableWidth / base.width, availableHeight / base.height);
    const cssScale = (fit || 1) * (current.pdfZoom / 100);
    const ratio = window.devicePixelRatio || 1;
    const cssViewport = page.getViewport({ scale: cssScale });
    const viewport = page.getViewport({ scale: cssScale * ratio });

    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const cssWidth = Math.floor(cssViewport.width) + 'px';
    const cssHeight = Math.floor(cssViewport.height) + 'px';
    canvas.style.width = cssWidth;
    canvas.style.height = cssHeight;
    pageWrap.style.width = cssWidth;
    pageWrap.style.height = cssHeight;
    stage.classList.toggle('jellio-reader-stage-overflow', cssViewport.height > availableHeight + 32 || cssViewport.width > availableWidth + 32);

    if (renderTask) renderTask.cancel();
    if (textTask) textTask.cancel();
    renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport });
    try {
      await renderTask.promise;
    } catch (err) {
      if (!err || err.name !== 'RenderingCancelledException') throw err;
      return;
    }
    if (token !== renderToken) return;

    // A real text layer over the page image makes PDF text selectable
    // and searchable, same as an EPUB's.
    textLayer.textContent = '';
    textLayer.style.setProperty('--scale-factor', String(cssScale));
    try {
      const textContent = await page.getTextContent();
      if (token !== renderToken) return;
      textTask = pdfjsLib.renderTextLayer({
        textContentSource: textContent,
        container: textLayer,
        viewport: cssViewport,
        textDivs: [],
      });
      await textTask.promise;
      markHits();
    } catch (err) {
      if (!err || err.name !== 'AbortException') console.warn('Jellio: PDF text layer failed', err);
    }

    stage.scrollTop = 0;
    reportLocation();
  }

  // The outline section a page falls in doubles as its "chapter".
  let outlineEntries = [];
  function sectionFor(number) {
    let label = '';
    outlineEntries.forEach(function (entry) {
      if (entry.target <= number) label = entry.label;
    });
    return label;
  }

  function reportLocation() {
    handlers.onLocation('page:' + pageNumber, pdf.numPages > 1 ? (pageNumber - 1) / (pdf.numPages - 1) : 1, {
      pageNumber: pageNumber,
      pageCount: pdf.numPages,
      chapter: sectionFor(pageNumber),
    });
  }

  function show(target) {
    const clamped = Math.min(pdf.numPages, Math.max(1, target));
    if (clamped === pageNumber) return Promise.resolve();
    pageNumber = clamped;
    return renderPage();
  }

  async function pageText(number) {
    if (pageTextCache.has(number)) return pageTextCache.get(number);
    const page = await pdf.getPage(number);
    const content = await page.getTextContent();
    const text = content.items.map((item) => item.str + (item.hasEOL ? '\n' : '')).join('');
    pageTextCache.set(number, text);
    return text;
  }

  // Taps on the page image turn pages like an EPUB's; the text layer sits
  // on top, so a tap that ends in a selection is left alone.
  stage.addEventListener('click', function (event) {
    handlers.onTap(event.clientX, stage.classList.contains('jellio-reader-stage-overflow'), event.detail, function () {
      const selection = window.getSelection();
      return !!(selection && String(selection).trim());
    });
  });

  async function readOutline() {
    const outline = (await pdf.getOutline()) || [];
    const entries = [];
    async function walk(items, depth) {
      for (const item of items) {
        let target = null;
        try {
          target = item.dest ? await resolvePdfDest(pdf, item.dest) : null;
        } catch (err) {
          target = null;
        }
        if (target) entries.push({ label: (item.title || '').trim(), depth: depth, target: target });
        if (item.items && item.items.length) await walk(item.items, depth + 1);
      }
    }
    await walk(outline, 0);
    return entries;
  }

  const outlinePromise = readOutline().catch(function (err) {
    console.warn('Jellio: could not read the PDF outline', err);
    return [];
  });
  outlinePromise.then(function (entries) {
    outlineEntries = entries.slice().sort((a, b) => a.target - b.target);
    reportLocation();
  });

  paintTint();
  handlers.onScrubReady(pdf.numPages);
  await renderPage();

  return {
    kind: 'pdf',
    next: function () {
      show(pageNumber + 1);
    },
    prev: function () {
      show(pageNumber - 1);
    },
    goTo: function (target) {
      return show(Number(target) || 1);
    },
    seek: function (step) {
      show(step);
    },
    scrubValue: function () {
      return pageNumber;
    },
    toc: function () {
      return outlinePromise;
    },
    search: async function (query, isCurrent) {
      const results = [];
      const needle = query.toLowerCase();
      for (let number = 1; number <= pdf.numPages; number++) {
        if (!isCurrent()) return results;
        let text = '';
        try {
          text = await pageText(number);
        } catch (err) {
          continue;
        }
        const haystack = text.toLowerCase();
        let index = haystack.indexOf(needle);
        while (index !== -1 && results.length < SEARCH_RESULT_LIMIT) {
          results.push({ target: number, excerpt: excerptAround(text, index, query.length), label: 'Page ' + number });
          index = haystack.indexOf(needle, index + needle.length);
        }
        if (results.length >= SEARCH_RESULT_LIMIT) break;
      }
      return results;
    },
    setSearchQuery: function (query) {
      activeQuery = query || '';
      markHits();
    },
    showSearchHit: function (target) {
      if (target === pageNumber) {
        markHits();
        return Promise.resolve();
      }
      return show(target);
    },
    applySettings: function (next) {
      const rerender = next.pdfFit !== current.pdfFit || next.pdfZoom !== current.pdfZoom;
      current = Object.assign({}, next);
      paintTint();
      if (rerender) renderPage();
    },
    resize: function () {
      renderPage();
    },
    destroy: function () {
      if (renderTask) renderTask.cancel();
      if (textTask) textTask.cancel();
      pdf.destroy();
    },
  };
}

function optionChips(options, value, onPick) {
  const row = el('div', 'jellio-reader-setting-options');
  options.forEach(function (option) {
    const chip = el('button', 'jellio-reader-option' + (option.value === value ? ' jellio-reader-option-active' : ''), option.label);
    chip.type = 'button';
    chip.setAttribute('aria-pressed', option.value === value ? 'true' : 'false');
    chip.addEventListener('click', function () {
      onPick(option.value);
    });
    row.appendChild(chip);
  });
  return row;
}

function settingGroup(label, control) {
  const group = el('div', 'jellio-reader-setting');
  group.appendChild(el('div', 'jellio-reader-setting-label', label));
  group.appendChild(control);
  return group;
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
  const isPdf = /pdf/i.test(file.contentType);

  root.textContent = '';
  root.classList.add('jellio-reader-theme-' + settings.theme);
  root.dataset.width = settings.width;
  root.dataset.layout = settings.layout;

  const topbar = el('div', 'jellio-reader-topbar');
  const backButton = iconButton('arrow_back', 'Back');
  backButton.addEventListener('click', function () {
    navigateTo('#/item?id=' + itemId);
  });
  topbar.appendChild(backButton);
  const titleBlock = el('div', 'jellio-reader-title');
  titleBlock.appendChild(el('div', 'jellio-reader-title-book', item.Name || ''));
  const chapterLabel = el('div', 'jellio-reader-title-chapter');
  titleBlock.appendChild(chapterLabel);
  topbar.appendChild(titleBlock);
  const tocButton = iconButton('toc', 'Contents');
  const searchButton = iconButton('search', 'Search in book');
  const settingsButton = iconButton('text_fields', 'Reading settings');
  const fullscreenButton = iconButton('fullscreen', 'Full screen');
  topbar.appendChild(tocButton);
  topbar.appendChild(searchButton);
  topbar.appendChild(settingsButton);
  if (document.fullscreenEnabled) topbar.appendChild(fullscreenButton);
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
  const scrubber = document.createElement('input');
  scrubber.type = 'range';
  scrubber.className = 'jellio-reader-scrubber';
  scrubber.min = isPdf ? '1' : '0';
  scrubber.max = '1';
  scrubber.value = '0';
  scrubber.disabled = true;
  scrubber.setAttribute('aria-label', 'Position in book');
  const progressLabel = el('span', 'jellio-reader-progress', '');
  footer.appendChild(scrubber);
  footer.appendChild(progressLabel);
  root.appendChild(footer);

  const tocPanel = el('div', 'jellio-reader-panel jellio-reader-panel-hidden');
  const searchPanel = el('div', 'jellio-reader-panel jellio-reader-panel-hidden');
  const settingsPanel = el('div', 'jellio-reader-panel jellio-reader-panel-hidden');
  root.appendChild(tocPanel);
  root.appendChild(searchPanel);
  root.appendChild(settingsPanel);

  let latestLocator = saved && saved.Locator ? saved.Locator : '';
  let latestProgress = saved && saved.Progress ? saved.Progress : 0;
  let saveTimer = null;
  let markedFinished = false;
  let dirty = false;
  let scrubbing = false;
  let reader = null;

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

  function onLocation(locator, progress, detail) {
    const info = detail || {};
    latestLocator = locator;
    if (typeof progress === 'number' && !Number.isNaN(progress)) latestProgress = progress;
    dirty = true;
    const percent = Math.round(latestProgress * 100) + '%';
    progressLabel.textContent = info.pageCount ? 'Page ' + info.pageNumber + ' of ' + info.pageCount + ' · ' + percent : percent;
    if (typeof info.chapter === 'string') chapterLabel.textContent = info.chapter;
    if (reader && !scrubbing) scrubber.value = String(reader.scrubValue(latestProgress));
    if (!markedFinished && latestProgress >= FINISHED_THRESHOLD) {
      markedFinished = true;
      setPlayed(itemId, true).catch(function (err) {
        console.warn('Jellio: could not mark book as read', err);
      });
    }
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(flushSave, SAVE_DEBOUNCE_MS);
  }

  function onScrubReady(max) {
    scrubber.max = String(max);
    scrubber.disabled = max <= Number(scrubber.min);
    if (reader) scrubber.value = String(reader.scrubValue(latestProgress));
  }

  function toggleImmersive(force) {
    const next = typeof force === 'boolean' ? force : !root.classList.contains('jellio-reader-immersive');
    root.classList.toggle('jellio-reader-immersive', next);
    if (next) closePanels();
  }

  // Left and right thirds turn the page, the middle hides the chrome
  // (Apple Books/Audiobookshelf style). Scrolling layouts only take the
  // middle tap; turning is the scroll itself.
  //
  // A tap is held back briefly: a double-click (or a drag) selecting a
  // word must never also turn the page or hide the chrome.
  let tapTimer = null;
  function onTap(clientX, scrollingOnly, clickCount, hasSelection) {
    if (!reader) return;
    if (tapTimer) {
      window.clearTimeout(tapTimer);
      tapTimer = null;
    }
    if (clickCount > 1 || hasSelection()) return;
    tapTimer = window.setTimeout(function () {
      tapTimer = null;
      if (hasSelection()) return;
      if (panelOpen()) {
        closePanels();
        return;
      }
      const rect = stage.getBoundingClientRect();
      const x = (clientX - rect.left) / (rect.width || 1);
      if (!scrollingOnly && x < 0.3) reader.prev();
      else if (!scrollingOnly && x > 0.7) reader.next();
      else toggleImmersive();
    }, 250);
  }

  function handleKey(event) {
    if (!reader) return;
    const target = event.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
      if (event.key === 'Escape') closePanels();
      return;
    }
    if (event.key === 'ArrowRight' || event.key === 'PageDown' || (event.key === ' ' && !event.shiftKey)) {
      if (event.key === ' ' && settings.layout === 'scroll' && !isPdf) return;
      if (event.preventDefault) event.preventDefault();
      reader.next();
    } else if (event.key === 'ArrowLeft' || event.key === 'PageUp' || (event.key === ' ' && event.shiftKey)) {
      if (event.preventDefault) event.preventDefault();
      reader.prev();
    } else if (event.key === 'Escape') {
      if (panelOpen()) closePanels();
      else toggleImmersive(false);
    } else if (event.key === '/' || ((event.ctrlKey || event.metaKey) && event.key === 'f')) {
      if (event.preventDefault) event.preventDefault();
      openPanel(searchPanel, paintSearch);
    }
  }

  const handlers = { onLocation: onLocation, onScrubReady: onScrubReady, onTap: onTap, onKey: handleKey };

  try {
    reader = isPdf
      ? await openPdf(stage, file.buffer, latestLocator, settings, handlers)
      : await openEpub(stage, file.buffer, latestLocator, settings, handlers);
  } catch (err) {
    console.warn('Jellio: could not render book', err);
    renderRetry(root, 'Could not open this book.', function () {
      renderReader(root, params);
    });
    return;
  }
  scrubber.value = String(reader.scrubValue(latestProgress));

  prevButton.addEventListener('click', function () {
    reader.prev();
  });
  nextButton.addEventListener('click', function () {
    reader.next();
  });

  scrubber.addEventListener('input', function () {
    scrubbing = true;
    const value = Number(scrubber.value);
    progressLabel.textContent = isPdf
      ? 'Page ' + value + ' of ' + scrubber.max
      : Math.round((value / Number(scrubber.max)) * 100) + '%';
  });
  scrubber.addEventListener('change', function () {
    scrubbing = false;
    reader.seek(Number(scrubber.value));
  });

  function panelOpen() {
    return [tocPanel, searchPanel, settingsPanel].some((panel) => !panel.classList.contains('jellio-reader-panel-hidden'));
  }

  function closePanels() {
    [tocPanel, searchPanel, settingsPanel].forEach(function (panel) {
      panel.classList.add('jellio-reader-panel-hidden');
    });
  }

  function openPanel(panel, paint) {
    const opening = panel.classList.contains('jellio-reader-panel-hidden');
    closePanels();
    if (!opening) return;
    toggleImmersive(false);
    paint();
    panel.classList.remove('jellio-reader-panel-hidden');
  }

  document.addEventListener('keydown', handleKey);

  // Swipe to turn pages on touch screens; the EPUB's own iframe swallows
  // its own touches, so this only fires on the chrome around it and on
  // PDF pages.
  let touchStartX = null;
  body.addEventListener(
    'touchstart',
    function (event) {
      touchStartX = event.touches[0].clientX;
    },
    { passive: true },
  );
  body.addEventListener('touchend', function (event) {
    if (touchStartX === null) return;
    const delta = event.changedTouches[0].clientX - touchStartX;
    touchStartX = null;
    if (stage.classList.contains('jellio-reader-stage-overflow')) return;
    if (delta < -50) reader.next();
    else if (delta > 50) reader.prev();
  });

  let resizeTimer = null;
  function handleResize() {
    if (resizeTimer) window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(reader.resize, 200);
  }
  window.addEventListener('resize', handleResize);

  function syncFullscreenIcon() {
    const icon = fullscreenButton.querySelector('.material-icons');
    const on = !!document.fullscreenElement;
    icon.className = 'material-icons ' + (on ? 'fullscreen_exit' : 'fullscreen');
    fullscreenButton.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
  }
  fullscreenButton.addEventListener('click', function () {
    if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
    else root.requestFullscreen().catch(function () {});
  });
  document.addEventListener('fullscreenchange', syncFullscreenIcon);

  function paintToc() {
    tocPanel.textContent = '';
    tocPanel.appendChild(el('h2', 'jellio-reader-panel-title', 'Contents'));
    const list = el('div', 'jellio-reader-toc');
    tocPanel.appendChild(list);
    list.appendChild(el('p', 'jellio-reader-empty', 'Loading…'));
    reader
      .toc()
      .then(function (entries) {
        list.textContent = '';
        if (!entries.length) {
          list.appendChild(el('p', 'jellio-reader-empty', 'This book has no table of contents.'));
          return;
        }
        entries.forEach(function (entry) {
          const button = el('button', 'jellio-reader-toc-entry', entry.label || 'Untitled');
          button.type = 'button';
          button.style.paddingLeft = 0.75 + entry.depth + 'em';
          if (entry.label && entry.label === chapterLabel.textContent) button.classList.add('jellio-reader-toc-current');
          button.addEventListener('click', function () {
            reader.goTo(entry.target);
            closePanels();
          });
          list.appendChild(button);
        });
      })
      .catch(function (err) {
        console.warn('Jellio: could not read the table of contents', err);
        list.textContent = '';
        list.appendChild(el('p', 'jellio-reader-empty', 'Could not read the table of contents.'));
      });
  }

  let searchToken = 0;
  let lastQuery = '';
  let lastResults = [];
  function paintSearch() {
    searchPanel.textContent = '';
    searchPanel.appendChild(el('h2', 'jellio-reader-panel-title', 'Search in book'));
    const form = el('form', 'jellio-reader-search-form');
    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'jellio-reader-search-input';
    input.placeholder = 'Find a word or phrase';
    input.value = lastQuery;
    form.appendChild(input);
    searchPanel.appendChild(form);
    const status = el('p', 'jellio-reader-empty');
    searchPanel.appendChild(status);
    const list = el('div', 'jellio-reader-search-results');
    searchPanel.appendChild(list);

    function paintResults(results) {
      list.textContent = '';
      results.forEach(function (result) {
        const button = el('button', 'jellio-reader-search-result');
        button.type = 'button';
        if (result.label) button.appendChild(el('span', 'jellio-reader-search-where', result.label));
        button.appendChild(el('span', 'jellio-reader-search-excerpt', result.excerpt));
        button.addEventListener('click', function () {
          reader.showSearchHit(result.target);
          if (window.matchMedia('(max-width: 40em)').matches) closePanels();
        });
        list.appendChild(button);
      });
    }

    if (lastResults.length) {
      status.textContent = lastResults.length + (lastResults.length >= SEARCH_RESULT_LIMIT ? '+' : '') + ' matches';
      paintResults(lastResults);
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      const query = input.value.trim();
      if (query.length < 2) {
        status.textContent = 'Type at least two characters.';
        return;
      }
      const token = ++searchToken;
      lastQuery = query;
      lastResults = [];
      list.textContent = '';
      status.textContent = 'Searching…';
      if (reader.setSearchQuery) reader.setSearchQuery(query);
      reader
        .search(query, function () {
          return token === searchToken;
        })
        .then(function (results) {
          if (token !== searchToken) return;
          lastResults = results;
          status.textContent = results.length
            ? results.length + (results.length >= SEARCH_RESULT_LIMIT ? '+' : '') + ' matches'
            : 'No matches for “' + query + '”.';
          paintResults(results);
        })
        .catch(function (err) {
          if (token !== searchToken) return;
          console.warn('Jellio: book search failed', err);
          status.textContent = 'Search failed.';
        });
    });
    window.setTimeout(function () {
      input.focus();
    }, 0);
  }

  function updateSettings(patch) {
    root.classList.remove('jellio-reader-theme-' + settings.theme);
    Object.assign(settings, patch);
    root.classList.add('jellio-reader-theme-' + settings.theme);
    root.dataset.width = settings.width;
    root.dataset.layout = settings.layout;
    storeSettings(settings);
    Promise.resolve(reader.applySettings(settings)).then(function () {
      reader.resize();
    });
    paintSettings();
  }

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
        updateSettings({ theme: theme });
      });
      themeRow.appendChild(button);
    });
    settingsPanel.appendChild(settingGroup('Theme', themeRow));

    if (reader.kind === 'epub') {
      const sizeRow = el('div', 'jellio-reader-setting-row');
      const smaller = iconButton('text_decrease', 'Smaller text');
      const larger = iconButton('text_increase', 'Larger text');
      sizeRow.appendChild(smaller);
      sizeRow.appendChild(el('span', 'jellio-reader-size-label', settings.fontSize + '%'));
      sizeRow.appendChild(larger);
      smaller.addEventListener('click', function () {
        updateSettings({ fontSize: Math.max(70, settings.fontSize - 10) });
      });
      larger.addEventListener('click', function () {
        updateSettings({ fontSize: Math.min(200, settings.fontSize + 10) });
      });
      settingsPanel.appendChild(settingGroup('Text size', sizeRow));
      settingsPanel.appendChild(
        settingGroup('Font', optionChips(FONTS, settings.font, (value) => updateSettings({ font: value }))),
      );
      settingsPanel.appendChild(
        settingGroup(
          'Line spacing',
          optionChips(LINE_HEIGHTS, settings.lineHeight, (value) => updateSettings({ lineHeight: value })),
        ),
      );
      settingsPanel.appendChild(
        settingGroup('Layout', optionChips(LAYOUTS, settings.layout, (value) => updateSettings({ layout: value }))),
      );
      settingsPanel.appendChild(
        settingGroup('Page width', optionChips(WIDTHS, settings.width, (value) => updateSettings({ width: value }))),
      );
    } else {
      settingsPanel.appendChild(
        settingGroup('Fit', optionChips(PDF_FITS, settings.pdfFit, (value) => updateSettings({ pdfFit: value, pdfZoom: 100 }))),
      );
      const zoomRow = el('div', 'jellio-reader-setting-row');
      const zoomOut = iconButton('zoom_out', 'Zoom out');
      const zoomIn = iconButton('zoom_in', 'Zoom in');
      zoomRow.appendChild(zoomOut);
      zoomRow.appendChild(el('span', 'jellio-reader-size-label', settings.pdfZoom + '%'));
      zoomRow.appendChild(zoomIn);
      zoomOut.addEventListener('click', function () {
        updateSettings({ pdfZoom: Math.max(50, settings.pdfZoom - 25) });
      });
      zoomIn.addEventListener('click', function () {
        updateSettings({ pdfZoom: Math.min(300, settings.pdfZoom + 25) });
      });
      settingsPanel.appendChild(settingGroup('Zoom', zoomRow));
      settingsPanel.appendChild(
        settingGroup(
          'Page colour',
          optionChips(
            [
              { value: 'off', label: 'Original' },
              { value: 'on', label: 'Match theme' },
            ],
            settings.pdfTint ? 'on' : 'off',
            (value) => updateSettings({ pdfTint: value === 'on' }),
          ),
        ),
      );
    }
  }

  tocButton.addEventListener('click', function () {
    openPanel(tocPanel, paintToc);
  });
  searchButton.addEventListener('click', function () {
    openPanel(searchPanel, paintSearch);
  });
  settingsButton.addEventListener('click', function () {
    openPanel(settingsPanel, paintSettings);
  });

  return function cleanup() {
    flushSave();
    searchToken++;
    document.removeEventListener('keydown', handleKey);
    document.removeEventListener('fullscreenchange', syncFullscreenIcon);
    window.removeEventListener('resize', handleResize);
    if (resizeTimer) window.clearTimeout(resizeTimer);
    if (tapTimer) window.clearTimeout(tapTimer);
    if (document.fullscreenElement === root) document.exitFullscreen().catch(function () {});
    try {
      reader.destroy();
    } catch (err) {
      console.warn('Jellio: reader cleanup failed', err);
    }
    invalidateHomeSections();
  };
}
