// Real ISO 639-2/B codes, what MediaStream.Language actually carries
// (confirmed against Jellyfin's own MediaStream DTO before writing
// this), not a code a reader would recognize on sight. Shared between
// the subtitle track popover and the stream picker's own language
// filter chips rather than kept as two separate copies of the same map.
const LANGUAGE_NAMES = {
  eng: 'English', ger: 'German', deu: 'German', fre: 'French', fra: 'French',
  spa: 'Spanish', ita: 'Italian', jpn: 'Japanese', kor: 'Korean', chi: 'Chinese',
  zho: 'Chinese', rus: 'Russian', por: 'Portuguese', dut: 'Dutch', nld: 'Dutch',
  ara: 'Arabic', pol: 'Polish', swe: 'Swedish', tur: 'Turkish',
};

export function languageName(code) {
  if (!code) return 'Unknown';
  return LANGUAGE_NAMES[code.toLowerCase()] || code.toUpperCase();
}

// One real canonical code per real name (ger over deu, fre over fra,
// dut over nld), for anywhere that needs one pickable option per
// language rather than the full duplicate-carrying lookup table above,
// screens/settings.js's own default audio/subtitle language pickers.
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
