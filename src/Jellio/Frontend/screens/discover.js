// Discover (#/discover?kind=ebook|audiobook&parent=<library id>): browse
// books to request instead of having to know what to search for. Rows
// built from the reader's own shelf (more by the authors they read, the
// genres they read) and what's trending, plus genre chips and an author
// search that open a full grid. Everything comes from Open Library via
// Controllers/BookRequestController.cs's discover endpoint, and every card
// requests through Chaptarr exactly like a search result.
import {
  discoverBooks,
  requestBook,
  getBookshelfItems,
  getBookShelfInfo,
  getJellioConfig,
} from '../runtime/api.js';
import { navigateTo, setTitle } from '../runtime/router.js';
import { attachScrollArrows } from '../components/scrollArrows.js';
import { el } from '../runtime/dom.js';

// Open Library subjects; labels are what the chips say.
const GENRES = [
  ['fantasy', 'Fantasy'],
  ['science_fiction', 'Science fiction'],
  ['mystery_and_detective_stories', 'Mystery'],
  ['thrillers', 'Thriller'],
  ['romance', 'Romance'],
  ['historical_fiction', 'Historical fiction'],
  ['horror', 'Horror'],
  ['classics', 'Classics'],
  ['young_adult_fiction', 'Young adult'],
  ['philosophy', 'Philosophy'],
  ['history', 'History'],
  ['biography', 'Biography'],
  ['psychology', 'Psychology'],
  ['science', 'Science'],
  ['self-help', 'Self-help'],
  ['economics', 'Economics'],
  ['politics', 'Politics'],
  ['poetry', 'Poetry'],
];

const DEFAULT_GENRES = ['fantasy', 'mystery_and_detective_stories', 'philosophy'];
const MAX_AUTHOR_ROWS = 4;
const MAX_GENRE_ROWS = 3;
const ROW_LIMIT = 18;

const STATUS_LABELS = { added: 'Requested', pending: 'Queued', exists: 'Already requested' };

function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[:;(]/)[0]
    .replace(/^(the|a|an)\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function subjectFor(genre) {
  return String(genre || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function genreLabel(subject) {
  const known = GENRES.find((genre) => genre[0] === subject);
  if (known) return known[1];
  const text = subject.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export async function renderDiscover(root, params) {
  const kind = params.get('kind') === 'audiobook' ? 'audiobook' : 'ebook';
  const parentId = params.get('parent') || '';
  const noun = kind === 'audiobook' ? 'audiobooks' : 'books';
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-discover';
  setTitle('Discover ' + noun + ' - Jellio');

  let cancelled = false;
  const ownedTitles = new Set();
  let requestsEnabled = true;

  const header = el('header', 'jellio-library-header jellio-discover-header');
  const back = el('button', 'jellio-discover-back');
  back.type = 'button';
  back.setAttribute('aria-label', 'Back to ' + noun);
  back.appendChild(el('span', 'material-icons arrow_back'));
  back.addEventListener('click', function () {
    if (parentId) {
      navigateTo('#/books?topParentId=' + parentId + '&collectionType=books&bookKind=' + kind);
    } else {
      window.history.back();
    }
  });
  header.appendChild(back);
  const titleWrap = el('div', 'jellio-discover-heading');
  titleWrap.appendChild(el('h1', 'jellio-library-title', 'Discover ' + noun));
  titleWrap.appendChild(
    el('p', 'jellio-bookshelf-stats', 'Find something new and request the ' + (kind === 'audiobook' ? 'audiobook' : 'ebook') + '.'),
  );
  header.appendChild(titleWrap);
  root.appendChild(header);

  const toolbar = el('div', 'jellio-discover-toolbar');
  const authorForm = el('form', 'jellio-bookshelf-search jellio-discover-author-search');
  authorForm.appendChild(el('span', 'material-icons person_search'));
  const authorInput = document.createElement('input');
  authorInput.type = 'search';
  authorInput.placeholder = 'Browse an author';
  authorInput.setAttribute('aria-label', 'Browse an author');
  authorForm.appendChild(authorInput);
  toolbar.appendChild(authorForm);
  root.appendChild(toolbar);

  const chips = el('div', 'jellio-discover-chips');
  root.appendChild(chips);

  // Same row spacing as Home and the shelves.
  const body = el('div', 'jellio-discover-body jellio-rows');
  root.appendChild(body);

  // --- cards -------------------------------------------------------------

  function requestButton(book) {
    const button = el('button', 'jellio-discover-request');
    button.type = 'button';
    const tracked = kind === 'audiobook' ? book.HasAudiobook : book.HasEbook;
    if (ownedTitles.has(normalizeTitle(book.Title))) {
      button.textContent = 'In your library';
      button.disabled = true;
      button.classList.add('jellio-discover-request-done');
      return button;
    }
    if (tracked) {
      button.textContent = 'In Chaptarr';
      button.disabled = true;
      button.classList.add('jellio-discover-request-done');
      return button;
    }
    if (!requestsEnabled) {
      button.hidden = true;
      return button;
    }
    button.textContent = 'Request';
    button.addEventListener('click', function (event) {
      event.stopPropagation();
      button.disabled = true;
      button.textContent = 'Requesting…';
      requestBook(book, kind)
        .then(function (response) {
          const status = response && response.Status;
          if (STATUS_LABELS[status]) {
            button.textContent = STATUS_LABELS[status];
            button.classList.add('jellio-discover-request-done');
            if (response.Message) button.title = response.Message;
            return;
          }
          button.textContent = (response && response.Message) || 'Request failed';
          button.disabled = false;
          button.classList.add('jellio-discover-request-error');
        })
        .catch(function () {
          button.textContent = 'Request failed';
          button.disabled = false;
          button.classList.add('jellio-discover-request-error');
        });
    });
    return button;
  }

  function bookCard(book) {
    const card = el('article', 'jellio-discover-card');
    const cover = el('div', 'jellio-discover-cover');
    if (book.CoverUrl) {
      const img = document.createElement('img');
      img.src = book.CoverUrl;
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', function () {
        img.replaceWith(el('span', 'material-icons menu_book'));
      });
      cover.appendChild(img);
    } else {
      cover.appendChild(el('span', 'material-icons menu_book'));
    }
    card.appendChild(cover);
    card.appendChild(el('div', 'jellio-discover-title', book.Title));
    if (book.Author) {
      const author = el('button', 'jellio-discover-author', book.Author);
      author.type = 'button';
      author.title = 'More by ' + book.Author;
      author.addEventListener('click', function () {
        showGrid({ source: 'author', value: book.Author, title: book.Author });
      });
      card.appendChild(author);
    }
    if (book.Year) {
      card.appendChild(el('div', 'jellio-discover-year', book.Year < 0 ? -book.Year + ' BC' : String(book.Year)));
    }
    card.appendChild(requestButton(book));
    return card;
  }

  // Rows skip what the reader already has; the grid keeps it, marked, so
  // browsing an author shows their whole list.
  function unowned(books) {
    return books.filter((book) => !ownedTitles.has(normalizeTitle(book.Title)));
  }

  function row(title, loader, onMore) {
    const section = el('section', 'jellio-row jellio-discover-row');
    const heading = el('button', 'jellio-row-title jellio-discover-row-title');
    heading.type = 'button';
    heading.appendChild(el('span', null, title));
    heading.appendChild(el('span', 'material-icons chevron_right'));
    heading.addEventListener('click', onMore);
    section.appendChild(heading);
    const trackWrap = el('div', 'jellio-row-track-wrap');
    const track = el('div', 'jellio-row-track');
    for (let i = 0; i < 6; i++) track.appendChild(el('div', 'jellio-discover-card jellio-discover-card-skeleton'));
    trackWrap.appendChild(track);
    section.appendChild(trackWrap);
    loader()
      .then(function (books) {
        if (cancelled) return;
        const shown = unowned(books).slice(0, ROW_LIMIT);
        if (!shown.length) {
          section.remove();
          return;
        }
        track.textContent = '';
        shown.forEach((book) => track.appendChild(bookCard(book)));
        attachScrollArrows(trackWrap, track);
      })
      .catch(function () {
        section.remove();
      });
    return section;
  }

  // --- views -------------------------------------------------------------

  let activeChip = 'for-you';
  function paintChips() {
    chips.textContent = '';
    const options = [['for-you', 'For you'], ['trending', 'Trending']].concat(GENRES);
    options.forEach(function (option) {
      const chip = el('button', 'jellio-discover-chip' + (activeChip === option[0] ? ' jellio-discover-chip-active' : ''), option[1]);
      chip.type = 'button';
      chip.setAttribute('aria-pressed', activeChip === option[0] ? 'true' : 'false');
      chip.addEventListener('click', function () {
        activeChip = option[0];
        if (option[0] === 'for-you') showForYou();
        else if (option[0] === 'trending') showGrid({ source: 'trending', title: 'Trending on Open Library' });
        else showGrid({ source: 'subject', value: option[0], title: option[1] });
      });
      chips.appendChild(chip);
    });
  }

  let shelfSignals = null;
  function loadShelfSignals() {
    if (shelfSignals) return shelfSignals;
    shelfSignals = Promise.all([
      parentId ? getBookshelfItems(parentId, kind).catch(() => []) : Promise.resolve([]),
      parentId ? getBookShelfInfo(parentId) : Promise.resolve({}),
    ]).then(function (results) {
      const items = results[0];
      const info = results[1] || {};
      const authorCounts = new Map();
      const genreCounts = new Map();
      items.forEach(function (item) {
        ownedTitles.add(normalizeTitle(item.Name));
        const meta = info[String(item.Id).replace(/-/g, '')] || {};
        const author = item.AlbumArtist || meta.Authors;
        if (author) authorCounts.set(author, (authorCounts.get(author) || 0) + 1);
        (item.Genres && item.Genres.length ? item.Genres : meta.Genres || []).forEach(function (genre) {
          const subject = subjectFor(genre);
          if (subject) genreCounts.set(subject, (genreCounts.get(subject) || 0) + 1);
        });
      });
      const top = (counts) => Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).map((entry) => entry[0]);
      return { authors: top(authorCounts), genres: top(genreCounts) };
    });
    return shelfSignals;
  }

  function showForYou() {
    activeChip = 'for-you';
    paintChips();
    body.textContent = '';
    loadShelfSignals().then(function (signals) {
      if (cancelled || activeChip !== 'for-you') return;
      body.appendChild(
        row(
          'Trending on Open Library',
          () => discoverBooks('trending', null, 0),
          () => showGrid({ source: 'trending', title: 'Trending on Open Library' }),
        ),
      );
      signals.authors.slice(0, MAX_AUTHOR_ROWS).forEach(function (author) {
        body.appendChild(
          row(
            'More by ' + author,
            () => discoverBooks('author', author, 0),
            () => showGrid({ source: 'author', value: author, title: author }),
          ),
        );
      });
      const genres = signals.genres.length ? signals.genres.slice(0, MAX_GENRE_ROWS) : DEFAULT_GENRES;
      genres.forEach(function (subject) {
        body.appendChild(
          row(
            (signals.genres.length ? 'Because you read ' : 'Popular in ') + genreLabel(subject),
            () => discoverBooks('subject', subject, 0),
            () => showGrid({ source: 'subject', value: subject, title: genreLabel(subject) }),
          ),
        );
      });
    });
  }

  function showGrid(view) {
    if (view.source === 'author') activeChip = '';
    paintChips();
    body.textContent = '';
    window.scrollTo({ top: 0, behavior: 'smooth' });
    const head = el('div', 'jellio-discover-grid-head');
    head.appendChild(el('h2', 'jellio-row-title', view.source === 'author' ? 'Books by ' + view.title : view.title));
    body.appendChild(head);
    const grid = el('div', 'jellio-discover-grid');
    body.appendChild(grid);
    const status = el('p', 'jellio-bookshelf-empty-inline', 'Loading…');
    body.appendChild(status);
    const more = el('button', 'jellio-vocab-secondary jellio-discover-more', 'Load more');
    more.type = 'button';
    more.hidden = true;
    body.appendChild(more);
    let page = 0;
    const seen = new Set();

    function load() {
      more.hidden = true;
      status.textContent = 'Loading…';
      status.hidden = false;
      discoverBooks(view.source, view.value, page)
        .then(function (books) {
          if (cancelled || !grid.isConnected) return;
          const fresh = books.filter((book) => !seen.has(book.WorkId));
          fresh.forEach(function (book) {
            seen.add(book.WorkId);
            grid.appendChild(bookCard(book));
          });
          status.hidden = !!grid.children.length;
          status.textContent = grid.children.length ? '' : 'Nothing found.';
          more.hidden = !fresh.length || books.length < 20;
        })
        .catch(function () {
          if (!grid.isConnected) return;
          status.hidden = false;
          status.textContent = 'Could not reach Open Library. Try again in a moment.';
          more.hidden = false;
        });
    }
    more.addEventListener('click', function () {
      page++;
      load();
    });
    load();
  }

  authorForm.addEventListener('submit', function (event) {
    event.preventDefault();
    const name = authorInput.value.trim();
    if (name) showGrid({ source: 'author', value: name, title: name });
  });

  getJellioConfig()
    .then(function (config) {
      requestsEnabled = !!(config && config.BookRequestsEnabled);
    })
    .catch(function () {})
    .finally(function () {
      if (!cancelled) showForYou();
    });

  return function cleanup() {
    cancelled = true;
  };
}
