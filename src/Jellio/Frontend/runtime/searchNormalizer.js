// Search normalization, variant expansion, and fuzzy scoring for Jellio search.
// Strictly no em dashes or en dashes.

const ALIASES = {
  lotr: 'The Lord of the Rings',
  got: 'Game of Thrones',
  hotd: 'House of the Dragon',
  aot: 'Attack on Titan',
  jjk: 'Jujutsu Kaisen',
  mha: 'My Hero Academia',
  fmab: 'Fullmetal Alchemist Brotherhood',
  b99: 'Brooklyn Nine-Nine',
  himym: 'How I Met Your Mother',
  tbbt: 'The Big Bang Theory',
  iasip: "It's Always Sunny in Philadelphia",
  sw: 'Star Wars',
  hp: 'Harry Potter',
};

const COMPOUND_PAIRS = [
  ['spiderman', 'spider-man', 'spider man'],
  ['starwars', 'star wars'],
  ['xmen', 'x-men', 'x men'],
  ['batman', 'bat man'],
  ['ironman', 'iron man'],
];

const NUMBER_VARIANTS = {
  '99': ['nine-nine', 'ninety-nine', '99'],
  'nine-nine': ['99', 'nine-nine'],
  'ninety-nine': ['99', 'nine-nine'],
  '1': ['one', 'i', '1'],
  'one': ['1', 'i', 'one'],
  'i': ['1', 'one', 'i'],
  '2': ['two', 'ii', '2'],
  'two': ['2', 'ii', 'two'],
  'ii': ['2', 'two', 'ii'],
  '3': ['three', 'iii', '3'],
  'three': ['3', 'iii', 'three'],
  'iii': ['3', 'three', 'iii'],
  '4': ['four', 'iv', '4'],
  'four': ['4', 'iv', 'four'],
  'iv': ['4', 'four', 'iv'],
  '5': ['five', 'v', '5'],
  'five': ['5', 'v', 'five'],
  'v': ['5', 'five', 'v'],
  '6': ['six', 'vi', '6'],
  'six': ['6', 'vi', 'six'],
  'vi': ['6', 'six', 'vi'],
  '7': ['seven', 'vii', '7'],
  'seven': ['7', 'vii', 'seven'],
  'vii': ['7', 'seven', 'vii'],
  '8': ['eight', 'viii', '8'],
  'eight': ['8', 'viii', 'eight'],
  'viii': ['8', 'eight', 'viii'],
  '9': ['nine', 'ix', '9'],
  'nine': ['9', 'ix', 'nine'],
  'ix': ['9', 'ix', 'nine'],
  '10': ['ten', 'x', '10'],
  'ten': ['10', 'x', 'ten'],
  'x': ['10', 'ten', 'x'],
};

export function normalizeSearchQuery(q) {
  if (typeof q !== 'string') return '';
  return q
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019\u00B4`]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/&/g, ' and ')
    .replace(/['"]/g, '')
    .replace(/[-_.:;,!?()[\]{}#@*\/\\+]/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function expandSearchQueryVariants(q) {
  if (typeof q !== 'string') return [];
  const raw = q.trim();
  if (!raw) return [];
  const normalized = normalizeSearchQuery(raw);
  const variants = [];

  function add(v) {
    if (!v || typeof v !== 'string') return;
    const clean = v.trim();
    if (clean && !variants.some(function (existing) { return existing.toLowerCase() === clean.toLowerCase(); })) {
      variants.push(clean);
    }
  }

  // 1. Initial alias / acronym expansion
  const lowerRaw = raw.toLowerCase();
  const aliasMatch = ALIASES[lowerRaw] || ALIASES[normalized];
  if (aliasMatch) {
    add(aliasMatch);
  }

  // Check if query is reverse of an alias
  for (const [key, val] of Object.entries(ALIASES)) {
    if (normalizeSearchQuery(val) === normalized) {
      add(key);
    }
  }

  add(raw);
  if (normalized !== lowerRaw) {
    add(normalized);
  }

  // 2. Compound / hyphen variants
  for (const group of COMPOUND_PAIRS) {
    const matched = group.some(function (term) {
      return lowerRaw === term || normalized === normalizeSearchQuery(term);
    });
    if (matched) {
      for (const item of group) {
        add(item);
      }
    }
  }

  // 3. Number <-> word <-> Roman numeral variants
  const tokens = normalized.split(' ');
  let hasNumReplacements = false;
  const tokenVariantLists = tokens.map(function (tok) {
    const numList = NUMBER_VARIANTS[tok];
    if (numList) {
      hasNumReplacements = true;
      return numList;
    }
    return [tok];
  });

  if (hasNumReplacements && tokenVariantLists.length <= 4) {
    function generateCombos(index, current) {
      if (index >= tokenVariantLists.length) {
        add(current.join(' '));
        return;
      }
      for (const opt of tokenVariantLists[index]) {
        generateCombos(index + 1, current.concat(opt));
      }
    }
    generateCombos(0, []);
  }

  return variants;
}

export function damerauLevenshtein(a, b) {
  if (a === b) return 0;
  if (!a || !a.length) return (b && b.length) || 0;
  if (!b || !b.length) return a.length;

  const la = a.length;
  const lb = b.length;
  const d = [];

  for (let i = 0; i <= la; i++) {
    d[i] = [i];
  }
  for (let j = 0; j <= lb; j++) {
    d[0][j] = j;
  }

  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost
      );

      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }

  return d[la][lb];
}

function trigramsOf(str) {
  const trigrams = new Set();
  const padded = '  ' + str + ' ';
  for (let i = 0; i < padded.length - 2; i++) {
    trigrams.add(padded.slice(i, i + 3));
  }
  return trigrams;
}

function trigramSimilarity(a, b) {
  const triA = trigramsOf(a);
  const triB = trigramsOf(b);
  if (!triA.size || !triB.size) return 0;
  let shared = 0;
  for (const t of triA) {
    if (triB.has(t)) shared++;
  }
  return (2 * shared) / (triA.size + triB.size);
}

function scoreNormalizedPair(q, t) {
  if (!q || !t) return 0;
  if (q === t) return 1.0;
  if (t.startsWith(q)) return 0.95;
  if (t.includes(q)) return 0.85;

  const tokens = t.split(' ').filter(Boolean);
  const initials = tokens.map(function (tok) { return tok[0]; }).join('');
  if (initials === q || initials.startsWith(q)) return 0.9;

  const maxLen = Math.max(q.length, t.length);
  const dist = damerauLevenshtein(q, t);
  const levScore = Math.max(0, 1 - dist / maxLen);
  const triScore = trigramSimilarity(q, t);
  const score = levScore * 0.6 + triScore * 0.4;
  return Math.min(1, Math.max(0, Number(score.toFixed(4))));
}

export function fuzzyScoreTitle(query, candidateTitle) {
  const t = normalizeSearchQuery(candidateTitle);
  if (!t) return 0;
  const variants = expandSearchQueryVariants(query);
  let best = scoreNormalizedPair(normalizeSearchQuery(query), t);
  for (let i = 0; i < variants.length; i++) {
    const vNorm = normalizeSearchQuery(variants[i]);
    if (!vNorm) continue;
    const s = scoreNormalizedPair(vNorm, t);
    if (s > best) best = s;
  }
  return best;
}
