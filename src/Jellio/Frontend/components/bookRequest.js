// "Request a book" on the Books shelf: searches Chaptarr's metadata through
// Controllers/BookRequestController.cs and adds the ebook or audiobook to
// Chaptarr, which then searches for it. Collapsed behind one button until
// opened, so it never crowds the shelf for readers who are just browsing.
import { searchBooksToRequest, requestBook } from '../runtime/api.js';
import { el } from '../runtime/dom.js';

const STATUS_LABELS = { added: 'Requested', pending: 'Queued', exists: 'Already requested' };

function markDone(button, text, label) {
  text.textContent = label;
  button.disabled = true;
  button.classList.add('jellio-book-request-action-done');
}

function requestButton(result, bookType, label, icon, alreadyHave) {
  const button = el('button', 'jellio-book-request-action');
  button.type = 'button';
  button.appendChild(el('span', 'material-icons ' + icon));
  const text = el('span', null, label);
  button.appendChild(text);
  if (alreadyHave) {
    markDone(button, text, label + ' ✓');
    button.title = 'Already in Chaptarr';
    return button;
  }
  button.addEventListener('click', function () {
    button.disabled = true;
    text.textContent = 'Requesting…';
    requestBook(result, bookType)
      .then(function (response) {
        const status = response && response.Status;
        if (STATUS_LABELS[status]) {
          markDone(button, text, STATUS_LABELS[status]);
          if (response.Message) button.title = response.Message;
          return;
        }
        text.textContent = (response && response.Message) || 'Request failed';
        button.disabled = false;
        button.classList.add('jellio-book-request-action-error');
      })
      .catch(function (err) {
        console.warn('Jellio: book request failed', err);
        text.textContent = 'Request failed';
        button.disabled = false;
        button.classList.add('jellio-book-request-action-error');
      });
  });
  return button;
}

function buildResult(result) {
  const card = el('div', 'jellio-book-request-result');
  const cover = el('div', 'jellio-book-request-cover');
  if (result.CoverUrl) {
    const img = document.createElement('img');
    img.src = result.CoverUrl;
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    cover.appendChild(img);
  } else {
    cover.appendChild(el('span', 'material-icons menu_book'));
  }
  card.appendChild(cover);

  const info = el('div', 'jellio-book-request-info');
  info.appendChild(el('div', 'jellio-book-request-title', result.Title || 'Untitled'));
  const byline = [result.Author, result.Year].filter(Boolean).join(' · ');
  if (byline) info.appendChild(el('div', 'jellio-book-request-byline', byline));
  if (result.SeriesTitle) info.appendChild(el('div', 'jellio-book-request-byline', result.SeriesTitle));
  const actions = el('div', 'jellio-book-request-actions');
  actions.appendChild(requestButton(result, 'ebook', 'Ebook', 'menu_book', result.HasEbook));
  actions.appendChild(requestButton(result, 'audiobook', 'Audiobook', 'headphones', result.HasAudiobook));
  info.appendChild(actions);
  card.appendChild(info);
  return card;
}

export function buildBookRequestPanel() {
  const section = el('section', 'jellio-book-request');
  const toggle = el('button', 'jellio-book-request-toggle');
  toggle.type = 'button';
  toggle.appendChild(el('span', 'material-icons add'));
  toggle.appendChild(el('span', null, 'Request a book'));
  section.appendChild(toggle);

  const body = el('div', 'jellio-book-request-body');
  body.hidden = true;
  const form = el('form', 'jellio-book-request-form');
  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'jellio-book-request-input';
  input.placeholder = 'Title, author or ISBN';
  input.setAttribute('aria-label', 'Search books to request');
  const submit = el('button', 'jellio-book-request-submit', 'Search');
  submit.type = 'submit';
  form.appendChild(input);
  form.appendChild(submit);
  body.appendChild(form);
  const status = el('p', 'jellio-book-request-status');
  body.appendChild(status);
  const results = el('div', 'jellio-book-request-results');
  body.appendChild(results);
  section.appendChild(body);

  toggle.addEventListener('click', function () {
    body.hidden = !body.hidden;
    toggle.classList.toggle('jellio-book-request-toggle-open', !body.hidden);
    if (!body.hidden) input.focus();
  });

  let searchToken = 0;
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    const query = input.value.trim();
    if (!query) return;
    const token = ++searchToken;
    results.textContent = '';
    status.textContent = 'Searching…';
    submit.disabled = true;
    searchBooksToRequest(query)
      .then(function (found) {
        if (token !== searchToken) return;
        status.textContent = found.length ? '' : 'No books found for “' + query + '”.';
        found.forEach(function (result) {
          if (result && result.WorkId) results.appendChild(buildResult(result));
        });
      })
      .catch(function (err) {
        if (token !== searchToken) return;
        console.warn('Jellio: book search failed', err);
        status.textContent = 'Search failed. Try again in a moment.';
      })
      .finally(function () {
        if (token === searchToken) submit.disabled = false;
      });
  });

  return section;
}
