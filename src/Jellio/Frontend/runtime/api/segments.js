import { getJson, postJson } from './core.js';

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

// The server merges Jellyfin's Media Segments with the Intro Skipper plugin
// (GET /Jellio/segments/{id}); the first Intro and Outro become the skip ranges.
export async function getIntroSkipperSegments(itemId) {
  try {
    const result = await getJson('/Jellio/segments/' + itemId);
    const segments = (result && result.Segments) || [];
    function bySeconds(type) {
      const segment = segments.find(function (s) {
        return s.Type === type;
      });
      return segment ? { Start: segment.StartMs / 1000, End: segment.EndMs / 1000 } : null;
    }
    const introduction = bySeconds('Intro');
    const credits = bySeconds('Outro');
    if (!introduction && !credits) return {};
    return {
      Introduction: introduction || { Start: 0, End: 0 },
      Credits: credits || { Start: 0, End: 0 },
    };
  } catch (err) {
    console.warn('Jellio: skip segment lookup failed for', itemId, err && err.status);
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
