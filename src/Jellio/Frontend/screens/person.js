import { t } from '../runtime/i18n.js';
import { getPerson, getPersonFilmography, getImageUrl } from '../runtime/api.js';
import { buildCard } from '../components/card.js';
import { appendCardsLazily } from '../components/lazyGrid.js';
import { renderLoading, renderRetry } from '../components/networkState.js';
import { navigateTo } from '../runtime/router.js';
import { describeNetworkFailure } from '../runtime/network.js';
import { el } from '../runtime/dom.js';

export async function renderPerson(root, params) {
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-person';

  const personId = params.get('id');
  if (!personId) return;

  renderLoading(root);

  const filmographyPromise = getPersonFilmography(personId);

  let person;
  try {
    person = await getPerson(personId);
  } catch (err) {
    console.warn('Jellio: could not load person', err);
    renderRetry(root, describeNetworkFailure('this person', err), function () {
      renderPerson(root, params);
    }, { onBack: function () { navigateTo('#/home'); }, backLabel: 'Back to Home' });
    return;
  }

  root.textContent = '';

  const header = el('header', 'jellio-person-header');

  const imageTag = person.ImageTags && person.ImageTags.Primary;
  if (imageTag) {
    const photo = document.createElement('img');
    photo.className = 'jellio-person-photo';
    photo.src = getImageUrl(personId, 'Primary', { tag: imageTag, maxWidth: 400, quality: 85 });
    photo.alt = '';
    header.appendChild(photo);
  } else {
    header.appendChild(el('div', 'jellio-person-photo jellio-person-photo-empty'));
  }

  const info = el('div', 'jellio-person-info');
  info.appendChild(el('h1', 'jellio-person-name', person.Name || ''));
  if (person.Overview) {
    info.appendChild(el('p', 'jellio-person-overview', person.Overview));
  }
  header.appendChild(info);
  root.appendChild(header);

  try {
    const items = await filmographyPromise;
    const films = items.filter((item) => item.Type === 'Movie' || item.Type === 'Series');
    const books = items.filter((item) => item.Type === 'Book' || item.Type === 'AudioBook');

    if (!films.length && !books.length) {
      const empty = el('p', 'jellio-service-empty', t('person_no_works'));
      root.appendChild(empty);
      return;
    }

    if (films.length) {
      const filmSection = el('section', 'jellio-person-filmography');
      filmSection.appendChild(el('h2', 'jellio-row-title', t('person_filmography')));
      const filmGrid = el('div', 'jellio-library-grid');
      filmSection.appendChild(filmGrid);
      root.appendChild(filmSection);
      appendCardsLazily(filmGrid, films, buildCard);
    }

    if (books.length) {
      const bookSection = el('section', 'jellio-person-filmography jellio-person-bibliography');
      bookSection.appendChild(el('h2', 'jellio-row-title', t('person_bibliography')));
      const bookGrid = el('div', 'jellio-library-grid');
      bookSection.appendChild(bookGrid);
      root.appendChild(bookSection);
      appendCardsLazily(bookGrid, books, buildCard);
    }
  } catch (err) {
    console.warn('Jellio: could not load works', err);
  }
}
