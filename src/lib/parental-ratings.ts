import { fetch } from '@/upstream';
import { getServerConfig } from './config';
import { getNativeItemById } from './native-media';
import { resolveNativeFileByItemOrFileId } from './native-transcode';
import { KIDS_LIMITS, KidsRating } from './parental-store';

export function ratingAge(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const rating = raw.trim().toUpperCase().replace(/^(GB|UK|US)[-:/ ]/, '').replace(/\s+/g, '');
  const ages: Record<string, number> = {
    U: 0, G: 0, 'TV-Y': 0, TVY: 0, 'TV-G': 0, TVG: 0,
    'TV-Y7': 7, 'TV-Y7-FV': 7, TVY7: 7, PG: 8, 'TV-PG': 10, TVPG: 10,
    '12': 12, '12A': 12, 'PG-13': 13, PG13: 13, 'TV-14': 14, TV14: 14,
    '15': 15, '16': 16, R: 17, '18': 18, 'NC-17': 18, 'TV-MA': 18, TVMA: 18,
  };
  return Object.hasOwn(ages, rating) ? ages[rating] : null;
}

export const ratingAllowed = (rating: unknown, ceiling: KidsRating) => {
  const age = ratingAge(rating);
  return age !== null && age <= KIDS_LIMITS[ceiling];
};

const certificates = new Map<string, { rating: string | null; saved: number }>();
const pending = new Map<string, Promise<string | null>>();

function keep(key: string, rating: string | null) {
  certificates.delete(key);
  certificates.set(key, { rating, saved: Date.now() });
  while (certificates.size > 1000) certificates.delete(certificates.keys().next().value!);
  return rating;
}

/** Fetch actual certifications directly from TMDB. */
export async function catalogCertification(id: number, type: 'movie' | 'tv'): Promise<string | null> {
  const key = `${type}:${id}`;
  const found = certificates.get(key);
  if (found && Date.now() - found.saved < (found.rating ? 86400000 : 300000)) return found.rating;
  if (pending.has(key)) return pending.get(key)!;
  const task = (async () => {
    const config = getServerConfig();
    const apiKey = (config.tmdbApiKey || process.env.TMDB_API_KEY || '').trim();
    if (!apiKey || !Number.isSafeInteger(id) || id <= 0) return null;
    try {
      const append = type === 'movie' ? 'release_dates' : 'content_ratings';
      const url = new URL(`https://api.themoviedb.org/3/${type}/${id}`);
      url.searchParams.set('api_key', apiKey);
      url.searchParams.set('append_to_response', append);
      const response = await fetch(url.toString(), { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return keep(key, null);
      const data = await response.json();
      if (data.adult === true) return keep(key, null);
      const records = type === 'movie'
        ? data.release_dates?.results || data.releases?.results || []
        : data.content_ratings?.results || [];
      for (const country of ['GB', 'US']) {
        const entries = records.filter((entry: Record<string, unknown>) => (entry.iso_3166_1 || entry.iso31661) === country);
        const values = entries.flatMap((entry: Record<string, unknown>) => type === 'movie'
          ? (entry.release_dates || entry.releaseDates || []) as { certification?: string }[]
          : [entry]);
        const ratings = values
          .map((value: { certification?: string; rating?: string }) => value.certification || value.rating || '')
          .filter((value: string) => ratingAge(value) !== null);
        if (ratings.length) return keep(key, ratings.sort((a: string, b: string) => ratingAge(b)! - ratingAge(a)!)[0]);
      }
      return keep(key, null);
    } catch {
      return keep(key, null);
    }
  })();
  pending.set(key, task);
  try {
    return await task;
  } finally {
    pending.delete(key);
  }
}

export function nativeCertification(id: string): string | null {
  const item = getNativeItemById(id);
  if (item) {
    if (ratingAge(item.rating) !== null) return item.rating!;
    if (item.type === 'Episode' && item.seriesId) {
      const parent = getNativeItemById(item.seriesId);
      if (parent && ratingAge(parent.rating) !== null) return parent.rating!;
    }
  }
  const file = resolveNativeFileByItemOrFileId(id);
  if (file?.item_id) {
    const owner = getNativeItemById(file.item_id);
    if (owner && ratingAge(owner.rating) !== null) return owner.rating!;
  }
  return null;
}
