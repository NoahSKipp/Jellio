// Previous and next episode navigation rules shared by the player and tests.

export function isSpecialsSeason(season) {
  return !!(season && season.IndexNumber === 0);
}

// When an episode is the first of its season, walk earlier seasons nearest-first,
// skipping Specials unless the current episode is itself in Specials.
export function earlierSeasonIndexes(isSpecialsList, currentIndex) {
  if (!Array.isArray(isSpecialsList) || currentIndex < 0 || currentIndex >= isSpecialsList.length) {
    return [];
  }
  const currentIsSpecial = !!isSpecialsList[currentIndex];
  const indexes = [];
  for (let i = currentIndex - 1; i >= 0; i -= 1) {
    if (currentIsSpecial || !isSpecialsList[i]) {
      indexes.push(i);
    }
  }
  return indexes;
}

export function computeEpisodeNavState({ isEpisode, blockedInGroup, hasPrevious, hasNext }) {
  const allowed = !!(isEpisode && !blockedInGroup);
  return {
    showPrevious: allowed && !!hasPrevious,
    showNext: allowed && !!hasNext,
  };
}
