const LANGUAGE_NAMES = {
  eng: 'English', ger: 'German', deu: 'German', fre: 'French', fra: 'French',
  spa: 'Spanish', ita: 'Italian', jpn: 'Japanese', kor: 'Korean', chi: 'Chinese',
  zho: 'Chinese', rus: 'Russian', por: 'Portuguese', dut: 'Dutch', nld: 'Dutch',
  ara: 'Arabic', pol: 'Polish', swe: 'Swedish', tur: 'Turkish',
  __original__: 'Original Audio',
  __multi__: 'Multi-Audio',
};

export function languageName(code) {
  if (!code) return 'Unknown';
  return LANGUAGE_NAMES[code.toLowerCase()] || code.toUpperCase();
}

export const LANGUAGE_OPTIONS = [
  { code: 'eng', name: 'English' },
  { code: 'ger', name: 'German' },
  { code: 'fre', name: 'French' },
  { code: 'spa', name: 'Spanish' },
  { code: 'ita', name: 'Italian' },
  { code: 'jpn', name: 'Japanese' },
  { code: 'kor', name: 'Korean' },
  { code: 'chi', name: 'Chinese' },
  { code: 'rus', name: 'Russian' },
  { code: 'por', name: 'Portuguese' },
  { code: 'dut', name: 'Dutch' },
  { code: 'ara', name: 'Arabic' },
  { code: 'pol', name: 'Polish' },
  { code: 'swe', name: 'Swedish' },
  { code: 'tur', name: 'Turkish' },
];
