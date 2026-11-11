import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map([['jellio_display_language', 'en']]);
store.set('jellio_auth::session', JSON.stringify({ userId: 'u1', accessToken: 'tok' }));
const events = [];
globalThis.window = {
  Jellio: {},
  localStorage: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  },
  location: { origin: 'http://server', hash: '' },
  addEventListener: () => {},
  removeEventListener: () => {},
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clearTimeout: (id) => clearTimeout(id),
  dispatchEvent: () => true,
};
globalThis.document = {
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: (event) => {
    events.push(event.type);
    return true;
  },
  createElement: () => ({}),
  querySelector: () => null,
};

const calls = [];
let handler = () => ({ status: 200, body: {} });
globalThis.fetch = async (url, init) => {
  calls.push({ url, init: init || {} });
  const { status, body } = handler(url, init || {});
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    status,
    ok: status < 400,
    text: async () => text,
    json: async () => JSON.parse(text),
    headers: { get: () => null },
  };
};

const api = await import('../../src/Jellio/Frontend/runtime/api.js');
const helpers = await import('../../src/Jellio/Frontend/runtime/friendsHelpers.js');
const { t } = await import('../../src/Jellio/Frontend/runtime/i18n.js');

function last() {
  return calls[calls.length - 1];
}

test('the friends list loads once, feeds the incoming count and the snapshot', async () => {
  calls.length = 0;
  handler = () => ({ status: 200, body: { Friends: [{ UserId: 'a' }], Incoming: [{ RequestId: 'r1' }, { RequestId: 'r2' }] } });
  const data = await api.loadFriends();
  assert.equal(last().url, 'http://server/Jellio/friends');
  assert.deepEqual(data.Outgoing, []);
  assert.equal(api.friendsIncomingCount(), 2);
  assert.equal(api.friendsSupported(), true);
  assert.equal(api.getFriendsSnapshot(), data);
  await api.loadFriends();
  assert.equal(calls.length, 1);
});

test('request endpoints use the contract paths and bodies', async () => {
  calls.length = 0;
  handler = () => ({ status: 200, body: { Status: 'outgoing' } });
  await api.sendFriendRequest('abc');
  assert.equal(last().url, 'http://server/Jellio/friends/requests');
  assert.equal(last().init.method, 'POST');
  assert.deepEqual(JSON.parse(last().init.body), { UserId: 'abc' });

  await api.acceptFriendRequest('r 1');
  assert.equal(last().url, 'http://server/Jellio/friends/requests/r%201/accept');
  await api.declineFriendRequest('r1');
  assert.equal(last().url, 'http://server/Jellio/friends/requests/r1/decline');

  handler = () => ({ status: 200, body: { Status: 'none' } });
  assert.deepEqual(await api.cancelFriendRequest('r1'), { Status: 'none' });
  assert.equal(last().init.method, 'DELETE');
  assert.equal(last().url, 'http://server/Jellio/friends/requests/r1');
  await api.removeFriend('u9');
  assert.equal(last().url, 'http://server/Jellio/friends/u9');
  assert.equal(last().init.method, 'DELETE');
});

test('mute, status, people search and watchlist sends', async () => {
  calls.length = 0;
  handler = () => ({ status: 200, body: { Muted: true } });
  await api.setFriendMuted('u9', true);
  assert.equal(last().url, 'http://server/Jellio/friends/u9/mute');
  assert.deepEqual(JSON.parse(last().init.body), { Muted: true });

  handler = () => ({ status: 200, body: { Status: 'none', CanRequest: true } });
  await api.getFriendStatus('u9');
  assert.equal(last().url, 'http://server/Jellio/friends/status/u9');

  handler = () => ({ status: 200, body: [{ UserId: 'x', Status: 'none' }] });
  const people = await api.searchPeople('no ah');
  assert.equal(last().url, 'http://server/Jellio/friends/people?query=no%20ah');
  assert.equal(people.length, 1);

  handler = () => ({ status: 200, body: { Results: [{ UserId: 'a', Result: 'added' }] } });
  const results = await api.addToFriendsWatchlists('item1', ['a', 'b']);
  assert.equal(last().url, 'http://server/Jellio/watchlist/friends');
  assert.deepEqual(JSON.parse(last().init.body), { ItemId: 'item1', UserIds: ['a', 'b'] });
  assert.deepEqual(results, [{ UserId: 'a', Result: 'added' }]);
});

test('settings are read from the profile settings and saved to friends-settings', async () => {
  assert.equal(api.getFriendsSettings({ IsPrivate: false }), null);
  assert.deepEqual(api.getFriendsSettings({ FriendsCanAddToWatchlist: false, FriendRequestsFrom: 'nobody' }), {
    FriendsCanAddToWatchlist: false,
    FriendRequestsFrom: 'nobody',
  });
  handler = () => ({ status: 200, body: { FriendsCanAddToWatchlist: true } });
  await api.saveFriendsSettings({ FriendsCanAddToWatchlist: true });
  assert.equal(last().url, 'http://server/Jellio/profile/friends-settings');
  assert.deepEqual(JSON.parse(last().init.body), { FriendsCanAddToWatchlist: true });
});

test('refused requests keep the status and the JSON body on the error', async () => {
  handler = () => ({ status: 429, body: { Status: 'none', Error: 'Cooldown' } });
  await assert.rejects(api.sendFriendRequest('abc'), (err) => {
    assert.equal(err.status, 429);
    assert.equal(err.body.Error, 'Cooldown');
    assert.equal(helpers.requestErrorKey(err), 'friends_err_cooldown');
    return true;
  });
});

test('requestErrorKey picks a specific calm message', () => {
  assert.equal(helpers.requestErrorKey({ status: 403, body: { Status: 'private' } }), 'friends_err_private');
  assert.equal(helpers.requestErrorKey({ status: 403, body: { Status: 'closed' } }), 'friends_err_closed');
  assert.equal(helpers.requestErrorKey({ status: 409, body: { Error: 'FriendLimit' } }), 'friends_err_friend_limit');
  assert.equal(helpers.requestErrorKey({ status: 404 }), 'friends_err_request_gone');
  assert.equal(helpers.requestErrorKey({ status: 500 }), 'friends_error_generic');
  assert.equal(helpers.requestErrorKey(null), 'friends_error_generic');
});

test('a 404 from the people search marks friends unsupported and announces it', async () => {
  events.length = 0;
  handler = () => ({ status: 404, body: undefined });
  await assert.rejects(api.searchPeople(''));
  assert.equal(api.friendsSupported(), false);
  assert.ok(events.includes('jellio:friends-changed'));
});

test('added-by answers {} on an older server', async () => {
  api.invalidateCache('friends:added-by');
  handler = () => ({ status: 404, body: undefined });
  assert.deepEqual(await api.getAddedBy(), {});
});

test('statusToButton maps every status', () => {
  assert.deepEqual(
    ['none', 'outgoing', 'incoming', 'friends', 'closed', 'private', 'self'].map((s) => helpers.statusToButton(s, true).state),
    ['add', 'sent', 'incoming', 'friends', 'closed', 'hidden', 'hidden'],
  );
  assert.equal(helpers.statusToButton('none', false).state, 'closed');
  assert.equal(helpers.statusToButton('outgoing', true).action, 'cancel');
});

test('every add result has a message and a tone', () => {
  for (const r of ['added', 'already_on_list', 'already_watched', 'not_visible', 'muted', 'disabled', 'limit', 'not_friends', 'unsupported']) {
    const key = helpers.resultMessageKey(r);
    assert.notEqual(t(key), key, r);
    assert.ok(['ok', 'info', 'warn'].includes(helpers.resultTone(r)));
  }
  assert.equal(helpers.resultMessageKey('???'), 'friends_result_unknown');
  assert.equal(helpers.resultTone('added'), 'ok');
  assert.equal(helpers.resultTone('already_on_list'), 'info');
  assert.equal(helpers.resultTone('muted'), 'warn');
});

test('notification text follows the contract wording', () => {
  const say = (n) => {
    const x = helpers.notificationText(n);
    return t(x.key, x.params);
  };
  assert.equal(say({ Kind: 'friend_request', FromUserName: 'Noah' }), 'Noah wants to be your friend');
  assert.equal(say({ Kind: 'friend_accepted', FromUserName: 'Noah' }), 'Noah accepted your friend request');
  assert.equal(say({ Kind: 'watchlist_added', FromUserName: 'Noah', Name: 'Heat', Detail: '1' }), 'Noah added Heat to your watchlist');
  assert.equal(say({ Kind: 'watchlist_added', FromUserName: 'Noah', Name: 'Heat', Detail: '3' }), 'Noah added 3 titles to your watchlist');
  assert.equal(say({ Kind: 'watchlist_added', FromUserName: 'Noah', Name: 'Heat' }), 'Noah added Heat to your watchlist');
  assert.equal(helpers.notificationText({ Kind: 'episode' }), null);
});

test('notification targets open the item for one title and the Watchlist for more', () => {
  assert.equal(helpers.notificationTarget({ Kind: 'watchlist_added', ItemId: 'i1', Detail: '1' }), '#/item?id=i1');
  assert.equal(helpers.notificationTarget({ Kind: 'watchlist_added', ItemId: 'i1', Detail: '2' }), '#/home?tab=1');
  assert.equal(helpers.notificationTarget({ Kind: 'friend_request' }), '#/people?tab=requests');
  assert.equal(helpers.notificationTarget({ Kind: 'friend_accepted', FromUserId: 'u2' }), '#/profile?id=u2');
});

test('requestIdOf reads Detail or the notification id', () => {
  assert.equal(helpers.requestIdOf({ Detail: 'r9', Id: 'friendreq:r1' }), 'r9');
  assert.equal(helpers.requestIdOf({ Id: 'friendreq:r1' }), 'r1');
});

test('the startup summary covers adds, requests, both, and repeats only once', () => {
  const add = (id, n, name = 'Noah', title = 'Heat') => ({ Id: id, Kind: 'watchlist_added', FromUserName: name, Name: title, Detail: String(n), ItemId: 'i' + id, Read: false });
  const req = (id) => ({ Id: id, Kind: 'friend_request', FromUserName: 'Mia', Read: false });
  const say = (s) => t(s.text.key, s.text.params);

  const adds = helpers.startupSummary([add('a', 2)], '');
  assert.equal(say(adds), 'Noah added 2 titles to your watchlist');
  assert.equal(adds.target, '#/home?tab=1');

  const one = helpers.startupSummary([add('a', 1)], '');
  assert.equal(say(one), 'Noah added Heat to your watchlist');
  assert.equal(one.target, '#/item?id=ia');

  const reqs = helpers.startupSummary([req('r')], '');
  assert.equal(say(reqs), 'You have 1 new friend request');
  assert.equal(reqs.target, '#/people?tab=requests');
  assert.equal(say(helpers.startupSummary([req('r'), req('s')], '')), 'You have 2 new friend requests');

  const both = helpers.startupSummary([add('a', 2), req('r')], '');
  assert.equal(say(both), 'Friends added 2 titles to your watchlist. New friend requests: 1');
  assert.equal(say(helpers.startupSummary([add('a', 1), add('b', 1, 'Mia', 'Ran')], '')), 'Friends added 2 titles to your watchlist');

  assert.equal(helpers.startupSummary([add('a', 2)], adds.marker), null);
  assert.ok(helpers.startupSummary([add('a', 2), add('b', 1)], adds.marker));
  assert.equal(helpers.startupSummary([{ ...add('a', 2), Read: true }], ''), null);
  assert.equal(helpers.startupSummary([{ Id: 'e', Kind: 'episode', Read: false }], ''), null);
});

test('incoming requests are counted from notifications and names joined for the badge', () => {
  assert.equal(helpers.countIncomingRequests([{ Kind: 'friend_request' }, { Kind: 'episode' }, { Kind: 'friend_request' }]), 2);
  assert.equal(helpers.addedByNames([{ UserName: 'Noah' }, { UserName: 'Mia' }]), 'Noah, Mia');
  assert.equal(t('friends_added_by', { names: 'Noah' }), 'Added by Noah');
  assert.equal(helpers.friendMatches({ UserName: 'Noah' }, ' oa '), true);
  assert.equal(helpers.friendMatches({ UserName: 'Noah' }, 'x'), false);
  assert.equal(helpers.initialOf('  noah'), 'N');
  assert.equal(helpers.normalizeId('AB-cd'), 'abcd');
});
