// Which audio language to look for when Jellio picks a stream on its
// own (failover, buffering switch), and the order to try streams in.

const CANONICAL = {
  en: 'eng', eng: 'eng',
  de: 'ger', ger: 'ger', deu: 'ger',
  fr: 'fre', fre: 'fre', fra: 'fre',
  es: 'spa', spa: 'spa',
  it: 'ita', ita: 'ita',
  pl: 'pol', pol: 'pol',
  pt: 'por', por: 'por',
  ja: 'jpn', jpn: 'jpn',
  ko: 'kor', kor: 'kor',
  zh: 'chi', chi: 'chi', zho: 'chi',
  ru: 'rus', rus: 'rus',
  nl: 'dut', dut: 'dut', nld: 'dut',
  ar: 'ara', ara: 'ara',
  sv: 'swe', swe: 'swe',
  tr: 'tur', tur: 'tur',
};

export function normalizeLanguage(code) {
  const value = String(code || '').toLowerCase().split('-')[0];
  return CANONICAL[value] || value;
}

// A preferred audio language set by the user wins; otherwise the menu
// language stands in for it.
export function preferredStreamLanguage(audioPreference, displayLanguage) {
  return normalizeLanguage(audioPreference) || normalizeLanguage(displayLanguage);
}

// Streams with the language first; streams in other languages only when
// none in the language are left. Multi-audio streams (language unknown)
// come right after the matches.
export function orderByLanguage(sources, language, languagesOf) {
  const wanted = normalizeLanguage(language);
  if (!wanted) return sources.slice();
  const matches = [];
  const multi = [];
  const others = [];
  sources.forEach(function (source) {
    const codes = languagesOf(source).map(normalizeLanguage);
    if (codes.indexOf(wanted) !== -1) matches.push(source);
    else if (codes.indexOf('__multi__') !== -1) multi.push(source);
    else others.push(source);
  });
  if (matches.length || multi.length) return matches.concat(multi);
  return others;
}
