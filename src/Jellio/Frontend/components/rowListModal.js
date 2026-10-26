import { t } from '../runtime/i18n.js';
// A row's own title, made clickable: real feedback was that scrolling
// all the way across a long row (a studio hub's own "Series on
// Netflix", easily 20+ deep) by drag or arrow-click alone is tedious,
// and the horizontal track itself gives no sense of how much further
// there is to go. Reuses components/groupWatch.js's own real modal
// shell (.jellio-avatar-picker-overlay/-panel/-title, the same
// close/Escape/click-outside behaviour) rather than a second dialog
// language, with a plain vertical list inside: every item in the row,
// at a glance, one click through to it.
import { getImageUrl, getBookCoverUrl, getMangaSeriesCoverUrl, getStreamCoverUrl } from '../runtime/api.js';
import { navigateTo } from '../runtime/router.js';
import { el } from '../runtime/dom.js';

const OVERLAY_ID = 'jellioRowListModal';

function handleKeydown(event) {
  if (event.key === 'Escape') closeRowListModal();
}

// Bumped every real open/close so a fetchAll() still resolving after
// the reader has already closed this modal, or opened it again for a
// different row, has a real way to know its own answer is stale rather
// than overwriting whatever is on screen by then. Real bug this
// otherwise invites: a slow full fetch for row A landing after a quick
// click reopened this same modal for row B would silently replace B's
// own list with A's.
let openToken = 0;

export function closeRowListModal() {
  openToken++;
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();
  document.removeEventListener('keydown', handleKeydown);
}

function itemSubtitle(item) {
  const bits = [];
  if (item.ProductionYear) bits.push(String(item.ProductionYear));
  if (item.Type === 'Series' || item.Type === 'Season') bits.push('Series');
  return bits.join(' · ');
}

function buildListItem(item, select) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'jellio-row-list-item';

  const tag = item.ImageTags && item.ImageTags.Primary;
  const isBook = item.Type === 'Book' || item.Type === 'AudioBook';
  if (tag || (isBook && item.Id)) {
    const candidates = [];
    if (tag) candidates.push(getImageUrl(item.Id, 'Primary', { tag: tag, maxWidth: 160 }));
    if (isBook && item.Id) {
      if (item.Stream && item.Stream.MangaId) candidates.push(getStreamCoverUrl(item.Stream.MangaId, item.SeriesName));
      candidates.push(getMangaSeriesCoverUrl(item.Id, item.SeriesName));
      candidates.push(getBookCoverUrl(item.Id));
    }
    const uniqueCandidates = Array.from(new Set(candidates.filter(Boolean)));
    if (uniqueCandidates.length) {
      const img = document.createElement('img');
      img.className = 'jellio-row-list-item-image';
      let candidateIndex = 0;
      img.src = uniqueCandidates[0];
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', function () {
        candidateIndex += 1;
        if (candidateIndex < uniqueCandidates.length) {
          img.src = uniqueCandidates[candidateIndex];
        } else {
          img.replaceWith(el('div', 'jellio-row-list-item-image jellio-row-list-item-image-empty'));
        }
      });
      row.appendChild(img);
    } else {
      row.appendChild(el('div', 'jellio-row-list-item-image jellio-row-list-item-image-empty'));
    }
  } else {
    row.appendChild(el('div', 'jellio-row-list-item-image jellio-row-list-item-image-empty'));
  }

  const info = el('div', 'jellio-row-list-item-info');
  info.appendChild(el('div', 'jellio-row-list-item-title', item.Name || ''));
  const subtitle = itemSubtitle(item);
  if (subtitle) info.appendChild(el('div', 'jellio-row-list-item-subtitle', subtitle));
  row.appendChild(info);

  row.appendChild(el('span', 'material-icons jellio-row-list-item-chevron', 'chevron_right'));

  row.addEventListener('click', function () {
    closeRowListModal();
    select(item);
  });
  return row;
}

// items: real Jellyfin item objects (the same shape every row already
// renders cards from), shown immediately, no waiting on a real network
// round trip just to open this at all. options.fetchAll, when given, is
// a real second, unbounded request for this exact same row: real
// feedback was that this modal only ever showed whichever handful of
// items the row itself had already loaded (its own real ROW_LIMIT,
// 24 on most rows), never the studio hub's own real full depth a
// "browse everything" click actually implies. Swaps the list over to
// that real full answer once it lands, silently keeping the already
// shown short list if it fails or if this row genuinely has no more
// than that to begin with. options.onSelect defaults to this runtime's
// own real item navigation; most callers just take that default.
const PAGE_SIZE = 60;

export function openRowListModal(title, items, options) {
  closeRowListModal();
  const token = ++openToken;

  const opts = options || {};
  const select = opts.onSelect || function (item) { navigateTo('#/item?id=' + item.Id); };

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'jellio-avatar-picker-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', title);
  overlay.addEventListener('click', function (event) {
    if (event.target === overlay) closeRowListModal();
  });
  document.addEventListener('keydown', handleKeydown);

  const panel = document.createElement('div');
  panel.className = 'jellio-avatar-picker-panel jellio-row-list-panel';

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'jellio-group-watch-close';
  closeButton.setAttribute('aria-label', t('action_close'));
  const closeIcon = el('span', 'material-icons close');
  closeIcon.setAttribute('aria-hidden', 'true');
  closeButton.appendChild(closeIcon);
  closeButton.addEventListener('click', closeRowListModal);
  panel.appendChild(closeButton);

  panel.appendChild(el('h2', 'jellio-avatar-picker-title', title));

  const list = el('div', 'jellio-row-list');
  function renderList(rowItems) {
    list.textContent = '';
    rowItems.forEach(function (item) {
      list.appendChild(buildListItem(item, select));
    });
  }
  renderList(items);
  panel.appendChild(list);

  const loadingNote = el('p', 'jellio-avatar-picker-status', t('row_loading_rest'));
  if (opts.fetchPage) {
    // Pages of PAGE_SIZE, the next one requested as the end of the list
    // scrolls into view, until the server runs out.
    let shown = items.slice();
    const seenIds = {};
    shown.forEach(function (item) { seenIds[item.Id] = true; });
    let nextStart = 0;
    let loading = false;
    let done = false;
    const sentinel = el('div', 'jellio-row-list-sentinel');
    panel.appendChild(sentinel);
    panel.appendChild(loadingNote);
    const observer = new IntersectionObserver(function (entries) {
      if (entries.some(function (entry) { return entry.isIntersecting; })) loadMore();
    }, { rootMargin: '400px' });
    function loadMore() {
      if (loading || done || token !== openToken) return;
      loading = true;
      const start = nextStart;
      opts.fetchPage(start, PAGE_SIZE).then(function (page) {
        if (token !== openToken) return;
        nextStart = start + PAGE_SIZE;
        if (!page || page.length < PAGE_SIZE / 2) done = true;
        (page || []).forEach(function (item) {
          if (seenIds[item.Id]) return;
          seenIds[item.Id] = true;
          shown.push(item);
          list.appendChild(buildListItem(item, select));
        });
      }).catch(function (err) {
        console.warn('Jellio: could not load more of this row', err);
        done = true;
      }).then(function () {
        loading = false;
        if (done) {
          observer.disconnect();
          loadingNote.remove();
          sentinel.remove();
        } else if (token === openToken && sentinel.getBoundingClientRect().top < window.innerHeight + 400) {
          loadMore();
        }
      });
    }
    observer.observe(sentinel);
    loadMore();
  } else if (opts.fetchAll) {
    panel.appendChild(loadingNote);
    opts
      .fetchAll()
      .then(function (fullItems) {
        if (token !== openToken) return;
        loadingNote.remove();
        if (fullItems && fullItems.length > items.length) renderList(fullItems);
      })
      .catch(function (err) {
        console.warn('Jellio: could not load this row in full', err);
        if (token === openToken) loadingNote.remove();
      });
  }

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}

// Wires a row's own <h2 class="jellio-row-title"> up to open the list
// above: a chevron appended after the existing title text (el()'s own
// textContent assignment elsewhere leaves room for this, never wipes
// it back out), the whole heading made a real button rather than only
// the small chevron being clickable.
export function makeRowTitleClickable(titleEl, title, items, options) {
  if (!items || !items.length) return;
  titleEl.classList.add('jellio-row-title-clickable');
  titleEl.setAttribute('role', 'button');
  titleEl.tabIndex = 0;
  titleEl.setAttribute('aria-label', t('row_browse_all', { title }));
  titleEl.appendChild(el('span', 'material-icons jellio-row-title-chevron', 'chevron_right'));

  function open() {
    openRowListModal(title, items, options);
  }
  titleEl.addEventListener('click', open);
  titleEl.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });
}
