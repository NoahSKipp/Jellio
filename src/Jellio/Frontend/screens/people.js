import { t, getDisplayCulture } from '../runtime/i18n.js';
import {
  friendsSupported,
  loadFriends,
  searchPeople,
  sendFriendRequest,
  cancelFriendRequest,
  acceptFriendRequest,
  declineFriendRequest,
} from '../runtime/api.js';
import { renderLoading, renderRetry } from '../components/networkState.js';
import { describeNetworkFailure } from '../runtime/network.js';
import { navigateTo } from '../runtime/router.js';
import { buildFriendAvatar } from '../components/friendAvatar.js';
import { openFriendMenu } from '../components/friendMenu.js';
import { showToast } from '../components/toast.js';
import { normalizeId, statusToButton, requestErrorKey } from '../runtime/friendsHelpers.js';
import { el } from '../runtime/dom.js';

const TABS = ['friends', 'requests', 'find'];
const SEARCH_DEBOUNCE_MS = 250;

function sinceText(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  let when;
  try {
    when = new Intl.DateTimeFormat(getDisplayCulture(), { month: 'short', year: 'numeric' }).format(date);
  } catch (err) {
    when = date.toLocaleDateString();
  }
  return t('friends_since', { date: when });
}

function profileHash(person) {
  return '#/profile?id=' + encodeURIComponent(person.UserId);
}

function button(label, className, onClick, icon) {
  const b = el('button', 'jellio-settings-button jellio-people-btn ' + (className || ''));
  b.type = 'button';
  if (icon) b.appendChild(el('span', 'material-icons', icon));
  b.appendChild(el('span', null, label));
  b.addEventListener('click', onClick);
  return b;
}

function personRow(person, subtitle) {
  const row = el('li', 'jellio-people-row');
  const link = el('a', 'jellio-people-who');
  link.href = profileHash(person);
  link.addEventListener('click', function (event) {
    event.preventDefault();
    navigateTo(profileHash(person));
  });
  link.appendChild(buildFriendAvatar(person, 'jellio-people-avatar', 96));
  const text = el('span', 'jellio-people-text');
  text.appendChild(el('span', 'jellio-people-name', person.UserName || ''));
  if (subtitle) text.appendChild(el('span', 'jellio-people-sub', subtitle));
  link.appendChild(text);
  row.appendChild(link);
  row.appendChild(el('div', 'jellio-people-actions'));
  return row;
}

function emptyState(icon, title, body, action) {
  const wrap = el('div', 'jellio-people-empty');
  wrap.appendChild(el('span', 'material-icons jellio-people-empty-icon', icon));
  wrap.appendChild(el('p', 'jellio-people-empty-title', title));
  wrap.appendChild(el('p', 'jellio-people-empty-body', body));
  if (action) wrap.appendChild(action);
  return wrap;
}

// After a row leaves the list, keep keyboard focus inside it.
function removeRow(row, list) {
  const next = row.nextElementSibling || row.previousElementSibling;
  row.remove();
  const target = next && next.querySelector('a, button');
  if (target) target.focus();
  else if (list && list.focus) list.focus();
}

export async function renderPeople(root, params) {
  root.textContent = '';
  root.className = 'jellio-content jellio-screen-people';

  if (friendsSupported() === false) {
    root.appendChild(emptyState('group_off', t('friends_unavailable_title'), t('friends_unavailable_body')));
    return;
  }

  renderLoading(root);
  let data;
  try {
    data = await loadFriends(true);
  } catch (err) {
    if (err && err.status === 404) {
      root.textContent = '';
      root.appendChild(emptyState('group_off', t('friends_unavailable_title'), t('friends_unavailable_body')));
      return;
    }
    renderRetry(root, describeNetworkFailure(t('friends_title'), err), function () {
      renderPeople(root, params);
    }, { onBack: function () { navigateTo('#/home'); }, backLabel: t('nav_home') });
    return;
  }
  root.textContent = '';

  let activeTab = TABS.indexOf(params.get('tab')) !== -1 ? params.get('tab') : 'friends';
  let searchToken = 0;
  let searchTimer = null;
  let query = '';

  const header = el('header', 'jellio-home-header');
  header.appendChild(el('h1', 'jellio-home-greeting', t('friends_title')));
  root.appendChild(header);

  const tabBar = el('div', 'jellio-profile-nav-tabs jellio-people-tabs');
  tabBar.setAttribute('role', 'tablist');
  tabBar.setAttribute('aria-label', t('friends_title'));
  const tabButtons = {};
  const panel = el('div', 'jellio-people-panel');
  panel.setAttribute('role', 'tabpanel');
  root.appendChild(tabBar);
  root.appendChild(panel);

  function refreshCounts() {
    const badge = tabButtons.requests.querySelector('.jellio-people-count');
    badge.textContent = String(data.Incoming.length);
    badge.hidden = data.Incoming.length === 0;
    tabButtons.requests.setAttribute('aria-label', t('friends_tab_requests') + (data.Incoming.length ? ', ' + data.Incoming.length : ''));
  }

  // Rebuild the lists from the server after a change, without a spinner.
  function resync() {
    loadFriends(true).then(function (fresh) {
      data = fresh;
      refreshCounts();
      if (activeTab !== 'find') paint();
    }).catch(function () {});
  }

  function fail(err) {
    console.warn('Jellio: friends action failed', err);
    showToast(t(requestErrorKey(err)));
    if (err && err.status === 404) resync();
  }

  TABS.forEach(function (key) {
    const label = { friends: t('friends_tab_friends'), requests: t('friends_tab_requests'), find: t('friends_tab_find') }[key];
    const tab = el('button', 'jellio-profile-nav-tab');
    tab.type = 'button';
    tab.id = 'jellioPeopleTab-' + key;
    tab.setAttribute('role', 'tab');
    tab.appendChild(el('span', null, label));
    if (key === 'requests') {
      const count = el('span', 'jellio-people-count');
      count.setAttribute('aria-hidden', 'true');
      tab.appendChild(count);
    }
    tab.addEventListener('click', function () { selectTab(key); });
    tab.addEventListener('keydown', function (event) {
      const index = TABS.indexOf(key);
      let next = -1;
      if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
      else if (event.key === 'ArrowLeft') next = (index + TABS.length - 1) % TABS.length;
      if (next === -1) return;
      event.preventDefault();
      selectTab(TABS[next]);
      tabButtons[TABS[next]].focus();
    });
    tabButtons[key] = tab;
    tabBar.appendChild(tab);
  });

  function selectTab(key) {
    activeTab = key;
    try {
      window.history.replaceState(null, '', '#/people' + (key === 'friends' ? '' : '?tab=' + key));
    } catch (err) {}
    paint();
  }

  function paint() {
    TABS.forEach(function (key) {
      const on = key === activeTab;
      tabButtons[key].classList.toggle('jellio-profile-nav-tab-active', on);
      tabButtons[key].setAttribute('aria-selected', String(on));
      tabButtons[key].tabIndex = on ? 0 : -1;
    });
    panel.setAttribute('aria-labelledby', 'jellioPeopleTab-' + activeTab);
    refreshCounts();
    panel.textContent = '';
    if (activeTab === 'friends') paintFriends();
    else if (activeTab === 'requests') paintRequests();
    else paintFind();
  }

  function paintFriends() {
    if (!data.Friends.length) {
      panel.appendChild(
        emptyState('group_add', t('friends_empty_title'), t('friends_empty_body'), button(t('friends_tab_find'), '', function () { selectTab('find'); }, 'search')),
      );
      return;
    }
    const list = el('ul', 'jellio-people-list');
    list.tabIndex = -1;
    data.Friends.forEach(function (friend) {
      const row = personRow(friend, sinceText(friend.Since));
      const actions = row.querySelector('.jellio-people-actions');
      const muteChip = el('span', 'jellio-people-chip', t('friends_muted_label'));
      muteChip.hidden = !friend.Muted;
      actions.appendChild(muteChip);
      const more = el('button', 'jellio-people-more');
      more.type = 'button';
      more.setAttribute('aria-label', t('friends_menu_for', { name: friend.UserName }));
      more.setAttribute('aria-haspopup', 'menu');
      more.appendChild(el('span', 'material-icons', 'more_vert'));
      more.addEventListener('click', function () {
        openFriendMenu(friend, more, {
          onMuted: function (muted) { muteChip.hidden = !muted; },
          onRemoved: function () {
            data.Friends = data.Friends.filter(function (f) { return f !== friend; });
            removeRow(row, list);
            if (!data.Friends.length) paint();
            resync();
          },
        });
      });
      actions.appendChild(more);
      list.appendChild(row);
    });
    panel.appendChild(list);
  }

  function paintRequests() {
    if (!data.Incoming.length && !data.Outgoing.length) {
      panel.appendChild(emptyState('mail', t('friends_requests_empty_title'), t('friends_requests_empty_body')));
      return;
    }
    if (data.Incoming.length) {
      panel.appendChild(el('h2', 'jellio-people-heading', t('friends_incoming')));
      const list = el('ul', 'jellio-people-list');
      list.tabIndex = -1;
      data.Incoming.forEach(function (req) {
        const row = personRow(req);
        const actions = row.querySelector('.jellio-people-actions');
        const accept = button(t('friends_accept'), '', function () {
          act(accept, acceptFriendRequest(req.RequestId), req, row, list, 'Incoming');
        }, 'check');
        const decline = button(t('friends_decline'), 'jellio-settings-button-secondary', function () {
          act(decline, declineFriendRequest(req.RequestId), req, row, list, 'Incoming');
        });
        actions.appendChild(accept);
        actions.appendChild(decline);
        list.appendChild(row);
      });
      panel.appendChild(list);
    }
    if (data.Outgoing.length) {
      panel.appendChild(el('h2', 'jellio-people-heading', t('friends_outgoing')));
      const list = el('ul', 'jellio-people-list');
      list.tabIndex = -1;
      data.Outgoing.forEach(function (req) {
        const row = personRow(req, t('friends_waiting'));
        const cancel = button(t('friends_cancel'), 'jellio-settings-button-secondary', function () {
          act(cancel, cancelFriendRequest(req.RequestId), req, row, list, 'Outgoing');
        });
        row.querySelector('.jellio-people-actions').appendChild(cancel);
        list.appendChild(row);
      });
      panel.appendChild(list);
    }
  }

  function act(trigger, promise, req, row, list, bucket) {
    trigger.disabled = true;
    promise.then(
      function () {
        data[bucket] = data[bucket].filter(function (r) { return r !== req; });
        removeRow(row, list);
        refreshCounts();
        resync();
      },
      function (err) {
        trigger.disabled = false;
        fail(err);
      },
    );
  }

  function paintFind() {
    const box = el('div', 'jellio-people-search');
    box.appendChild(el('span', 'material-icons jellio-people-search-icon', 'search'));
    const input = el('input', 'jellio-settings-input jellio-people-search-input');
    input.type = 'search';
    input.value = query;
    input.placeholder = t('friends_search_placeholder');
    input.setAttribute('aria-label', t('friends_search_placeholder'));
    input.autocomplete = 'off';
    box.appendChild(input);
    panel.appendChild(box);
    const results = el('div', 'jellio-people-results');
    results.setAttribute('aria-live', 'polite');
    panel.appendChild(results);

    function run() {
      const token = ++searchToken;
      searchPeople(query).then(
        function (people) {
          if (token !== searchToken || !results.isConnected) return;
          paintResults(results, people);
        },
        function (err) {
          if (token !== searchToken || !results.isConnected) return;
          results.textContent = '';
          results.appendChild(emptyState('error_outline', t('friends_error_generic'), '', button(t('action_retry'), '', run)));
          console.warn('Jellio: people search failed', err);
        },
      );
    }
    input.addEventListener('input', function () {
      query = input.value.trim();
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(run, SEARCH_DEBOUNCE_MS);
    });
    results.appendChild(el('div', 'jellio-screen-spinner'));
    run();
  }

  function paintResults(results, people) {
    results.textContent = '';
    if (!people.length) {
      results.appendChild(emptyState('person_search', query ? t('friends_find_none_title') : t('friends_find_empty_title'), query ? t('friends_find_none_body') : t('friends_find_empty_body')));
      return;
    }
    const list = el('ul', 'jellio-people-list');
    list.tabIndex = -1;
    people.forEach(function (person) {
      const row = personRow(person);
      paintPersonAction(row, person);
      list.appendChild(row);
    });
    results.appendChild(list);
  }

  function requestFor(bucket, person) {
    return data[bucket].find(function (r) { return normalizeId(r.UserId) === normalizeId(person.UserId); });
  }

  function paintPersonAction(row, person) {
    const actions = row.querySelector('.jellio-people-actions');
    actions.textContent = '';
    const spec = statusToButton(person.Status, true);
    if (spec.state === 'add') {
      const add = button(t(spec.labelKey), '', function () {
        person.Status = 'outgoing';
        paintPersonAction(row, person);
        sendFriendRequest(person.UserId).then(
          function (result) {
            if (result && result.Status === 'friends') {
              row.remove();
              resync();
              return;
            }
            // The cancel button needs the request id the server just made.
            loadFriends(true).then(function (fresh) {
              data = fresh;
              refreshCounts();
              paintPersonAction(row, person);
            }).catch(function () {});
          },
          function (err) {
            person.Status = 'none';
            paintPersonAction(row, person);
            fail(err);
          },
        );
      }, spec.icon);
      actions.appendChild(add);
    } else if (spec.state === 'sent') {
      const sent = button(t(spec.labelKey), 'jellio-settings-button-secondary', function () {
        const req = requestFor('Outgoing', person);
        if (!req) return;
        person.Status = 'none';
        paintPersonAction(row, person);
        cancelFriendRequest(req.RequestId).then(resync, function (err) {
          person.Status = 'outgoing';
          paintPersonAction(row, person);
          fail(err);
        });
      }, spec.icon);
      sent.title = t('friends_cancel_request');
      sent.setAttribute('aria-label', t('friends_request_sent') + '. ' + t('friends_cancel_request'));
      actions.appendChild(sent);
    } else if (spec.state === 'incoming') {
      const accept = button(t('friends_accept'), '', function () {
        const req = requestFor('Incoming', person);
        if (!req) return;
        accept.disabled = true;
        acceptFriendRequest(req.RequestId).then(function () {
          row.remove();
          resync();
        }, function (err) {
          accept.disabled = false;
          fail(err);
        });
      }, 'check');
      actions.appendChild(accept);
    }
  }

  paint();
}
