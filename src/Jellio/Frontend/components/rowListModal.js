import { t } from '../runtime/i18n.js';
import { getImageUrl } from '../runtime/api.js';
import { getBookCoverUrl, getMangaSeriesCoverUrl, getStreamCoverUrl } from '../runtime/apiBooks.js';
import { navigateTo } from '../runtime/router.js';
import { el } from '../runtime/dom.js';

const OVERLAY_ID = 'jellioRowListModal';

function handleKeydown(event) {
  if (event.key === 'Escape') closeRowListModal();
}

let openToken = 0;

function closeRowListModal() {
  openToken++;
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();
  document.removeEventListener('keydown', handleKeydown);
}

function itemSubtitle(item) {
  const bits = [];
  if (item.ProductionYear) bits.push(String(item.ProductionYear));
  if (item.Type === 'Series' || item.Type === 'Season') {
    bits.push(t('type_series') || 'Series');
  } else if (item.Type === 'Movie') {
    bits.push(t('type_movie') || 'Movie');
  }
  if (typeof item.CommunityRating === 'number' && item.CommunityRating > 0) {
    bits.push('★ ' + item.CommunityRating.toFixed(1));
  }
  if (Array.isArray(item.Genres) && item.Genres.length > 0) {
    const genreStr = item.Genres.filter(Boolean).slice(0, 2).join(', ');
    if (genreStr) bits.push(genreStr);
  }
  return bits.join(' · ');
}

function buildListItem(item, select) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'jellio-row-list-item';

  const tag = (item.ImageTags && (item.ImageTags.Primary || item.ImageTags.primary || item.ImageTags['0'] || item.ImageTags[0]))
    || item.PrimaryImageTag
    || (item.ProviderIds && (item.ProviderIds.TmdbPoster || item.ProviderIds.PosterUrl));
  const isBook = item.Type === 'Book' || item.Type === 'AudioBook';
  const candidates = [];
  if (tag) {
    candidates.push(getImageUrl(item.Id, 'Primary', { tag: tag, maxWidth: 160 }));
  }
  if (item.PosterUrl) candidates.push(item.PosterUrl);
  if (item.Poster) candidates.push(item.Poster);
  if (item.ImageUrl) candidates.push(item.ImageUrl);
  if (item.PosterPath) {
    candidates.push(item.PosterPath.startsWith('http') ? item.PosterPath : 'https://image.tmdb.org/t/p/w500' + item.PosterPath);
  }
  if (item.SeriesPrimaryImageTag) {
    candidates.push(getImageUrl(item.SeriesId || item.Id, 'Primary', { tag: item.SeriesPrimaryImageTag, maxWidth: 160 }));
  }
  const seriesTag = item.SeriesPrimaryImageTag || (item.ImageTags && (item.ImageTags.SeriesPrimary || item.ImageTags.seriesPrimary));
  if (seriesTag) {
    candidates.push(getImageUrl(item.SeriesId || item.Id, 'Primary', { tag: seriesTag, maxWidth: 160 }));
  }
  const thumbTag = (item.ImageTags && (item.ImageTags.Thumb || item.ImageTags.thumb || item.ImageTags['1'] || item.ImageTags[1])) || item.ThumbImageTag;
  if (thumbTag) {
    candidates.push(getImageUrl(item.Id, 'Thumb', { tag: thumbTag, maxWidth: 160 }));
  }
  const backdropTag = (item.BackdropImageTags && item.BackdropImageTags[0])
    || (item.ImageTags && (item.ImageTags.Backdrop || item.ImageTags.backdrop || item.ImageTags['2'] || item.ImageTags[2]));
  if (backdropTag) {
    candidates.push(getImageUrl(item.Id, 'Backdrop', { tag: backdropTag, maxWidth: 160 }));
  }
  if (isBook && item.Id) {
    if (item.Stream && item.Stream.MangaId) candidates.push(getStreamCoverUrl(item.Stream.MangaId, item.SeriesName));
    candidates.push(getMangaSeriesCoverUrl(item.Id, item.SeriesName));
    candidates.push(getBookCoverUrl(item.Id));
  }
  if (item.Id && !isBook) {
    candidates.push(getImageUrl(item.Id, 'Primary', { maxWidth: 160 }));
    if (item.SeriesId) {
      candidates.push(getImageUrl(item.SeriesId, 'Primary', { maxWidth: 160 }));
    }
    candidates.push(getImageUrl(item.Id, 'Backdrop', { maxWidth: 160 }));
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

const PAGE_SIZE = 60;

function openRowListModal(title, items, options) {
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
    shown.forEach(function (item) {
      if (item && item.Id) seenIds[String(item.Id)] = true;
    });
    let nextStart = shown.length;
    let loading = false;
    let done = false;
    const sentinel = el('div', 'jellio-row-list-sentinel');
    list.appendChild(sentinel);
    list.appendChild(loadingNote);

    function loadMore() {
      if (loading || done || token !== openToken) return;
      loading = true;
      const start = nextStart;
      opts.fetchPage(start, PAGE_SIZE).then(function (page) {
        if (token !== openToken) return;
        const pageItems = Array.isArray(page) ? page : ((page && page.Items) ? page.Items : []);
        nextStart = start + pageItems.length;
        if (!pageItems.length) {
          done = true;
        }
        let added = 0;
        pageItems.forEach(function (item) {
          if (!item) return;
          const id = item.Id ? String(item.Id) : null;
          if (id && seenIds[id]) return;
          if (id) seenIds[id] = true;
          shown.push(item);
          list.insertBefore(buildListItem(item, select), sentinel);
          added++;
        });
        if (pageItems.length < 5 && added === 0) {
          done = true;
        }
      }).catch(function (err) {
        console.warn('Jellio: could not load more of this row', err);
        done = true;
      }).then(function () {
        loading = false;
        if (done) {
          if (observer) observer.disconnect();
          loadingNote.remove();
          sentinel.remove();
        } else if (token === openToken) {
          const listRect = list.getBoundingClientRect();
          const sentinelRect = sentinel.getBoundingClientRect();
          if (sentinelRect.top <= listRect.bottom + 300) {
            loadMore();
          }
        }
      });
    }

    const observer = typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver(function (entries) {
          if (entries.some(function (entry) { return entry.isIntersecting; })) loadMore();
        }, { root: list, rootMargin: '300px' })
      : null;

    if (observer) {
      observer.observe(sentinel);
    }
    list.addEventListener('scroll', function () {
      if (loading || done) return;
      const remaining = list.scrollHeight - (list.scrollTop + list.clientHeight);
      if (remaining < 400) {
        loadMore();
      }
    }, { passive: true });

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
