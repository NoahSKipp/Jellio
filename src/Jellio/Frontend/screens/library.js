// The grid a sidebar library link opens onto. topParentId/parentId and
// collectionType come straight off the route's own query string (app.js's
// job to parse and pass along), the same two params the original Jellio
// codebase's own sidebar already builds into its library links.
import { getItem, getLibraryItems } from '../runtime/api.js';
import { buildCard } from '../components/card.js';

export async function renderLibrary(root, params) {
  root.textContent = '';
  root.className = 'jellio-screen-library';

  const parentId = params.get('topParentId') || params.get('parentId');
  const collectionType = params.get('collectionType') || '';

  if (!parentId) {
    root.textContent = '';
    return;
  }

  const header = document.createElement('header');
  header.className = 'jellio-library-header';
  const heading = document.createElement('h1');
  heading.className = 'jellio-library-title';
  heading.textContent = '';
  header.appendChild(heading);
  root.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'jellio-library-grid';
  root.appendChild(grid);

  const [itemResult, itemsResult] = await Promise.allSettled([
    getItem(parentId),
    getLibraryItems(parentId, collectionType),
  ]);

  heading.textContent = itemResult.status === 'fulfilled' && itemResult.value ? itemResult.value.Name : '';

  if (itemsResult.status === 'fulfilled') {
    const items = (itemsResult.value && itemsResult.value.Items) || [];
    items.forEach(function (item) {
      grid.appendChild(buildCard(item));
    });
  }
}
