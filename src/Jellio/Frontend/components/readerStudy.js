// The reader's study layer: select text to highlight it, add a note,
// look a word up (Wiktionary), translate it (DeepL, when the server has a
// key), or save it to the vocabulary deck (screens/vocab.js). Also owns
// bookmarks, the Notes panel and the per-book language. Format-specific
// work (turning a selection into a locator, drawing highlights) stays in
// screens/reader.js's EPUB/PDF adapters; this file only talks to them
// through onSelect/setHighlights/onHighlightClick/positionOf/goToLocator/
// currentLocator/isBookmarkHere.
import {
  getAnnotations,
  addAnnotation,
  updateAnnotation,
  deleteAnnotation,
  translateText,
  defineWord,
  addVocabulary,
} from '../runtime/api.js';
import { showToast } from './toast.js';
import { el } from '../runtime/dom.js';

export const HIGHLIGHT_COLORS = [
  { value: 'yellow', label: 'Yellow', hex: '#ffd400' },
  { value: 'green', label: 'Green', hex: '#5fd35f' },
  { value: 'blue', label: 'Blue', hex: '#4aa3ff' },
  { value: 'pink', label: 'Pink', hex: '#ff6fa8' },
  { value: 'purple', label: 'Purple', hex: '#b38cff' },
];

export function highlightHex(color) {
  const match = HIGHLIGHT_COLORS.find((option) => option.value === color);
  return (match || HIGHLIGHT_COLORS[0]).hex;
}

// DeepL's languages, which Wiktionary also covers; names come from the
// browser so they read in the reader's own language.
export const LANGUAGES = [
  'ar', 'bg', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fi', 'fr', 'hu', 'id', 'it', 'ja', 'ko',
  'lt', 'lv', 'nb', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'tr', 'uk', 'zh',
];

let displayNames = null;
export function languageLabel(code) {
  try {
    displayNames = displayNames || new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' });
    return displayNames.of(code) || code;
  } catch (err) {
    return code;
  }
}

function bookLangKey(itemId) {
  return 'jellio-reader-lang:' + itemId;
}

export function readBookLanguage(itemId) {
  try {
    const saved = localStorage.getItem(bookLangKey(itemId));
    return saved && (saved === 'auto' || LANGUAGES.indexOf(saved) !== -1) ? saved : 'auto';
  } catch (err) {
    return 'auto';
  }
}

export function writeBookLanguage(itemId, lang) {
  try {
    localStorage.setItem(bookLangKey(itemId), lang);
  } catch (err) {
    // Only a convenience; lookups still work on "auto".
  }
}

export function defaultTargetLanguage() {
  const base = String(navigator.language || 'en').split('-')[0].toLowerCase();
  return LANGUAGES.indexOf(base) !== -1 ? base : 'en';
}

// Up to a short phrase counts as a word to look up; anything longer is a
// passage (translate only, no dictionary).
function isWordLike(text) {
  return text.length <= 40 && text.split(/\s+/).length <= 3;
}

function cleanWord(text) {
  return text.replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '');
}

// The sentence around a selection, for flashcards and for DeepL's context.
export function sentenceAround(fullText, selected, index) {
  const text = String(fullText || '').replace(/\s+/g, ' ');
  const needle = String(selected || '').replace(/\s+/g, ' ').trim();
  let at = typeof index === 'number' ? index : text.indexOf(needle);
  if (at < 0 || !needle) return needle;
  const terminators = /[.!?…。！？]/;
  let start = at;
  while (start > 0 && at - start < 300) {
    if (terminators.test(text[start - 1]) && /\s/.test(text[start] || ' ')) break;
    start--;
  }
  let end = at + needle.length;
  while (end < text.length && end - at < 400) {
    if (terminators.test(text[end])) {
      end++;
      break;
    }
    end++;
  }
  return text.slice(start, end).trim();
}

function describeError(err) {
  return (err && err.message) || 'Something went wrong';
}

export function createStudyLayer(options) {
  const { root, reader, itemId, itemName, translationEnabled, getChapter, getProgress, getTargetLang } = options;
  let bookLang = readBookLanguage(itemId);
  let annotations = [];
  let popup = null;
  let popupCleanup = null;
  const listeners = new Set();

  function notify() {
    listeners.forEach((listener) => listener());
  }

  function highlights() {
    return annotations.filter((annotation) => annotation.Kind === 'highlight');
  }

  function bookmarks() {
    return annotations.filter((annotation) => annotation.Kind === 'bookmark');
  }

  function repaintHighlights() {
    reader.setHighlights(highlights());
  }

  function closePopup() {
    if (!popup) return false;
    if (popupCleanup) popupCleanup();
    popupCleanup = null;
    popup.remove();
    popup = null;
    return true;
  }

  function placePopup(rect) {
    const margin = 8;
    const width = popup.offsetWidth;
    const height = popup.offsetHeight;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    let left = rect.left + rect.width / 2 - width / 2;
    left = Math.max(margin, Math.min(viewportWidth - width - margin, left));
    let top = rect.bottom + margin;
    if (top + height > viewportHeight - margin) top = rect.top - height - margin;
    if (top < margin) top = Math.max(margin, viewportHeight - height - margin);
    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
  }

  function sectionTitle(text) {
    return el('div', 'jellio-study-section-title', text);
  }

  // One popup for a fresh selection and for tapping an existing highlight.
  function openPopup(selection, existing) {
    closePopup();
    const text = (existing ? existing.Text : selection.text) || '';
    const word = cleanWord(text);
    const wordLike = isWordLike(text) && word.length > 0;
    const sentence = existing ? '' : selection.sentence || '';
    let current = existing || null;
    let definition = null;
    let translation = null;

    popup = el('div', 'jellio-study-popup');
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-label', 'Selection');
    const toolbar = el('div', 'jellio-study-toolbar');
    const colors = el('div', 'jellio-study-colors');
    const results = el('div', 'jellio-study-results');

    function paintColors() {
      colors.textContent = '';
      HIGHLIGHT_COLORS.forEach(function (color) {
        const dot = el('button', 'jellio-study-color' + (current && current.Color === color.value ? ' jellio-study-color-active' : ''));
        dot.type = 'button';
        dot.style.setProperty('--dot', color.hex);
        dot.setAttribute('aria-label', 'Highlight ' + color.label.toLowerCase());
        dot.title = 'Highlight ' + color.label.toLowerCase();
        dot.addEventListener('click', function () {
          saveHighlight(color.value).then(paintColors);
        });
        colors.appendChild(dot);
      });
    }

    function action(icon, label, handler) {
      const button = el('button', 'jellio-study-action');
      button.type = 'button';
      button.title = label;
      button.setAttribute('aria-label', label);
      button.appendChild(el('span', 'material-icons ' + icon));
      button.addEventListener('click', handler);
      toolbar.appendChild(button);
      return button;
    }

    async function saveHighlight(color) {
      if (current) {
        if (current.Color === color) return current;
        const updated = await updateAnnotation(itemId, current.Id, { Note: current.Note || null, Color: color });
        Object.assign(current, updated);
      } else {
        const created = await addAnnotation(itemId, {
          Kind: 'highlight',
          Locator: selection.locator,
          Position: reader.positionOf(selection.locator, getProgress()),
          Text: text,
          Color: color,
          Chapter: getChapter() || null,
        });
        current = created;
        annotations.push(created);
        if (selection.clear) selection.clear();
      }
      repaintHighlights();
      notify();
      return current;
    }

    function showNoteEditor() {
      const existingEditor = results.querySelector('.jellio-study-note');
      if (existingEditor) {
        existingEditor.querySelector('textarea').focus();
        return;
      }
      const editor = el('div', 'jellio-study-note');
      const area = document.createElement('textarea');
      area.rows = 3;
      area.placeholder = 'Add a note';
      area.value = (current && current.Note) || '';
      editor.appendChild(area);
      const saveButton = el('button', 'jellio-study-note-save', 'Save note');
      saveButton.type = 'button';
      saveButton.addEventListener('click', async function () {
        saveButton.disabled = true;
        try {
          await saveHighlight((current && current.Color) || 'yellow');
          const updated = await updateAnnotation(itemId, current.Id, { Note: area.value.trim() || null, Color: current.Color });
          Object.assign(current, updated);
          notify();
          showToast(current.Note ? 'Note saved' : 'Note removed');
          closePopup();
        } catch (err) {
          saveButton.disabled = false;
          showToast('Could not save the note');
        }
      });
      editor.appendChild(saveButton);
      results.insertBefore(editor, results.firstChild);
      positionAgain();
      area.focus();
    }

    function renderDefinition(senses) {
      const block = el('div', 'jellio-study-block');
      block.appendChild(sectionTitle('Dictionary'));
      if (!senses || !senses.length) {
        block.appendChild(el('p', 'jellio-study-muted', 'No dictionary entry for “' + word + '”.'));
        return block;
      }
      const showLanguage = bookLang === 'auto';
      senses.slice(0, 4).forEach(function (sense) {
        const head = [sense.PartOfSpeech, showLanguage ? sense.Language : ''].filter(Boolean).join(' · ');
        if (head) block.appendChild(el('div', 'jellio-study-pos', head));
        const list = el('ol', 'jellio-study-defs');
        sense.Definitions.slice(0, 3).forEach(function (text) {
          list.appendChild(el('li', null, text));
        });
        block.appendChild(list);
      });
      return block;
    }

    function lookUp() {
      const block = el('div', 'jellio-study-block jellio-study-loading', 'Looking up…');
      results.appendChild(block);
      positionAgain();
      return defineWord(word, bookLang)
        .then(function (senses) {
          const first = senses && senses[0];
          definition = first ? (first.PartOfSpeech ? first.PartOfSpeech + ': ' : '') + first.Definitions[0] : null;
          block.replaceWith(renderDefinition(senses));
        })
        .catch(function (err) {
          block.replaceWith(el('p', 'jellio-study-muted', 'Dictionary unavailable: ' + describeError(err)));
        })
        .finally(positionAgain);
    }

    function translate() {
      const block = el('div', 'jellio-study-block jellio-study-loading', 'Translating…');
      results.appendChild(block);
      positionAgain();
      const target = getTargetLang();
      return translateText(text, target, bookLang, wordLike ? sentence : null)
        .then(function (result) {
          const out = el('div', 'jellio-study-block');
          out.appendChild(sectionTitle('Translation · ' + languageLabel(target)));
          if (!result || result.Error || !result.Text) {
            out.appendChild(el('p', 'jellio-study-muted', (result && result.Error) || 'No translation.'));
          } else {
            translation = result.Text;
            out.appendChild(el('p', 'jellio-study-translation', result.Text));
            // Learn the book's language from the first translation, so
            // dictionary lookups can filter to it from then on.
            if (bookLang === 'auto' && result.DetectedSourceLang && LANGUAGES.indexOf(result.DetectedSourceLang) !== -1) {
              bookLang = result.DetectedSourceLang;
              writeBookLanguage(itemId, bookLang);
            }
          }
          block.replaceWith(out);
        })
        .catch(function (err) {
          block.replaceWith(el('p', 'jellio-study-muted', 'Translation unavailable: ' + describeError(err)));
        })
        .finally(positionAgain);
    }

    async function saveWord(button) {
      button.disabled = true;
      try {
        const lookups = [];
        if (!definition && wordLike) lookups.push(defineWord(word, bookLang).then(function (senses) {
          const first = senses && senses[0];
          if (first) definition = (first.PartOfSpeech ? first.PartOfSpeech + ': ' : '') + first.Definitions[0];
        }).catch(function () {}));
        await Promise.all(lookups);
        await addVocabulary({
          Word: wordLike ? word : text,
          Sentence: sentence || null,
          Definition: definition,
          Translation: translation,
          SourceLang: bookLang === 'auto' ? null : bookLang,
          TargetLang: translation ? getTargetLang() : null,
          ItemId: itemId,
          ItemName: itemName,
          Locator: (current && current.Locator) || (selection && selection.locator) || null,
        });
        showToast('Saved “' + (wordLike ? word : text.slice(0, 30)) + '” to vocabulary');
        button.classList.add('jellio-study-action-done');
      } catch (err) {
        button.disabled = false;
        showToast('Could not save the word');
      }
    }

    paintColors();
    toolbar.appendChild(colors);
    action('edit_note', current && current.Note ? 'Edit note' : 'Add note', showNoteEditor);
    if (wordLike) action('menu_book', 'Define', lookUp);
    if (translationEnabled) action('translate', 'Translate', translate);
    const saveButton = action('bookmark_add', 'Save to vocabulary', function () {
      saveWord(saveButton);
    });
    action('content_copy', 'Copy', function () {
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => showToast('Copied'), () => {});
    });
    if (current) {
      action('delete', 'Remove highlight', async function () {
        try {
          await deleteAnnotation(itemId, current.Id);
          annotations = annotations.filter((annotation) => annotation.Id !== current.Id);
          repaintHighlights();
          notify();
          closePopup();
        } catch (err) {
          showToast('Could not remove the highlight');
        }
      });
    }
    popup.appendChild(toolbar);
    if (current) {
      popup.appendChild(el('blockquote', 'jellio-study-quote', text));
      if (current.Note) popup.appendChild(el('p', 'jellio-study-existing-note', current.Note));
    }
    popup.appendChild(results);
    root.appendChild(popup);

    const anchorRect = selection.rect;
    function positionAgain() {
      if (popup) placePopup(anchorRect);
    }
    positionAgain();

    function onKey(event) {
      if (event.key === 'Escape') closePopup();
    }
    document.addEventListener('keydown', onKey);
    popupCleanup = function () {
      document.removeEventListener('keydown', onKey);
    };

    // A single word is what a learner selects most: look it up straight
    // away instead of making them ask.
    if (!existing && wordLike) {
      lookUp();
      if (translationEnabled) translate();
    }
  }

  reader.onSelect(function (selection) {
    openPopup(selection, null);
  });

  reader.onHighlightClick(function (id, rect) {
    const annotation = annotations.find((candidate) => candidate.Id === id);
    if (annotation) openPopup({ rect: rect }, annotation);
  });

  function load() {
    return getAnnotations(itemId)
      .then(function (list) {
        annotations = list;
        repaintHighlights();
        notify();
      })
      .catch(function (err) {
        console.warn('Jellio: could not load annotations', err);
      });
  }

  function bookmarkHere() {
    return reader.isBookmarkHere(bookmarks());
  }

  async function toggleBookmark() {
    const here = bookmarkHere();
    try {
      if (here) {
        await deleteAnnotation(itemId, here.Id);
        annotations = annotations.filter((annotation) => annotation.Id !== here.Id);
        showToast('Bookmark removed');
      } else {
        const locator = reader.currentLocator();
        if (!locator) return;
        const created = await addAnnotation(itemId, {
          Kind: 'bookmark',
          Locator: locator,
          Position: reader.positionOf(locator, getProgress()),
          Chapter: getChapter() || null,
          Text: reader.currentExcerpt ? reader.currentExcerpt() : null,
        });
        annotations.push(created);
        showToast('Bookmarked');
      }
      notify();
    } catch (err) {
      showToast('Could not update the bookmark');
    }
  }

  function exportMarkdown() {
    const lines = ['# ' + itemName, ''];
    annotations
      .slice()
      .sort((a, b) => a.Position - b.Position)
      .forEach(function (annotation) {
        const where = annotation.Chapter ? ' (' + annotation.Chapter + ')' : '';
        if (annotation.Kind === 'bookmark') {
          lines.push('- 🔖 Bookmark' + where + (annotation.Text ? ': ' + annotation.Text : ''));
        } else {
          lines.push('> ' + String(annotation.Text || '').replace(/\n+/g, ' ') + where);
          if (annotation.Note) lines.push('', annotation.Note);
        }
        lines.push('');
      });
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = (itemName || 'notes').replace(/[\\/:*?"<>|]+/g, '_') + ' - notes.md';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function paintNotesPanel(panel, closePanels) {
    panel.textContent = '';
    const header = el('div', 'jellio-study-notes-header');
    header.appendChild(el('h2', 'jellio-reader-panel-title', 'Notes & highlights'));
    if (annotations.length) {
      const exportButton = el('button', 'jellio-study-export', 'Export');
      exportButton.type = 'button';
      exportButton.title = 'Download as Markdown';
      exportButton.addEventListener('click', exportMarkdown);
      header.appendChild(exportButton);
    }
    panel.appendChild(header);

    if (!annotations.length) {
      panel.appendChild(
        el('p', 'jellio-reader-empty', 'Select text to highlight it or add a note. Use the bookmark button to mark a page.'),
      );
      return;
    }

    const list = el('div', 'jellio-study-notes');
    annotations
      .slice()
      .sort((a, b) => a.Position - b.Position)
      .forEach(function (annotation) {
        const entry = el('div', 'jellio-study-note-entry');
        entry.style.setProperty('--mark', annotation.Kind === 'bookmark' ? 'var(--jellio-text-secondary)' : highlightHex(annotation.Color));
        const jump = el('button', 'jellio-study-note-jump');
        jump.type = 'button';
        const meta = el('span', 'jellio-study-note-meta');
        meta.appendChild(el('span', 'material-icons ' + (annotation.Kind === 'bookmark' ? 'bookmark' : 'format_quote')));
        meta.appendChild(el('span', null, annotation.Chapter || Math.round(annotation.Position * 100) + '%'));
        jump.appendChild(meta);
        if (annotation.Text) jump.appendChild(el('span', 'jellio-study-note-text', annotation.Text));
        if (annotation.Note) jump.appendChild(el('span', 'jellio-study-note-body', annotation.Note));
        jump.addEventListener('click', function () {
          reader.goToLocator(annotation.Locator);
          if (window.matchMedia('(max-width: 40em)').matches) closePanels();
        });
        entry.appendChild(jump);
        const remove = el('button', 'jellio-study-note-remove');
        remove.type = 'button';
        remove.setAttribute('aria-label', 'Remove');
        remove.title = 'Remove';
        remove.appendChild(el('span', 'material-icons close'));
        remove.addEventListener('click', async function () {
          try {
            await deleteAnnotation(itemId, annotation.Id);
            annotations = annotations.filter((candidate) => candidate.Id !== annotation.Id);
            repaintHighlights();
            notify();
            paintNotesPanel(panel, closePanels);
          } catch (err) {
            showToast('Could not remove it');
          }
        });
        entry.appendChild(remove);
        list.appendChild(entry);
      });
    panel.appendChild(list);
  }

  return {
    load: load,
    dismiss: closePopup,
    toggleBookmark: toggleBookmark,
    isBookmarked: function () {
      return !!bookmarkHere();
    },
    onChange: function (listener) {
      listeners.add(listener);
    },
    paintNotesPanel: paintNotesPanel,
    getBookLanguage: function () {
      return bookLang;
    },
    setBookLanguage: function (lang) {
      bookLang = lang;
      writeBookLanguage(itemId, lang);
    },
    destroy: function () {
      closePopup();
      listeners.clear();
    },
  };
}
