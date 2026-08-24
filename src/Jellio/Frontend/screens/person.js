// Actors Plus, from the reference table: an actor's own page, photo,
// bio and real filmography, reached by clicking a cast card on the
// detail screen. Own route (#/person?id=X), not a native page this
// runtime could reskin (jellyfin-web's own person page lives behind
// playbackManager-adjacent internals like everything else this codebase
// cannot reach), built the same way every other screen here is: real
// endpoints, own markup.
import { getPerson, getPersonFilmography, getImageUrl } from '../runtime/api.js';
import { buildCard } from '../components/card.js';
import { renderLoading, renderRetry } from '../components/networkState.js';
import { navigateTo } from '../runtime/router.js';
import { describeNetworkFailure } from '../runtime/network.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export async function renderPerson(root, params) {
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-person';

  const personId = params.get('id');
  if (!personId) return;

  renderLoading(root);

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
    photo.src = getImageUrl(personId, 'Primary', { tag: imageTag, maxWidth: 400 });
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

  const section = el('section', 'jellio-person-filmography');
  section.appendChild(el('h2', 'jellio-row-title', 'Filmography'));
  const grid = el('div', 'jellio-library-grid');
  section.appendChild(grid);
  root.appendChild(section);

  try {
    const items = await getPersonFilmography(personId);
    items.forEach(function (item) {
      grid.appendChild(buildCard(item));
    });
  } catch (err) {
    console.warn('Jellio: could not load filmography', err);
  }
}
