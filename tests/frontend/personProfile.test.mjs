import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateAge,
  parseMarkdownBio,
  buildRichPersonDetails,
  buildFallbackPersonDetails,
  filterCreditsForDepartment,
  formatCreditSubtitle,
  resolveCreditTarget,
} from '../../src/Jellio/Frontend/runtime/personProfile.js';

test('calculateAge handles living, deceased, UTC birthday boundary, and invalid dates', () => {
  const fixedNow = new Date('2026-06-15T12:00:00Z');
  assert.equal(calculateAge('1990-06-15', null, fixedNow), 36);
  assert.equal(calculateAge('1990-06-16', null, fixedNow), 35);
  assert.equal(calculateAge('1940-02-01', '2020-01-10', fixedNow), 79);
  assert.equal(calculateAge('1940-02-01', '2020-02-05', fixedNow), 80);
  assert.equal(calculateAge('', null, fixedNow), null);
  assert.equal(calculateAge('bad-date', null, fixedNow), null);
});

test('parseMarkdownBio strips markdown links and parses bold/italic while preserving identifiers', () => {
  const parsed = parseMarkdownBio(
    'See [Bio](https://example.com) by **Alice**, __Bob__, *Charlie*, _Dana_ (foo_bar_baz).',
  );
  const summary = parsed.map((seg) => seg.type + ':' + seg.text);
  assert.deepEqual(summary, [
    'text:See Bio by ',
    'bold:Alice',
    'text:, ',
    'bold:Bob',
    'text:, ',
    'italic:Charlie',
    'text:, ',
    'italic:Dana',
    'text: (foo_bar_baz).',
  ]);
});

test('buildRichPersonDetails deduplicates credits, matches local library items, and builds knownFor + tabs', () => {
  const tmdb = {
    id: 123,
    name: 'Test Actor',
    biography: '**Known** for roles.',
    birthday: '1980-03-10',
    place_of_birth: 'London, UK',
    known_for_department: 'Acting',
    profile_path: '/actor.jpg',
    external_ids: { imdb_id: 'nm0000123' },
    combined_credits: {
      cast: [
        {
          id: 10,
          title: 'Alpha Movie',
          media_type: 'movie',
          release_date: '2022-05-01',
          character: 'Hero',
          poster_path: '/alpha.jpg',
          backdrop_path: '/alpha_bg.jpg',
          vote_average: 8.2,
          vote_count: 1000,
          popularity: 50,
        },
        {
          id: 10,
          title: 'Alpha Movie',
          media_type: 'movie',
          release_date: '2022-05-01',
          character: 'Cameo',
          poster_path: '/alpha.jpg',
          backdrop_path: '/alpha_bg.jpg',
          vote_average: 8.2,
          vote_count: 1000,
          popularity: 10,
        },
        {
          id: 20,
          name: 'Beta Series',
          media_type: 'tv',
          first_air_date: '2024-01-12',
          character: 'Lead',
          poster_path: '/beta.jpg',
          vote_average: 7.5,
          vote_count: 200,
          popularity: 20,
        },
      ],
      crew: [
        {
          id: 10,
          title: 'Alpha Movie',
          media_type: 'movie',
          release_date: '2022-05-01',
          department: 'Directing',
          job: 'Director',
          poster_path: '/alpha.jpg',
          vote_average: 8.2,
          vote_count: 1000,
          popularity: 40,
        },
        {
          id: 30,
          title: 'Gamma Script',
          media_type: 'movie',
          release_date: '2020-09-01',
          department: 'Writing',
          job: 'Writer',
          poster_path: '/gamma.jpg',
          vote_average: 6.0,
          vote_count: 10,
          popularity: 5,
        },
      ],
    },
  };

  const localFilmography = [
    { Id: 'jf-alpha', Name: 'Alpha Movie', Type: 'Movie', ProductionYear: 2022, ProviderIds: { Tmdb: '10' } },
    { Id: 'jf-beta', Name: 'Beta Series', Type: 'Series', ProductionYear: 2024 },
  ];

  const details = buildRichPersonDetails('p-1', { Name: 'Fallback Name' }, tmdb, localFilmography, {
    all: 'All',
    acting: 'Acting',
    directing: 'Directing',
    writing: 'Writing',
    production: 'Production',
    other: 'Other',
  }, new Date('2026-06-15T12:00:00Z'));

  assert.equal(details.name, 'Test Actor');
  assert.equal(details.age, 46);
  assert.equal(details.imdbId, 'nm0000123');
  assert.equal(details.tmdbId, 123);
  assert.equal(details.backdropUrl, 'https://image.tmdb.org/t/p/w1280/alpha_bg.jpg');
  // Unique tmdbIds: 10, 20, 30
  assert.equal(details.totalCreditsCount, 3);
  assert.equal(details.knownFor.length, 3);
  assert.equal(details.knownFor[0].title, 'Alpha Movie');
  assert.equal(details.knownFor[0].localItem.Id, 'jf-alpha');
  assert.equal(details.knownFor[1].localItem.Id, 'jf-beta');

  // All credits has 4 unique (tmdbId, department) pairs: 10:Acting (Hero), 10:Directing, 20:Acting, 30:Writing
  assert.equal(details.allCredits.length, 4);
  assert.deepEqual(
    details.departmentTabs.map((t) => [t.key, t.count]),
    [['All', 3], ['Acting', 2], ['Directing', 1], ['Writing', 1]],
  );

  // Filtering 'All' deduplicates tmdbId 10 preferring Acting over Directing
  const allFiltered = filterCreditsForDepartment('All', details.allCredits);
  assert.equal(allFiltered.length, 3);
  const alphaInAll = allFiltered.find((c) => c.tmdbId === 10);
  assert.equal(alphaInAll.department, 'Acting');
  assert.equal(alphaInAll.role, 'Hero');

  // Filtering 'Directing' keeps Director credit for Alpha Movie
  const directingFiltered = filterCreditsForDepartment('Directing', details.allCredits);
  assert.equal(directingFiltered.length, 1);
  assert.equal(directingFiltered[0].role, 'Director');
});

test('buildFallbackPersonDetails filters out non-Movie/Series and keeps basic metadata', () => {
  const details = buildFallbackPersonDetails(
    'p-2',
    { Name: 'Local Person', Overview: 'Some bio', ProviderIds: { Imdb: 'nm999', Tmdb: '456' } },
    [
      { Id: 'm1', Name: 'Film 1', Type: 'Movie', ProductionYear: 2021 },
      { Id: 'e1', Name: 'Episode 1', Type: 'Episode', ProductionYear: 2021 },
    ],
  );
  assert.equal(details.totalCreditsCount, 1);
  assert.equal(details.allCredits[0].id, 'm1');
  assert.equal(details.imdbId, 'nm999');
  assert.equal(details.tmdbId, 456);
});

test('formatCreditSubtitle formats acting vs crew roles properly', () => {
  assert.equal(formatCreditSubtitle({ department: 'Acting', role: 'Dexter', year: 2025 }), '2025 (as Dexter)');
  assert.equal(formatCreditSubtitle({ department: 'Directing', role: 'Director', year: 2023 }), '2023 (Director)');
  assert.equal(formatCreditSubtitle({ department: 'Acting', year: 2020 }), '2020');
  assert.equal(formatCreditSubtitle({ department: 'Acting', role: 'Cameo' }), 'Cameo');
});

test('resolveCreditTarget resolves local item, Gelato matches by TMDB/title, and avoids wrong search fallback', async () => {
  const localRes = await resolveCreditTarget({ localItem: { Id: 'local-1' }, title: 'Any' }, {});
  assert.deepEqual(localRes, { hash: '#/item?id=local-1', item: { Id: 'local-1' } });

  const gelatoTmdb = await resolveCreditTarget(
    { title: 'Sample Title', mediaType: 'Movie', tmdbId: 777, year: 2021 },
    {
      searchMovies: async () => [
        { Id: 'wrong', Name: 'Sample Title Extended', ProductionYear: 2010, ProviderIds: { Tmdb: '111' } },
        { Id: 'right', Name: 'Other Localization', ProductionYear: 2021, ProviderIds: { Tmdb: '777' } },
      ],
    },
  );
  assert.equal(gelatoTmdb.hash, '#/item?id=right');

  const noPartialFallback = await resolveCreditTarget(
    { title: 'Unique Movie', mediaType: 'Series', tmdbId: 888, year: 2024 },
    {
      searchSeries: async () => [
        { Id: 'partial-hit', Name: 'Totally Different Show', ProductionYear: 2024, ProviderIds: { Tmdb: '999' } },
      ],
    },
  );
  assert.deepEqual(noPartialFallback, { hash: '#/search?q=Unique%20Movie', item: null });
});
