const INFO_FIELDS = ['Overview', 'Genres', 'Tags', 'People', 'Studios', 'ProductionYear', 'RunTimeTicks', 'PremiereDate', 'RemoteTrailers'];
const PLAYBACK_FIELDS = ['Chapters'];

function fieldsFor(includePlaybackFields) {
  return (includePlaybackFields ? INFO_FIELDS.concat(PLAYBACK_FIELDS) : INFO_FIELDS).join(',');
}

export function itemInfoPath(userId, itemId, includePlaybackFields) {
  const params = new URLSearchParams({ userId: userId, ids: itemId, Fields: fieldsFor(includePlaybackFields) });
  return '/Items?' + params.toString();
}

// A search result Gelato has not imported yet is only inserted when it is
// asked for by id, so that request stays as the fallback.
export function itemFallbackPath(userId, itemId, includePlaybackFields) {
  const params = new URLSearchParams({ Fields: fieldsFor(includePlaybackFields) });
  return '/Users/' + userId + '/Items/' + itemId + '?' + params.toString();
}

export function loadItemInfo(getJson, userId, itemId, options) {
  const playback = !!(options && options.includePlaybackFields);
  const timeout = options && options.timeoutMs;
  const signal = options && options.signal;
  return getJson(itemInfoPath(userId, itemId, playback), timeout, signal)
    .then(function (result) {
      const item = result && result.Items && result.Items[0];
      if (item) return item;
      return getJson(itemFallbackPath(userId, itemId, playback), timeout, signal);
    })
    .catch(function (err) {
      if (err && (err.name === 'AbortError' || err.aborted || (signal && signal.aborted))) {
        throw err;
      }
      return getJson(itemFallbackPath(userId, itemId, playback), timeout, signal);
    })
    .then(function (result) {
      if (result && result.Items && result.Items[0]) return result.Items[0];
      return result;
    });
}

// The detail page's stream lookup: started after the page is drawn,
// reports 'finding', then 'ready' with the sources, 'empty' or 'failed'.
export function watchSources(fetchSources, onChange) {
  let done = false;
  onChange({ state: 'finding', sources: [] });
  const promise = Promise.resolve()
    .then(fetchSources)
    .then(
      function (sources) {
        const list = sources || [];
        onChange({ state: list.length ? 'ready' : 'empty', sources: list });
        return list;
      },
      function (err) {
        onChange({ state: 'failed', sources: [], error: err });
        return [];
      },
    )
    .finally(function () {
      done = true;
    });
  return {
    promise: promise,
    isDone: function () {
      return done;
    },
  };
}
