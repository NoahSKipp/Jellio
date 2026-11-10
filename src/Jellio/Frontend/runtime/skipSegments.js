// Intro and credits skip rules shared by the player and the vector tests.
// Segments are { Introduction: { Start, End }, Credits: { Start, End } } in seconds;
// { Start: 0, End: 0 } stands for a missing range.

const EMPTY = { Start: 0, End: 0 };

export function isValidSegment(segment) {
  return !!(segment && segment.End > 0 && segment.End > segment.Start);
}

// Credits starting in the first half are bad data: they would show Skip
// Credits and Up Next right at the start.
export function isValidCredits(segment, runtimeSeconds) {
  if (!isValidSegment(segment)) return false;
  return !runtimeSeconds || segment.Start >= runtimeSeconds * 0.5;
}

// What is already known wins; the candidate only fills what is missing or unusable.
export function mergeSkipSegments(current, candidate, runtimeSeconds) {
  if (!candidate) return current;
  return {
    Introduction: isValidSegment(current && current.Introduction) ? current.Introduction : candidate.Introduction,
    Credits: isValidCredits(current && current.Credits, runtimeSeconds)
      ? current.Credits
      : isValidCredits(candidate.Credits, runtimeSeconds) ? candidate.Credits : EMPTY,
  };
}

export function skipSegmentsComplete(segments, runtimeSeconds) {
  return !!(segments && isValidSegment(segments.Introduction) && isValidCredits(segments.Credits, runtimeSeconds));
}

// 'intro' or 'credits' with where Skip goes, or null.
export function activeSkipSegment(segments, currentTime) {
  if (!segments) return null;
  const intro = segments.Introduction;
  if (intro && intro.End > 0 && currentTime >= intro.Start && currentTime < intro.End) {
    return { kind: 'intro', target: intro.End };
  }
  const credits = segments.Credits;
  if (credits && credits.End > 0 && currentTime >= credits.Start && currentTime < credits.End) {
    return { kind: 'credits', target: credits.End };
  }
  return null;
}

// No credits data, no countdown card: the end screen covers those.
export function shouldShowUpNextNow(segments, currentTime, duration) {
  if (!duration) return false;
  const credits = segments && segments.Credits;
  if (credits && credits.End > 0 && credits.Start >= 0) return currentTime >= credits.Start;
  return false;
}

// A chapter named like an intro or credits runs until the next chapter (or the end).
export function chapterFallbackSegments(chapters, runTimeTicks, ticksPerSecond) {
  if (!chapters || !chapters.length) return null;
  function findSegment(nameRegex) {
    const index = chapters.findIndex(function (chapter) {
      return chapter.Name && nameRegex.test(chapter.Name);
    });
    if (index === -1) return null;
    const start = (chapters[index].StartPositionTicks || 0) / ticksPerSecond;
    const nextTicks = index + 1 < chapters.length ? chapters[index + 1].StartPositionTicks : runTimeTicks;
    const end = (nextTicks || 0) / ticksPerSecond;
    return end > start ? { Start: start, End: end } : null;
  }
  const introduction = findSegment(/^(intro|introduction|opening)/i);
  // "Opening Credits" is the intro, not the end credits.
  const credits = findSegment(/^(?!.*open).*(credit|outro|ending)/i);
  if (!introduction && !credits) return null;
  return { Introduction: introduction || EMPTY, Credits: credits || EMPTY };
}
