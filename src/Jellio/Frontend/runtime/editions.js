// Edition Recognition Engine for Jellio
// Identifies monochrome treatments (Noir, B&W) and alternate cuts (Director's Cut, Extended, etc.)

export const MONOCHROME_REGEX = /\b(noir|black\s*(?:and|&)\s*white|b[&/]w|black\s*(?:and|&)\s*chrome|minus\s*color|justice\s*is\s*gray|in\s*black\s*(?:and|&)\s*white)\b/i;

export const CUT_PATTERNS = [
  { name: 'Final Cut', regex: /\b(final\s*cut)\b/i },
  { name: "Director's Cut", regex: /\b(director(?:'s|\s*s)?\s*cut|\bdc\b)\b/i },
  { name: 'Extended', regex: /\b(extended(?:\s*(?:cut|edition))?|special\s*edition)\b/i },
  { name: 'Theatrical', regex: /\b(theatrical(?:\s*(?:cut|edition))?)\b/i },
  { name: 'Unrated', regex: /\b(unrated|uncut)\b/i },
  { name: 'Redux', regex: /\b(redux)\b/i },
  { name: 'IMAX', regex: /\b(imax(?:\s*enhanced)?)\b/i },
];

export function sourceText(source) {
  if (!source) return '';
  return ((source.Name || '') + ' ' + (source.Path || '')).trim();
}

export function rawEditionTag(source) {
  const text = sourceText(source);
  if (!text) return null;
  if (MONOCHROME_REGEX.test(text)) {
    return 'Noir / B&W';
  }
  for (const { name, regex } of CUT_PATTERNS) {
    if (regex.test(text)) {
      return name;
    }
  }
  return null;
}

export function getAvailableEditions(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return [];

  const tags = sources.map(rawEditionTag);
  const hasMonochrome = tags.some(function (t) { return t === 'Noir / B&W'; });
  const hasNonMonochrome = tags.some(function (t) { return t !== 'Noir / B&W'; });

  const editions = [];

  if (hasMonochrome && hasNonMonochrome) {
    editions.push('Color');
    editions.push('Noir / B&W');
  } else {
    const distinctCuts = new Set(tags.filter(function (t) { return t && t !== 'Noir / B&W'; }));
    const hasUncut = tags.some(function (t) { return !t; });
    if (distinctCuts.size > 0 && (hasUncut || distinctCuts.size > 1)) {
      if (hasUncut || distinctCuts.has('Theatrical')) {
        editions.push('Theatrical');
      }
      const order = ['Extended', "Director's Cut", 'Final Cut', 'Unrated', 'Redux', 'IMAX'];
      for (const cut of order) {
        if (distinctCuts.has(cut)) editions.push(cut);
      }
    }
  }

  if (editions.length < 2) return [];
  return editions;
}

export function detectSourceEdition(source, allSources) {
  if (!source) return null;
  const sources = Array.isArray(allSources) && allSources.length ? allSources : [source];
  const editions = getAvailableEditions(sources);
  if (editions.length < 2) {
    return rawEditionTag(source) || 'Standard';
  }

  const tag = rawEditionTag(source);

  if (editions.includes('Noir / B&W') && editions.includes('Color')) {
    if (tag === 'Noir / B&W') return 'Noir / B&W';
    return 'Color';
  }

  if (tag && editions.includes(tag)) {
    return tag;
  }

  if (editions.includes('Theatrical')) {
    return 'Theatrical';
  }

  return editions[0];
}

export function groupSourcesByEdition(sources) {
  const map = new Map();
  if (!Array.isArray(sources)) return map;
  const editions = getAvailableEditions(sources);
  if (editions.length < 2) {
    map.set('Standard', sources.slice());
    return map;
  }
  for (const ed of editions) {
    map.set(ed, []);
  }
  for (const s of sources) {
    const ed = detectSourceEdition(s, sources);
    if (map.has(ed)) {
      map.get(ed).push(s);
    } else {
      map.get(editions[0]).push(s);
    }
  }
  return map;
}

const EDITION_PREF_PREFIX = 'jellioEditionPref_';

export function getPreferredEdition(itemId, availableEditions) {
  if (!availableEditions || availableEditions.length < 2) return null;
  try {
    const saved = window.localStorage.getItem(EDITION_PREF_PREFIX + itemId);
    if (saved && availableEditions.includes(saved)) {
      return saved;
    }
  } catch (err) {}
  return availableEditions[0];
}

export function setPreferredEdition(itemId, edition) {
  try {
    window.localStorage.setItem(EDITION_PREF_PREFIX + itemId, edition);
  } catch (err) {}
}
