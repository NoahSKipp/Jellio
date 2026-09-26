// "Request a book" on the Books shelf: searches Chaptarr's metadata through
// Controllers/BookRequestController.cs and adds the ebook or audiobook to
// Chaptarr, which then searches for it. Collapsed behind one button until
// opened, so it never crowds the shelf for readers who are just browsing.
import { searchBooksToRequest, requestBook } from '../runtime/api.js';
import { getAccessToken, getServerAddress } from '../runtime/auth.js';
import { el } from '../runtime/dom.js';

// Covers Chaptarr only has as its own cached copy come through Jellio's
// server (Jellio/books/cover), which an <img> can only authenticate to
// via the token in the query string.
function coverSrc(url) {
  if (url.indexOf('/Jellio/') !== 0) return url;
  return getServerAddress() + url + '&ApiKey=' + encodeURIComponent(getAccessToken() || '');
}

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

function buildResult(result, bookType, ebookLabel) {
  const card = el('div', 'jellio-book-request-result');
  const cover = el('div', 'jellio-book-request-cover');
  if (result.CoverUrl) {
    const img = document.createElement('img');
    img.src = coverSrc(result.CoverUrl);
    img.addEventListener('error', function () {
      img.replaceWith(el('span', 'material-icons menu_book'));
    });
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
  if (bookType !== 'audiobook') {
    actions.appendChild(requestButton(result, 'ebook', ebookLabel || 'Request ebook', 'menu_book', result.HasEbook));
  }
  if (bookType !== 'ebook') {
    actions.appendChild(requestButton(result, 'audiobook', 'Request audiobook', 'headphones', result.HasAudiobook));
  }
  info.appendChild(actions);
  card.appendChild(info);
  return card;
}

// bookType 'ebook' or 'audiobook' scopes the search and the request
// buttons to that one format (the Books and Audiobooks shelves); omitted,
// both are offered.
//
// options (all optional): label and placeholder override the wording
// (the Manga shelf requests volumes as ebooks); initialQuery opens the
// panel and searches straight away (Discover's "Request volumes");
// ebookLabel renames the request button (a manga volume is just
// "Request").
export function buildBookRequestPanel(bookType, options) {
  const opts = options || {};
  const section = el('section', 'jellio-book-request');
  const toggle = el('button', 'jellio-book-request-toggle');
  toggle.type = 'button';
  toggle.appendChild(el('span', 'material-icons add'));
  toggle.appendChild(el('span', null, opts.label || (bookType === 'audiobook' ? 'Request an audiobook' : 'Request a book')));
  section.appendChild(toggle);

  const body = el('div', 'jellio-book-request-body');
  body.hidden = !opts.initialQuery;
  const form = el('form', 'jellio-book-request-form');
  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'jellio-book-request-input';
  input.placeholder = opts.placeholder || 'Title, author or ISBN';
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
    searchBooksToRequest(query, bookType)
      .then(function (found) {
        if (token !== searchToken) return;
        status.textContent = found.length ? '' : 'Nothing found for “' + query + '”.';
        found.forEach(function (result) {
          if (result && result.WorkId) results.appendChild(buildResult(result, bookType, opts.ebookLabel));
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

  if (opts.initialQuery) {
    input.value = opts.initialQuery;
    toggle.classList.add('jellio-book-request-toggle-open');
    window.setTimeout(function () {
      form.requestSubmit();
    }, 0);
  }

  return section;
}
