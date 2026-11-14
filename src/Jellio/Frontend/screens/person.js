import { t } from '../runtime/i18n.js';
import {
  getPerson,
  getPersonFilmography,
  getImageUrl,
  searchMovies,
  searchSeries,
  seedItemCache,
} from '../runtime/api.js';
import { buildCard } from '../components/card.js';
import { appendCardsLazily } from '../components/lazyGrid.js';
import { attachScrollArrows } from '../components/scrollArrows.js';
import { buildRatingBadge } from '../components/ratingBadge.js';
import { renderLoading, renderRetry } from '../components/networkState.js';
import { navigateTo } from '../runtime/router.js';
import { describeNetworkFailure } from '../runtime/network.js';
import { el } from '../runtime/dom.js';
import {
  searchTmdbPersonId,
  fetchTmdbPersonDetails,
  buildRichPersonDetails,
  buildFallbackPersonDetails,
  filterCreditsForDepartment,
  formatCreditSubtitle,
  parseMarkdownBio,
  resolveCreditTarget,
} from '../runtime/personProfile.js';

function appendFormattedBio(targetEl, raw) {
  const segments = parseMarkdownBio(raw);
  segments.forEach(function (seg) {
    if (seg.type === 'bold') {
      const strong = document.createElement('strong');
      strong.textContent = seg.text;
      targetEl.appendChild(strong);
    } else if (seg.type === 'italic') {
      const em = document.createElement('em');
      em.textContent = seg.text;
      targetEl.appendChild(em);
    } else {
      targetEl.appendChild(document.createTextNode(seg.text));
    }
  });
}

function buildPersonCreditCard(credit) {
  if (credit && credit.localItem && credit.localItem.Id) {
    const card = buildCard(credit.localItem);
    const subtitle = formatCreditSubtitle(credit);
    if (subtitle) {
      let subtitleEl = card.querySelector('.jellio-card-subtitle');
      if (!subtitleEl) {
        subtitleEl = document.createElement('div');
        subtitleEl.className = 'jellio-card-subtitle';
        card.appendChild(subtitleEl);
      }
      subtitleEl.textContent = subtitle;
    }
    return card;
  }

  const card = document.createElement('div');
  card.className = 'jellio-card';
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', credit.title || '');

  const imageWrap = document.createElement('div');
  imageWrap.className = 'jellio-card-image-wrap';

  function appendPlaceholder() {
    const placeholder = document.createElement('div');
    placeholder.className = 'jellio-card-image jellio-card-image-empty';
    imageWrap.insertBefore(placeholder, imageWrap.firstChild);
  }

  if (credit.posterUrl) {
    const img = document.createElement('img');
    img.className = 'jellio-card-image';
    img.src = credit.posterUrl;
    img.alt = credit.title || '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('error', function () {
      img.remove();
      appendPlaceholder();
    });
    imageWrap.appendChild(img);
  } else {
    appendPlaceholder();
  }

  if (credit.rating != null && credit.rating > 0) {
    imageWrap.appendChild(buildRatingBadge(credit.rating, 'jellio-card-rating'));
  }

  card.appendChild(imageWrap);

  const titleEl = document.createElement('div');
  titleEl.className = 'jellio-card-title';
  titleEl.textContent = credit.title || '';
  card.appendChild(titleEl);

  const subtitle = formatCreditSubtitle(credit);
  if (subtitle) {
    const subEl = document.createElement('div');
    subEl.className = 'jellio-card-subtitle';
    subEl.textContent = subtitle;
    card.appendChild(subEl);
  }

  let resolving = false;
  async function openCredit() {
    if (resolving) return;
    resolving = true;
    card.classList.add('jellio-card-resolving');
    try {
      const target = await resolveCreditTarget(credit, { searchMovies, searchSeries });
      if (!target) return;
      if (target.item) seedItemCache(target.item);
      navigateTo(target.hash);
    } finally {
      resolving = false;
      card.classList.remove('jellio-card-resolving');
    }
  }

  card.addEventListener('click', openCredit);
  card.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openCredit();
    }
  });

  return card;
}

function buildKnownForRow(credits) {
  const section = el('section', 'jellio-row jellio-person-known-for');
  section.appendChild(el('h2', 'jellio-row-title', t('person_known_for')));

  const trackWrap = el('div', 'jellio-row-track-wrap');
  const track = el('div', 'jellio-row-track');
  credits.forEach(function (credit) {
    track.appendChild(buildPersonCreditCard(credit));
  });
  trackWrap.appendChild(track);
  section.appendChild(trackWrap);
  attachScrollArrows(trackWrap, track);
  return section;
}

export async function renderPerson(root, params, signal) {
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-person';

  const personId = params.get('id');
  if (!personId) return;

  renderLoading(root);

  const filmographyPromise = getPersonFilmography(personId).catch(function () {
    return [];
  });

  let person;
  try {
    person = await getPerson(personId);
  } catch (err) {
    if (signal && signal.aborted) return;
    console.warn('Jellio: could not load person', err);
    renderRetry(
      root,
      describeNetworkFailure('this person', err),
      function () {
        renderPerson(root, params, signal);
      },
      { onBack: function () { navigateTo('#/home'); }, backLabel: 'Back to Home' },
    );
    return;
  }

  if (signal && signal.aborted) return;

  const localItems = await filmographyPromise;
  if (signal && signal.aborted) return;

  const labels = {
    all: t('person_tab_all'),
    acting: t('person_tab_acting'),
    directing: t('person_tab_directing'),
    writing: t('person_tab_writing'),
    production: t('person_tab_production'),
    other: t('person_tab_other'),
  };

  let tmdbId = person.ProviderIds && Number(person.ProviderIds.Tmdb);
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
    tmdbId = await searchTmdbPersonId(person.Name);
  }
  const tmdbDetails = tmdbId ? await fetchTmdbPersonDetails(tmdbId) : null;
  if (signal && signal.aborted) return;

  const details = tmdbDetails
    ? buildRichPersonDetails(personId, person, tmdbDetails, localItems, labels)
    : buildFallbackPersonDetails(personId, person, localItems, labels);

  root.textContent = '';

  const header = el('header', 'jellio-person-header');
  if (details.backdropUrl) {
    const backdrop = el('div', 'jellio-person-backdrop');
    backdrop.style.backgroundImage = 'url("' + encodeURI(details.backdropUrl) + '")';
    header.appendChild(backdrop);
  }
  header.appendChild(el('div', 'jellio-person-backdrop-scrim'));

  const headerInner = el('div', 'jellio-person-header-inner');
  const imageTag = person.ImageTags && person.ImageTags.Primary;
  const fallbackPhotoUrl = imageTag
    ? getImageUrl(personId, 'Primary', { tag: imageTag, maxWidth: 400, quality: 85 })
    : null;
  const photoUrl = details.profileUrl || fallbackPhotoUrl;

  if (photoUrl) {
    const photo = document.createElement('img');
    photo.className = 'jellio-person-photo';
    photo.src = photoUrl;
    photo.alt = details.name || '';
    headerInner.appendChild(photo);
  } else {
    headerInner.appendChild(el('div', 'jellio-person-photo jellio-person-photo-empty'));
  }

  const info = el('div', 'jellio-person-info');
  info.appendChild(el('h1', 'jellio-person-name', details.name || ''));

  const metaRow = el('div', 'jellio-person-meta');
  if (details.knownForDepartment) {
    metaRow.appendChild(el('span', 'jellio-person-chip jellio-person-chip-accent', details.knownForDepartment));
  }
  if (details.birthday) {
    const ageText = details.age != null ? ' (' + t('person_age', { age: details.age }) + ')' : '';
    metaRow.appendChild(el('span', 'jellio-person-chip', t('person_born') + ' ' + details.birthday + ageText));
  }
  if (details.placeOfBirth) {
    metaRow.appendChild(el('span', 'jellio-person-chip', details.placeOfBirth));
  }
  metaRow.appendChild(el('span', 'jellio-person-chip', t('person_credits_count', { count: details.totalCreditsCount })));
  if (details.imdbId) {
    const imdbLink = document.createElement('a');
    imdbLink.className = 'jellio-person-imdb-badge';
    imdbLink.href = 'https://www.imdb.com/name/' + encodeURIComponent(details.imdbId) + '/';
    imdbLink.target = '_blank';
    imdbLink.rel = 'noopener noreferrer';
    imdbLink.textContent = 'IMDb';
    metaRow.appendChild(imdbLink);
  }
  if (details.tmdbId) {
    const tmdbLink = document.createElement('a');
    tmdbLink.className = 'jellio-person-tmdb-badge';
    tmdbLink.href = 'https://www.themoviedb.org/person/' + encodeURIComponent(String(details.tmdbId));
    tmdbLink.target = '_blank';
    tmdbLink.rel = 'noopener noreferrer';
    tmdbLink.textContent = 'TMDB';
    metaRow.appendChild(tmdbLink);
  }
  info.appendChild(metaRow);

  if (details.biography) {
    const bioWrap = el('div', 'jellio-person-bio-wrap');
    const bioEl = el('p', 'jellio-person-overview jellio-person-overview-collapsed');
    appendFormattedBio(bioEl, details.biography);
    bioWrap.appendChild(bioEl);

    if (details.biography.length > 220) {
      let expanded = false;
      const toggleBtn = el('button', 'jellio-person-bio-toggle', t('person_read_more'));
      toggleBtn.type = 'button';
      toggleBtn.addEventListener('click', function () {
        expanded = !expanded;
        bioEl.classList.toggle('jellio-person-overview-collapsed', !expanded);
        toggleBtn.textContent = t(expanded ? 'person_read_less' : 'person_read_more');
      });
      bioWrap.appendChild(toggleBtn);
    }
    info.appendChild(bioWrap);
  }

  headerInner.appendChild(info);
  header.appendChild(headerInner);
  root.appendChild(header);

  const books = localItems.filter(function (item) {
    return item.Type === 'Book' || item.Type === 'AudioBook';
  });

  if (!details.allCredits.length && !books.length) {
    root.appendChild(el('p', 'jellio-service-empty', t('person_no_works')));
    return;
  }

  if (details.knownFor.length) {
    root.appendChild(buildKnownForRow(details.knownFor));
  }

  if (details.allCredits.length) {
    const filmSection = el('section', 'jellio-person-filmography');
    filmSection.appendChild(el('h2', 'jellio-row-title', t('person_filmography')));

    let selectedDept = 'All';
    const tabsBar = el('div', 'jellio-person-dept-tabs');
    const filmGrid = el('div', 'jellio-library-grid');

    function renderCreditsGrid() {
      filmGrid.textContent = '';
      const filtered = filterCreditsForDepartment(selectedDept, details.allCredits);
      appendCardsLazily(filmGrid, filtered, buildPersonCreditCard);
    }

    details.departmentTabs.forEach(function (tab) {
      const btn = el(
        'button',
        'jellio-person-dept-tab' + (tab.key === selectedDept ? ' jellio-person-dept-tab-active' : ''),
        tab.label + ' (' + tab.count + ')',
      );
      btn.type = 'button';
      btn.addEventListener('click', function () {
        if (selectedDept === tab.key) return;
        selectedDept = tab.key;
        Array.prototype.forEach.call(tabsBar.children, function (child) {
          child.classList.remove('jellio-person-dept-tab-active');
        });
        btn.classList.add('jellio-person-dept-tab-active');
        renderCreditsGrid();
      });
      tabsBar.appendChild(btn);
    });

    filmSection.appendChild(tabsBar);
    filmSection.appendChild(filmGrid);
    root.appendChild(filmSection);
    renderCreditsGrid();
  }

  if (books.length) {
    const bookSection = el('section', 'jellio-person-filmography jellio-person-bibliography');
    bookSection.appendChild(el('h2', 'jellio-row-title', t('person_bibliography')));
    const bookGrid = el('div', 'jellio-library-grid');
    bookSection.appendChild(bookGrid);
    root.appendChild(bookSection);
    appendCardsLazily(bookGrid, books, buildCard);
  }
}
