// Time-of-day copy table for the Shows library's own coverflow header.
// Ported faithfully from Harbor's own src/views/shows/hero-curation.ts
// (dayBucket(), the real BUCKET_VARIANTS copy table, and bucketCopy()'s
// own day-of-year rotation formula), not a single-variant-per-bucket
// simplification: Harbor rotates through 7 real copy variants per
// bucket, picking one by day of year rather than holding one line
// fixed all bucket long. The library's own real content pool never
// changes because of any of this, matching Harbor's own real
// buildShowHero(): bucketCopy() and the item pool are two separate
// concerns over there, this file only ever ports the first.
const BUCKET_ICONS = {
  morning: 'wb_sunny',
  afternoon: 'wb_cloudy',
  evening: 'weekend',
  night: 'bedtime',
};

const BUCKET_INDEX = { morning: 0, afternoon: 1, evening: 2, night: 3 };

const BUCKET_VARIANTS = {
  morning: [
    {
      kicker: 'Morning Lineup',
      title: 'Easing into series',
      subtitle: 'Slow-burn worlds and bright chapters worth opening with coffee.',
    },
    {
      kicker: 'Good Morning',
      title: "Today's openers",
      subtitle: 'Series to ease into while the day is still quiet.',
    },
    {
      kicker: 'Daybreak',
      title: 'First-light picks',
      subtitle: 'Worlds to step into before the inbox catches up.',
    },
    {
      kicker: 'AM Picks',
      title: 'Coffee-and-couch',
      subtitle: 'Half-hours, anthologies, and a few epics for the morning routine.',
    },
    {
      kicker: 'Open the Day',
      title: 'Series with mileage',
      subtitle: 'Long-running comforts and new chapters worth pressing play on.',
    },
    {
      kicker: 'Quiet Hours',
      title: 'Slow-burn starts',
      subtitle: 'Stories that reward your attention before the day gets loud.',
    },
    {
      kicker: 'This Morning',
      title: 'Worth catching up on',
      subtitle: 'What everyone has been quietly binging this week.',
    },
  ],
  afternoon: [
    {
      kicker: 'Afternoon Picks',
      title: 'Daytime watching',
      subtitle: 'Easy half-hours and lighter dramas to ride out the afternoon.',
    },
    {
      kicker: 'Midday Lineup',
      title: 'Between meetings',
      subtitle: "Episodes you can drop into without losing the thread.",
    },
    {
      kicker: 'Afternoon Roll',
      title: 'Pick up an episode',
      subtitle: 'Lunch-break comedies and slow-cooker dramas, ready when you are.',
    },
    {
      kicker: 'The Long Lunch',
      title: 'Series to disappear into',
      subtitle: 'Worlds wide enough for an hour or a whole free afternoon.',
    },
    {
      kicker: 'Daylight Watching',
      title: 'Bright-side series',
      subtitle: 'Sharp comedies, sunny worlds, and the occasional binge bait.',
    },
    {
      kicker: 'Holdover Picks',
      title: 'Carry it through the day',
      subtitle: 'Companion series for whatever the afternoon throws at you.',
    },
    {
      kicker: 'PM Picks',
      title: 'Couch hours',
      subtitle: 'Series for the part of the day that runs on coffee and snacks.',
    },
  ],
  evening: [
    {
      kicker: 'Tonight',
      title: "Tonight's lineup",
      subtitle: 'Prestige drama, weekly chapters, and series worth disappearing into.',
    },
    {
      kicker: 'Prime Time',
      title: 'What to watch tonight',
      subtitle: 'Crowd-pleasers, prestige picks, and the kind of series people text about.',
    },
    {
      kicker: 'Sundown',
      title: 'Evening on the couch',
      subtitle: 'Drop-in chapters and long arcs for the post-dinner stretch.',
    },
    {
      kicker: 'Press Play',
      title: "Tonight's marquee",
      subtitle: 'The series that make the rest of the night disappear.',
    },
    {
      kicker: "Tonight's Slate",
      title: 'Episodes worth the evening',
      subtitle: "What's hot this week, what's prestige forever, what's worth the hours.",
    },
    {
      kicker: 'Showtime',
      title: "Tonight's main event",
      subtitle: 'Series for the part of the day you actually look forward to.',
    },
    {
      kicker: 'Saved for Now',
      title: "Tonight's binge bait",
      subtitle: 'Pilots that pull you in and finales that earn the season.',
    },
  ],
  night: [
    {
      kicker: 'Late Night',
      title: 'After-hours picks',
      subtitle: 'Dark, immersive, and binge-worthy when the house is quiet.',
    },
    {
      kicker: 'Past Midnight',
      title: 'One more episode',
      subtitle: "Series for the part of the night that won't let you sleep.",
    },
    {
      kicker: 'Witching Hour',
      title: 'Late-night chapters',
      subtitle: 'Pull-you-under stories for the quietest part of the day.',
    },
    {
      kicker: 'Lights Out',
      title: 'Headphone series',
      subtitle: 'Slow, strange, and absorbing. Best with the lights down low.',
    },
    {
      kicker: 'Insomnia Lineup',
      title: 'Worth the lost hour',
      subtitle: 'Dense plots and rich worlds for when sleep is not happening.',
    },
    {
      kicker: 'Late Show',
      title: 'After the news',
      subtitle: 'Quiet dramas, sharp thrillers, and series you save for yourself.',
    },
    {
      kicker: 'Night Owl',
      title: "While the world's asleep",
      subtitle: 'Series with the patience to match your late-night hours.',
    },
  ],
};

function dayBucket(hour) {
  const h = hour < 5 ? hour + 24 : hour;
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 22) return 'evening';
  return 'night';
}

function dayOfYear(date) {
  const start = new Date(date.getFullYear(), 0, 0);
  return Math.floor((date.getTime() - start.getTime()) / 86400000);
}

export function showsEditorial(hour) {
  const now = new Date();
  const bucket = dayBucket(hour);
  const variants = BUCKET_VARIANTS[bucket];
  const idx = (dayOfYear(now) + BUCKET_INDEX[bucket] * 3) % variants.length;
  const copy = variants[idx];
  return { icon: BUCKET_ICONS[bucket], label: copy.kicker, tagline: copy.title, description: copy.subtitle };
}

// Harbor's own real mulberry32 PRNG, ported verbatim from
// hero-curation.ts: seeds a Fisher-Yates shuffle deterministically, the
// same seed producing the same order for everyone reading it in that
// same bucket on that same day, rather than a plain Math.random() that
// would reshuffle on every reload.
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Harbor's own real seededShuffle(): reorders a pool without touching
// which items are in it, the same real split its own buildShowHero()
// keeps between "what's in the pool" (untouched here) and "what order
// it renders in" (this).
export function seededShuffle(items, seed) {
  const out = items.slice();
  const rand = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

// Harbor's own real rotationSeed(): dayOfYear*4 plus the current
// bucket's own index, a distinct seed for every (day, bucket) pair so
// the shuffle above rolls over as the reader's own local time crosses
// into a new bucket, not just once a day at midnight.
export function rotationSeed() {
  const now = new Date();
  const bucket = dayBucket(now.getHours());
  return dayOfYear(now) * 4 + BUCKET_INDEX[bucket];
}
