// One table for language codes: ISO 639-1, 639-2/B and 639-2/T codes and
// English names all resolve to the 639-2/B code (the form Jellyfin and
// ffmpeg usually report). The first name on a line is the display name.
const ISO_639 = `
aa aar|Afar
ab abk|Abkhazian
af afr|Afrikaans
ak aka|Akan
am amh|Amharic
ar ara|Arabic
an arg|Aragonese
as asm|Assamese
av ava|Avaric
ae ave|Avestan
ay aym|Aymara
az aze|Azerbaijani
ba bak|Bashkir
bm bam|Bambara
be bel|Belarusian
bn ben|Bengali;Bangla
bh bih|Bihari
bi bis|Bislama
bo tib bod|Tibetan
bs bos|Bosnian
br bre|Breton
bg bul|Bulgarian
ca cat|Catalan;Valencian
cs cze ces|Czech
ch cha|Chamorro
ce che|Chechen
cu chu|Church Slavic;Old Church Slavonic;Church Slavonic
cv chv|Chuvash
kw cor|Cornish
co cos|Corsican
cr cre|Cree
cy wel cym|Welsh
da dan|Danish
de ger deu|German
dv div|Divehi;Dhivehi;Maldivian
dz dzo|Dzongkha
el gre ell|Greek;Modern Greek
en eng|English
eo epo|Esperanto
et est|Estonian
eu baq eus|Basque
ee ewe|Ewe
fo fao|Faroese
fa per fas|Persian;Farsi
fj fij|Fijian
fi fin|Finnish
fr fre fra|French
fy fry|Western Frisian
ff ful|Fulah
gd gla|Scottish Gaelic;Gaelic
ga gle|Irish
gl glg|Galician
gv glv|Manx
gn grn|Guarani
gu guj|Gujarati
ht hat|Haitian Creole;Haitian
ha hau|Hausa
he heb|Hebrew
hz her|Herero
hi hin|Hindi
ho hmo|Hiri Motu
hr hrv|Croatian
hu hun|Hungarian
hy arm hye|Armenian
ig ibo|Igbo
io ido|Ido
ii iii|Sichuan Yi;Nuosu
iu iku|Inuktitut
ie ile|Interlingue;Occidental
ia ina|Interlingua
id ind|Indonesian
ik ipk|Inupiaq
is ice isl|Icelandic
it ita|Italian
jv jav|Javanese
ja jpn|Japanese
kl kal|Kalaallisut;Greenlandic
kn kan|Kannada
ks kas|Kashmiri
ka geo kat|Georgian
kr kau|Kanuri
kk kaz|Kazakh
km khm|Khmer;Central Khmer
ki kik|Kikuyu;Gikuyu
rw kin|Kinyarwanda
ky kir|Kyrgyz;Kirghiz
kv kom|Komi
kg kon|Kongo
ko kor|Korean
kj kua|Kuanyama;Kwanyama
ku kur|Kurdish
lo lao|Lao
la lat|Latin
lv lav|Latvian
li lim|Limburgan;Limburger;Limburgish
ln lin|Lingala
lt lit|Lithuanian
lb ltz|Luxembourgish;Letzeburgesch
lu lub|Luba-Katanga
lg lug|Ganda
mh mah|Marshallese
ml mal|Malayalam
mr mar|Marathi
mk mac mkd|Macedonian
mg mlg|Malagasy
mt mlt|Maltese
mn mon|Mongolian
mi mao mri|Maori;Māori
ms may msa|Malay
my bur mya|Burmese
na nau|Nauru
nv nav|Navajo;Navaho
nr nbl|South Ndebele
nd nde|North Ndebele
ng ndo|Ndonga
ne nep|Nepali
nl dut nld|Dutch;Flemish
nn nno|Norwegian Nynorsk;Nynorsk
nb nob|Norwegian Bokmål;Bokmål
no nor|Norwegian
ny nya|Chichewa;Chewa;Nyanja
oc oci|Occitan;Provençal
oj oji|Ojibwa
or ori|Oriya
om orm|Oromo
os oss|Ossetian;Ossetic
pa pan|Punjabi;Panjabi
pi pli|Pali
pl pol|Polish
pt por|Portuguese
ps pus|Pashto;Pushto
qu que|Quechua
rm roh|Romansh
ro rum ron|Romanian;Moldavian;Moldovan
rn run|Rundi
ru rus|Russian
sg sag|Sango
sa san|Sanskrit
si sin|Sinhala;Sinhalese
sk slo slk|Slovak
sl slv|Slovenian
se sme|Northern Sami
sm smo|Samoan
sn sna|Shona
sd snd|Sindhi
so som|Somali
st sot|Southern Sotho;Sotho
es spa|Spanish;Castilian
sq alb sqi|Albanian
sc srd|Sardinian
sr srp|Serbian
ss ssw|Swati
su sun|Sundanese
sw swa|Swahili
sv swe|Swedish
ty tah|Tahitian
ta tam|Tamil
tt tat|Tatar
te tel|Telugu
tg tgk|Tajik
tl tgl|Tagalog
th tha|Thai
ti tir|Tigrinya
to ton|Tongan;Tonga
tn tsn|Tswana
ts tso|Tsonga
tk tuk|Turkmen
tr tur|Turkish
tw twi|Twi
ug uig|Uyghur;Uighur
uk ukr|Ukrainian
ur urd|Urdu
uz uzb|Uzbek
ve ven|Venda
vi vie|Vietnamese
vo vol|Volapük
wa wln|Walloon
wo wol|Wolof
xh xho|Xhosa
yi yid|Yiddish
yo yor|Yoruba
za zha|Zhuang;Chuang
zh chi zho|Chinese;Mandarin
zu zul|Zulu
fil|Filipino
haw|Hawaiian
yue|Cantonese
ceb|Cebuano
hmn|Hmong
nds|Low German
gsw|Swiss German
`;

// Withdrawn codes still found in older files.
const LEGACY_CODES = { iw: 'heb', in: 'ind', ji: 'yid', jw: 'jav', mo: 'rum', scc: 'srp', scr: 'hrv' };

const SPECIAL_NAMES = {
  __original__: 'Original Audio',
  __multi__: 'Multi-Audio',
};

const CANONICAL = Object.create(null);
const NAMES = Object.create(null);

function foldKey(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

ISO_639.split('\n').forEach(function (line) {
  if (!line) return;
  const parts = line.split('|');
  const codes = parts[0].split(' ');
  const names = parts[1].split(';');
  const canonical = codes.length > 1 ? codes[1] : codes[0];
  codes.forEach(function (code) {
    CANONICAL[code] = canonical;
  });
  names.forEach(function (name) {
    const key = foldKey(name);
    if (!(key in CANONICAL)) CANONICAL[key] = canonical;
  });
  NAMES[canonical] = names[0];
});
Object.keys(LEGACY_CODES).forEach(function (code) {
  CANONICAL[code] = LEGACY_CODES[code];
});

// Any 639-1, 639-2/B or 639-2/T code (with or without a region, e.g.
// "pt-BR") or English name to its 639-2/B code. Unknown values come back
// lower-cased so they can still be compared with each other.
export function normalizeLanguage(code) {
  const raw = String(code || '').trim();
  if (!raw) return '';
  if (raw.indexOf('__') === 0) return raw.toLowerCase();
  const key = foldKey(raw);
  if (CANONICAL[key]) return CANONICAL[key];
  const unbracketed = key.replace(/\s*\(.*?\)\s*/g, ' ').trim();
  if (CANONICAL[unbracketed]) return CANONICAL[unbracketed];
  const head = key.split(/[-_]/)[0];
  return CANONICAL[head] || head;
}

let displayNames = null;
function intlLanguageName(code) {
  try {
    if (!displayNames && typeof Intl !== 'undefined' && Intl.DisplayNames) {
      displayNames = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });
    }
    return displayNames ? displayNames.of(code) || '' : '';
  } catch (err) {
    return '';
  }
}

export function languageName(code) {
  if (!code) return 'Unknown';
  const lower = String(code).toLowerCase();
  if (SPECIAL_NAMES[lower]) return SPECIAL_NAMES[lower];
  const canonical = normalizeLanguage(code);
  return NAMES[canonical] || intlLanguageName(lower) || String(code).toUpperCase();
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
