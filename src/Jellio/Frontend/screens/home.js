// First real screen, proof of the whole architecture end to end: its own
// markup, fed entirely by runtime/api.js's own fetch calls, no native DOM
// read or waited on. Deliberately minimal (no hero yet, no per row scroll
// buttons) until the pattern this establishes is worth repeating elsewhere.
import { getCurrentUser, getUserViews, getResumeItems, getLatestItems, getImageUrl } from '../runtime/api.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function buildCard(item) {
  const card = el('div', 'jellio-card');
  const imageTag = item.ImageTags && item.ImageTags.Primary;
  if (imageTag) {
    const img = el('img', 'jellio-card-image');
    img.src = getImageUrl(item.Id, 'Primary', { tag: imageTag, maxWidth: 400 });
    img.alt = item.Name || '';
    img.loading = 'lazy';
    card.appendChild(img);
  } else {
    card.appendChild(el('div', 'jellio-card-image jellio-card-image-empty'));
  }
  card.appendChild(el('div', 'jellio-card-title', item.Name || ''));
  return card;
}

function buildRow(title, items) {
  if (!items || !items.length) return null;
  const section = el('section', 'jellio-row');
  section.appendChild(el('h2', 'jellio-row-title', title));
  const track = el('div', 'jellio-row-track');
  items.forEach(function (item) {
    track.appendChild(buildCard(item));
  });
  section.appendChild(track);
  return section;
}

export async function renderHome(root) {
  root.textContent = '';
  root.className = 'jellio-root-visible jellio-screen-home';

  const header = el('header', 'jellio-home-header');
  const [user] = await Promise.allSettled([getCurrentUser()]);
  header.appendChild(
    el(
      'h1',
      'jellio-home-greeting',
      user.status === 'fulfilled' && user.value ? 'Welcome back, ' + user.value.Name : 'Welcome back',
    ),
  );
  root.appendChild(header);

  const rows = el('div', 'jellio-rows');
  root.appendChild(rows);

  const [resumeResult, viewsResult] = await Promise.allSettled([
    getResumeItems(20),
    getUserViews(),
  ]);

  if (resumeResult.status === 'fulfilled') {
    const row = buildRow('Continue Watching', resumeResult.value);
    if (row) rows.appendChild(row);
  }

  if (viewsResult.status === 'fulfilled') {
    const views = viewsResult.value.slice(0, 6);
    const latestByView = await Promise.allSettled(
      views.map(function (view) {
        return getLatestItems(view.Id, 16);
      }),
    );
    latestByView.forEach(function (result, index) {
      if (result.status === 'fulfilled') {
        const row = buildRow('Latest in ' + views[index].Name, result.value);
        if (row) rows.appendChild(row);
      }
    });
  }
}
