import { getUserImageUrl } from '../runtime/api.js';
import { initialOf } from '../runtime/friendsHelpers.js';
import { el } from '../runtime/dom.js';

// A round avatar for a Person ({ UserId, UserName, PrimaryImageTag }):
// the picture, or the first letter of the name when there is none.
export function buildFriendAvatar(person, extraClass, maxWidth) {
  const cls = 'jellio-friend-avatar' + (extraClass ? ' ' + extraClass : '');
  if (person && person.PrimaryImageTag) {
    const img = document.createElement('img');
    img.className = cls;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = getUserImageUrl(person.UserId, person.PrimaryImageTag, { maxWidth: maxWidth || 96 });
    img.addEventListener('error', function () {
      img.replaceWith(el('span', cls + ' jellio-friend-avatar-initial', initialOf(person.UserName)));
    });
    return img;
  }
  return el('span', cls + ' jellio-friend-avatar-initial', initialOf(person && person.UserName));
}
