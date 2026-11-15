import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesMovieRelease, matchesSeriesRelease } from '../src/lib/release-match';

test('matchesMovieRelease rejects fuzzy/different titles like Heart of the Beast for The Beast', () => {
  assert.equal(
    matchesMovieRelease(
      { title: 'Heart.Of.The.Beast.2026.1080p.WEBRip.x264.AAC5.1-[YTS.GG]' },
      'The Beast',
      123456,
      2026,
    ),
    false,
  );

  assert.equal(
    matchesMovieRelease(
      { title: 'The.Beast.2026.1080p.WEB-DL.DDP5.1.H.264' },
      'The Beast',
      123456,
      2026,
    ),
    true,
  );
});

test('matchesMovieRelease rejects mismatched tmdbId or wrong year', () => {
  assert.equal(
    matchesMovieRelease(
      { title: 'The.Beast.2026.1080p.WEB-DL', tmdbId: 999999 },
      'The Beast',
      123456,
      2026,
    ),
    false,
  );

  assert.equal(
    matchesMovieRelease(
      { title: 'The.Beast.2020.1080p.WEB-DL' },
      'The Beast',
      123456,
      2026,
    ),
    false,
  );
});

test('matchesSeriesRelease matches exact series title and episode/season', () => {
  assert.equal(
    matchesSeriesRelease(
      { title: 'Severance.S02E03.1080p.WEB-DL', seasonNumber: 2, episodeNumbers: [3] },
      'Severance',
      undefined,
      2,
      3,
    ),
    true,
  );

  assert.equal(
    matchesSeriesRelease(
      { title: 'Dark.Severance.S02E03.1080p.WEB-DL', seasonNumber: 2, episodeNumbers: [3] },
      'Severance',
      undefined,
      2,
      3,
    ),
    false,
  );
});
