// Streams a user added by link (see Controllers/StreamLinksController.cs),
// shaped like Live TV channels so the same list, filters and player work
// for both.
import { classifyChannel } from './liveTv.js';

export const LINK_PREFIX = 'link:';
// A big channel list renders this many tiles until a search narrows it.
export const PLAYLIST_PREVIEW = 120;

export function linkChannelId(linkId, entryIndex) {
  return LINK_PREFIX + linkId + (entryIndex == null ? '' : ':' + entryIndex);
}

export function parseLinkChannelId(id) {
  if (typeof id !== 'string' || id.indexOf(LINK_PREFIX) !== 0) return null;
  const parts = id.slice(LINK_PREFIX.length).split(':');
  if (!parts[0]) return null;
  const entry = parts.length > 1 && parts[1] !== '' ? Number(parts[1]) : null;
  return { linkId: parts[0], entry: Number.isInteger(entry) && entry >= 0 ? entry : null };
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (err) {
    return '';
  }
}

function userChannel(link, entry, index) {
  const name = entry ? entry.Name || link.Name : link.Name;
  const group = entry ? entry.Group || link.Name : hostOf(link.SourceUrl);
  const kind = classifyChannel(name + ' ' + (entry && entry.Group ? entry.Group : ''));
  return {
    id: linkChannelId(link.Id, entry ? index : null),
    linkId: link.Id,
    entry: entry ? index : null,
    name: name || hostOf(link.SourceUrl),
    group: group,
    logoUrl: entry && entry.Logo ? entry.Logo : null,
    kind: kind.kind,
    language: kind.language,
    imageTag: null,
    favorite: false,
    now: null,
    userStream: true,
  };
}

// One entry per playable stream, playlists expanded in their own order.
export function flattenStreamLinks(links) {
  const out = [];
  (links || []).forEach(function (link) {
    if (!link || !link.Id) return;
    if (link.Kind === 'playlist') {
      (link.Entries || []).forEach(function (entry, index) {
        out.push(userChannel(link, entry, index));
      });
    } else {
      out.push(userChannel(link, null, null));
    }
  });
  return out;
}

// Single streams together, then each playlist as its own section.
export function groupStreamLinks(links, visibleIds) {
  const visible = visibleIds ? new Set(visibleIds) : null;
  const singles = [];
  const playlists = [];
  (links || []).forEach(function (link) {
    if (!link || !link.Id) return;
    const channels = flattenStreamLinks([link]).filter(function (c) {
      return !visible || visible.has(c.id);
    });
    if (link.Kind === 'playlist') {
      if (channels.length || !visible) playlists.push({ link: link, channels: channels });
    } else if (channels.length) {
      singles.push({ link: link, channel: channels[0] });
    }
  });
  return { singles: singles, playlists: playlists };
}

const ERROR_KEYS = {
  invalid_url: 'live_link_error_invalid',
  blocked_address: 'live_link_error_blocked',
  unreachable: 'live_link_error_unreachable',
  timeout: 'live_link_error_timeout',
  no_stream_found: 'live_link_error_none',
  too_many_links: 'live_link_error_too_many',
};

export function streamLinkErrorKey(code) {
  return ERROR_KEYS[code] || 'live_link_error_failed';
}

// hls.js and the browser play HLS and MP4; raw MPEG-TS needs Jellio TV.
export function playableInBrowser(format) {
  return format === 'hls' || format === 'mp4' || format === 'other';
}
