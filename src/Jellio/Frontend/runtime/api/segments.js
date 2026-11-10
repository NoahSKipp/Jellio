import { getJson, postJson } from './core.js';
import { TICKS_PER_SECOND } from './streams.js';

async function getNativeMediaSegments(itemId) {
  const result = await getJson('/MediaSegments/' + itemId);
  const items = Array.isArray(result) ? result : (result && result.Items) || [];
  if (!items.length) {
    console.warn('Jellio: native Media Segments came back with nothing for', itemId, result);
  }
  function bySeconds(type) {
    const segment = items.find(function (s) {
      return s.Type === type;
    });
    return segment
      ? { Start: segment.StartTicks / TICKS_PER_SECOND, End: segment.EndTicks / TICKS_PER_SECOND }
      : null;
  }
  const introduction = bySeconds('Intro');
  const credits = bySeconds('Outro');
  if (!introduction && !credits) return null;
  return {
    Introduction: introduction || { Start: 0, End: 0 },
    Credits: credits || { Start: 0, End: 0 },
  };
}

export async function getCommunitySkipSegments(itemId) {
  try {
    const result = await getJson('/Jellio/introcredits/community/' + itemId);
    if (!result) return null;
    const introduction = result.Introduction ? { Start: result.Introduction.Start, End: result.Introduction.End } : null;
    const credits = result.Credits ? { Start: result.Credits.Start, End: result.Credits.End } : null;
    if (!introduction && !credits) return null;
    return {
      Introduction: introduction || { Start: 0, End: 0 },
      Credits: credits || { Start: 0, End: 0 },
    };
  } catch (err) {
    console.warn('Jellio: community skip data lookup failed for', itemId, err);
    return null;
  }
}

export async function getIntroSkipperSegments(itemId) {
  try {
    const native = await getNativeMediaSegments(itemId);
    if (native) return native;
  } catch (err) {
    console.warn('Jellio: native Media Segments lookup failed for', itemId, err && err.status, err);
  }

  try {
    const result = await getJson('/Episode/' + itemId + '/Timestamps');
    return result || {};
  } catch (err) {
    console.warn('Jellio: Intro Skipper segment lookup failed for', itemId, err && err.status, err);
    return {};
  }
}

export async function getJellioIntroCredits(itemId) {
  try {
    const result = await getJson('/Jellio/introcredits/' + itemId);
    if (!result) return null;
    const introduction = result.Introduction ? { Start: result.Introduction.Start, End: result.Introduction.End } : null;
    const credits = result.Credits ? { Start: result.Credits.Start, End: result.Credits.End } : null;
    if (!introduction && !credits) return null;
    return {
      Introduction: introduction || { Start: 0, End: 0 },
      Credits: credits || { Start: 0, End: 0 },
    };
  } catch (err) {
    console.warn('Jellio: could not load Jellio-analyzed intro/credits for', itemId, err);
    return null;
  }
}

export function scanIntroCreditsForItem(itemId, useAnalyzerFallback) {
  if (!itemId) return Promise.reject(new Error('Missing item id'));
  const query = '?useAnalyzerFallback=' + (useAnalyzerFallback ? 'true' : 'false');
  return postJson('/Jellio/introcredits/scan/' + itemId + query, {}, 600000);
}
