// The vocabulary deck (#/vocab): words saved from the reader's selection
// popup (components/readerStudy.js), reviewed as flashcards on a spaced
// repetition schedule kept by Controllers/VocabularyController.cs, and
// exportable to CSV or Anki.
import {
  getVocabulary,
  reviewVocabulary,
  deleteVocabulary,
  updateVocabulary,
  downloadVocabularyExport,
} from '../runtime/api.js';
import { navigateTo, setTitle } from '../runtime/router.js';
import { renderLoading, renderRetry } from '../components/networkState.js';
import { showToast } from '../components/toast.js';
import { languageLabel } from '../components/readerStudy.js';
import { el } from '../runtime/dom.js';

const GRADES = [
  { value: 0, label: 'Again', key: '1' },
  { value: 1, label: 'Hard', key: '2' },
  { value: 2, label: 'Good', key: '3' },
  { value: 3, label: 'Easy', key: '4' },
];

function isDue(entry, now) {
  return Date.parse(entry.DueAt) <= now;
}

function dueLabel(entry) {
  const due = Date.parse(entry.DueAt);
  if (!entry.Reps && !entry.Lapses) return 'New';
  const days = Math.round((due - Date.now()) / 86400000);
  if (days <= 0) return 'Due';
  return days === 1 ? 'In 1 day' : 'In ' + days + ' days';
}

// The saved sentence with the word itself emphasised, built from text
// nodes so nothing from a book's text is ever parsed as HTML.
function sentenceWithWord(sentence, word) {
  const wrap = el('p', 'jellio-vocab-sentence');
  const text = String(sentence || '');
  const index = word ? text.toLowerCase().indexOf(String(word).toLowerCase()) : -1;
  if (index === -1) {
    wrap.textContent = text;
    return wrap;
  }
  wrap.appendChild(document.createTextNode(text.slice(0, index)));
  wrap.appendChild(el('strong', null, text.slice(index, index + word.length)));
  wrap.appendChild(document.createTextNode(text.slice(index + word.length)));
  return wrap;
}

async function download(format) {
  try {
    const file = await downloadVocabularyExport(format);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(file.blob);
    link.download = file.filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  } catch (err) {
    showToast('Export failed');
  }
}

export async function renderVocab(root) {
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-vocab';
  setTitle('Vocabulary - Jellio');
  renderLoading(root, 'Loading your vocabulary…');

  let entries;
  try {
    entries = await getVocabulary();
  } catch (err) {
    renderRetry(root, 'Could not load your vocabulary.', function () {
      renderVocab(root);
    });
    return;
  }

  let filterText = '';
  let filterLang = '';
  let reviewCleanup = null;

  root.textContent = '';
  const header = el('header', 'jellio-library-header jellio-vocab-header');
  header.appendChild(el('h1', 'jellio-library-title', 'Vocabulary'));
  const stats = el('p', 'jellio-bookshelf-stats');
  header.appendChild(stats);
  root.appendChild(header);

  const actions = el('div', 'jellio-vocab-actions');
  const reviewButton = el('button', 'jellio-vocab-review-button');
  reviewButton.type = 'button';
  actions.appendChild(reviewButton);
  const csvButton = el('button', 'jellio-vocab-secondary', 'Export CSV');
  csvButton.type = 'button';
  csvButton.addEventListener('click', () => download('csv'));
  const ankiButton = el('button', 'jellio-vocab-secondary', 'Export for Anki');
  ankiButton.type = 'button';
  ankiButton.title = 'A text file Anki imports with File > Import';
  ankiButton.addEventListener('click', () => download('anki'));
  actions.appendChild(csvButton);
  actions.appendChild(ankiButton);
  root.appendChild(actions);

  const toolbar = el('div', 'jellio-bookshelf-toolbar');
  const searchWrap = el('label', 'jellio-bookshelf-search');
  searchWrap.appendChild(el('span', 'material-icons search'));
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.placeholder = 'Find a word, translation or book';
  searchInput.setAttribute('aria-label', 'Filter vocabulary');
  searchWrap.appendChild(searchInput);
  toolbar.appendChild(searchWrap);
  const langSelect = document.createElement('select');
  langSelect.className = 'jellio-library-filter-select';
  langSelect.setAttribute('aria-label', 'Language');
  toolbar.appendChild(langSelect);
  root.appendChild(toolbar);

  const list = el('div', 'jellio-vocab-list');
  root.appendChild(list);

  const reviewMount = el('div', 'jellio-vocab-review');
  reviewMount.hidden = true;
  root.appendChild(reviewMount);

  function paintLanguages() {
    const langs = Array.from(new Set(entries.map((entry) => entry.SourceLang).filter(Boolean))).sort();
    langSelect.textContent = '';
    const all = document.createElement('option');
    all.value = '';
    all.textContent = 'All languages';
    langSelect.appendChild(all);
    langs.forEach(function (code) {
      const option = document.createElement('option');
      option.value = code;
      option.textContent = languageLabel(code);
      langSelect.appendChild(option);
    });
    langSelect.value = langs.indexOf(filterLang) !== -1 ? filterLang : '';
    langSelect.hidden = langs.length < 2;
  }

  function paintStats() {
    const now = Date.now();
    const due = entries.filter((entry) => isDue(entry, now)).length;
    stats.textContent = entries.length + (entries.length === 1 ? ' word' : ' words') + (entries.length ? ' · ' + due + ' due for review' : '');
    reviewButton.textContent = due ? 'Review ' + due + (due === 1 ? ' card' : ' cards') : 'Nothing due';
    reviewButton.disabled = !due;
    csvButton.disabled = ankiButton.disabled = !entries.length;
  }

  function entryCard(entry) {
    const card = el('article', 'jellio-vocab-card');
    const head = el('div', 'jellio-vocab-card-head');
    head.appendChild(el('h3', 'jellio-vocab-word', entry.Word));
    if (entry.Translation) head.appendChild(el('span', 'jellio-vocab-translation', entry.Translation));
    head.appendChild(el('span', 'jellio-vocab-due', dueLabel(entry)));
    card.appendChild(head);
    if (entry.Definition) card.appendChild(el('p', 'jellio-vocab-definition', entry.Definition));
    if (entry.Sentence) card.appendChild(sentenceWithWord(entry.Sentence, entry.Word));

    const foot = el('div', 'jellio-vocab-card-foot');
    const where = [entry.ItemName, entry.SourceLang ? languageLabel(entry.SourceLang) : ''].filter(Boolean).join(' · ');
    foot.appendChild(el('span', 'jellio-vocab-source', where));
    if (entry.ItemId) {
      const open = el('button', 'jellio-vocab-link', 'Open in book');
      open.type = 'button';
      open.addEventListener('click', function () {
        navigateTo('#/read?id=' + entry.ItemId + (entry.Locator ? '&loc=' + encodeURIComponent(entry.Locator) : ''));
      });
      foot.appendChild(open);
    }
    const edit = el('button', 'jellio-vocab-icon');
    edit.type = 'button';
    edit.setAttribute('aria-label', 'Edit');
    edit.title = 'Edit';
    edit.appendChild(el('span', 'material-icons edit'));
    edit.addEventListener('click', function () {
      card.replaceWith(editCard(entry));
    });
    foot.appendChild(edit);
    const remove = el('button', 'jellio-vocab-icon');
    remove.type = 'button';
    remove.setAttribute('aria-label', 'Delete');
    remove.title = 'Delete';
    remove.appendChild(el('span', 'material-icons delete'));
    remove.addEventListener('click', async function () {
      try {
        await deleteVocabulary(entry.Id);
        entries = entries.filter((candidate) => candidate.Id !== entry.Id);
        paint();
      } catch (err) {
        showToast('Could not delete it');
      }
    });
    foot.appendChild(remove);
    card.appendChild(foot);
    return card;
  }

  function editCard(entry) {
    const card = el('article', 'jellio-vocab-card jellio-vocab-card-editing');
    card.appendChild(el('h3', 'jellio-vocab-word', entry.Word));
    function field(label, value, rows) {
      const wrap = el('label', 'jellio-vocab-field');
      wrap.appendChild(el('span', null, label));
      const input = document.createElement('textarea');
      input.rows = rows;
      input.value = value || '';
      wrap.appendChild(input);
      card.appendChild(wrap);
      return input;
    }
    const translation = field('Translation', entry.Translation, 1);
    const definition = field('Definition', entry.Definition, 2);
    const sentence = field('Sentence', entry.Sentence, 3);
    const foot = el('div', 'jellio-vocab-card-foot');
    const cancel = el('button', 'jellio-vocab-secondary', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => card.replaceWith(entryCard(entry)));
    const save = el('button', 'jellio-vocab-primary', 'Save');
    save.type = 'button';
    save.addEventListener('click', async function () {
      save.disabled = true;
      try {
        const updated = await updateVocabulary(entry.Id, {
          Translation: translation.value,
          Definition: definition.value,
          Sentence: sentence.value,
        });
        Object.assign(entry, updated);
        card.replaceWith(entryCard(entry));
      } catch (err) {
        save.disabled = false;
        showToast('Could not save');
      }
    });
    foot.appendChild(cancel);
    foot.appendChild(save);
    card.appendChild(foot);
    return card;
  }

  function paint() {
    paintStats();
    paintLanguages();
    list.textContent = '';
    const query = filterText.toLowerCase();
    const shown = entries.filter(function (entry) {
      if (filterLang && entry.SourceLang !== filterLang) return false;
      if (!query) return true;
      return [entry.Word, entry.Translation, entry.Definition, entry.ItemName].some(
        (value) => value && value.toLowerCase().indexOf(query) !== -1,
      );
    });
    if (!entries.length) {
      const empty = el('div', 'jellio-bookshelf-empty');
      empty.appendChild(el('span', 'material-icons translate'));
      empty.appendChild(
        el('p', null, 'No words yet. While reading, select a word and tap “Save to vocabulary” to start your deck.'),
      );
      list.appendChild(empty);
      return;
    }
    if (!shown.length) {
      list.appendChild(el('p', 'jellio-bookshelf-empty-inline', 'No words match.'));
      return;
    }
    shown.forEach((entry) => list.appendChild(entryCard(entry)));
  }

  function startReview() {
    const now = Date.now();
    const queue = entries.filter((entry) => isDue(entry, now)).sort((a, b) => Date.parse(a.DueAt) - Date.parse(b.DueAt));
    if (!queue.length) return;
    let index = 0;
    let revealed = false;
    let reviewed = 0;
    list.hidden = true;
    toolbar.hidden = true;
    actions.hidden = true;
    reviewMount.hidden = false;

    function finish() {
      document.removeEventListener('keydown', onKey);
      reviewCleanup = null;
      reviewMount.hidden = true;
      reviewMount.textContent = '';
      list.hidden = false;
      toolbar.hidden = false;
      actions.hidden = false;
      if (reviewed) showToast('Reviewed ' + reviewed + (reviewed === 1 ? ' card' : ' cards'));
      paint();
    }

    function paintCard() {
      reviewMount.textContent = '';
      if (index >= queue.length) {
        finish();
        return;
      }
      const entry = queue[index];
      const top = el('div', 'jellio-vocab-review-top');
      top.appendChild(el('span', null, index + 1 + ' / ' + queue.length));
      const close = el('button', 'jellio-vocab-secondary', 'Done');
      close.type = 'button';
      close.addEventListener('click', finish);
      top.appendChild(close);
      reviewMount.appendChild(top);

      const card = el('div', 'jellio-vocab-flashcard');
      card.appendChild(el('div', 'jellio-vocab-flash-word', entry.Word));
      if (entry.Sentence) card.appendChild(sentenceWithWord(entry.Sentence, entry.Word));
      if (revealed) {
        const answer = el('div', 'jellio-vocab-answer');
        if (entry.Translation) answer.appendChild(el('div', 'jellio-vocab-flash-translation', entry.Translation));
        if (entry.Definition) answer.appendChild(el('p', 'jellio-vocab-definition', entry.Definition));
        if (entry.ItemName) answer.appendChild(el('p', 'jellio-vocab-source', entry.ItemName));
        card.appendChild(answer);
      }
      reviewMount.appendChild(card);

      const controls = el('div', 'jellio-vocab-grades');
      if (!revealed) {
        const show = el('button', 'jellio-vocab-primary jellio-vocab-show', 'Show answer');
        show.type = 'button';
        show.addEventListener('click', reveal);
        controls.appendChild(show);
      } else {
        GRADES.forEach(function (grade) {
          const button = el('button', 'jellio-vocab-grade jellio-vocab-grade-' + grade.value);
          button.type = 'button';
          button.appendChild(el('span', null, grade.label));
          button.appendChild(el('kbd', null, grade.key));
          button.addEventListener('click', () => answer(grade.value));
          controls.appendChild(button);
        });
      }
      reviewMount.appendChild(controls);
    }

    function reveal() {
      revealed = true;
      paintCard();
    }

    async function answer(grade) {
      const entry = queue[index];
      try {
        const updated = await reviewVocabulary(entry.Id, grade);
        Object.assign(entry, updated);
        reviewed++;
        // "Again" comes back around at the end of this session.
        if (grade === 0) queue.push(entry);
      } catch (err) {
        showToast('Could not save that review');
      }
      index++;
      revealed = false;
      paintCard();
    }

    function onKey(event) {
      if (event.target && (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA')) return;
      if (!revealed && (event.key === ' ' || event.key === 'Enter')) {
        event.preventDefault();
        reveal();
      } else if (revealed) {
        const grade = GRADES.find((option) => option.key === event.key);
        if (grade) answer(grade.value);
      }
      if (event.key === 'Escape') finish();
    }
    document.addEventListener('keydown', onKey);
    reviewCleanup = function () {
      document.removeEventListener('keydown', onKey);
    };
    paintCard();
  }

  reviewButton.addEventListener('click', startReview);
  searchInput.addEventListener('input', function () {
    filterText = searchInput.value.trim();
    paint();
  });
  langSelect.addEventListener('change', function () {
    filterLang = langSelect.value;
    paint();
  });

  paint();

  return function cleanup() {
    if (reviewCleanup) reviewCleanup();
  };
}
