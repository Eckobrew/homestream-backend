export function normalizeReleaseTitle(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Extracts the leading media title from a torrent release name by stopping at
 * season/episode markers, 4-digit release years, or common scene quality tags.
 */
export function extractReleaseTitlePrefix(releaseTitle: string): string {
  const cleaned = releaseTitle.replace(/[._]/g, ' ').trim();
  const stopMatch = cleaned.match(
    /\b(?:s\d{1,2}(?:e\d{1,3})?|season\s*\d+|(?:19|20)\d{2}|2160p|1080p|720p|480p|4k|uhd|webrip|web[-\s]?dl|bluray|bdrip|brrip|hdrip|remux|hdtv|dvdrip|x264|x265|hevc|h\.?264|h\.?265)\b/i
  );
  const prefix = stopMatch && stopMatch.index !== undefined && stopMatch.index > 0
    ? cleaned.slice(0, stopMatch.index)
    : cleaned;
  return normalizeReleaseTitle(prefix);
}

export function extractReleaseYear(releaseTitle: string): number | null {
  const matches = releaseTitle.match(/\b(19\d{2}|20\d{2})\b/g);
  if (!matches || matches.length === 0) return null;
  // Prefer the first year token (usually immediately follows the title)
  const year = Number(matches[0]);
  return Number.isFinite(year) ? year : null;
}

export function matchesMovieRelease(
  release: { title: string; tmdbId?: number; movieTitles?: string[]; rejections?: string[] },
  expectedTitle: string,
  expectedTmdbId: number,
  expectedYear?: number,
): boolean {
  if (typeof release.tmdbId === 'number' && release.tmdbId > 0 && release.tmdbId !== expectedTmdbId) {
    return false;
  }
  const normalizedExpected = normalizeReleaseTitle(expectedTitle);
  if (!normalizedExpected) return false;

  const prefix = extractReleaseTitlePrefix(release.title);
  const candidateTitles = new Set<string>([normalizedExpected]);
  if (Array.isArray(release.movieTitles)) {
    for (const t of release.movieTitles) {
      const n = normalizeReleaseTitle(t);
      if (n) candidateTitles.add(n);
    }
  }

  if (!prefix || !candidateTitles.has(prefix)) {
    return false;
  }

  if (expectedYear && expectedYear > 1900) {
    const releaseYear = extractReleaseYear(release.title);
    if (releaseYear !== null && Math.abs(releaseYear - expectedYear) > 1) {
      return false;
    }
  }

  return true;
}

export function matchesSeriesRelease(
  release: { title: string; tvdbId?: number; seriesTitle?: string; seasonNumber?: number; episodeNumbers?: number[]; fullSeason?: boolean },
  expectedTitle: string,
  expectedTvdbId?: number,
  expectedSeason?: number,
  expectedEpisode?: number,
): boolean {
  if (expectedTvdbId && typeof release.tvdbId === 'number' && release.tvdbId > 0 && release.tvdbId !== expectedTvdbId) {
    return false;
  }
  const normalizedExpected = normalizeReleaseTitle(expectedTitle);
  if (!normalizedExpected) return false;

  const prefix = extractReleaseTitlePrefix(release.title);
  const normalizedSeriesField = release.seriesTitle ? normalizeReleaseTitle(release.seriesTitle) : '';
  if (prefix !== normalizedExpected && normalizedSeriesField !== normalizedExpected) {
    return false;
  }

  if (expectedSeason !== undefined && typeof release.seasonNumber === 'number' && release.seasonNumber !== expectedSeason) {
    return false;
  }

  if (expectedEpisode !== undefined && !release.fullSeason && Array.isArray(release.episodeNumbers) && release.episodeNumbers.length > 0) {
    if (!release.episodeNumbers.includes(expectedEpisode)) {
      return false;
    }
  }

  return true;
}
