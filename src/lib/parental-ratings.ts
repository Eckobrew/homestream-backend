import { fetch } from '@/upstream';
import { getServerConfig } from './config';
import { JellyfinClient } from './jellyfin';
import { KIDS_LIMITS, KidsRating } from './parental-store';

export function ratingAge(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const rating = raw.trim().toUpperCase().replace(/^(GB|UK|US)[-:/ ]/, '').replace(/\s+/g, '');
  const ages: Record<string, number> = { U: 0, G: 0, 'TV-Y': 0, TVY: 0, 'TV-G': 0, TVG: 0,
    'TV-Y7': 7, 'TV-Y7-FV': 7, TVY7: 7, PG: 8, 'TV-PG': 10, TVPG: 10,
    '12': 12, '12A': 12, 'PG-13': 13, PG13: 13, 'TV-14': 14, TV14: 14,
    '15': 15, '16': 16, R: 17, '18': 18, 'NC-17': 18, 'TV-MA': 18, TVMA: 18 };
  return Object.hasOwn(ages, rating) ? ages[rating] : null;
}
export const ratingAllowed = (rating: unknown, ceiling: KidsRating) => {
  const age = ratingAge(rating); return age !== null && age <= KIDS_LIMITS[ceiling];
};
const certificates = new Map<string, { rating: string | null; saved: number }>();
const pending = new Map<string, Promise<string | null>>();
function keep(key: string, rating: string | null) {
  certificates.delete(key); certificates.set(key, { rating, saved: Date.now() });
  while (certificates.size > 1000) certificates.delete(certificates.keys().next().value!);
  return rating;
}

/** Fetch actual certifications; discovery's old placeholder PG-13/TV-MA values are never trusted. */
export async function catalogCertification(id: number, type: 'movie' | 'tv'): Promise<string | null> {
  const key = `${type}:${id}`;
  const found = certificates.get(key);
  if (found && Date.now() - found.saved < (found.rating ? 86400000 : 300000)) return found.rating;
  if (pending.has(key)) return pending.get(key)!;
  const task = (async () => {
    const config = getServerConfig();
    if (!config.seerrUrl || !config.seerrApiKey || !Number.isSafeInteger(id) || id <= 0) return null;
    try {
      const response = await fetch(`${config.seerrUrl}/api/v1/${type}/${id}`, {
        headers: { 'X-Api-Key': config.seerrApiKey }, signal: AbortSignal.timeout(5000), });
      if (!response.ok) return keep(key, null);
      const data = await response.json();
      if (data.adult === true) return keep(key, null);
      const records = type === 'movie' ? data.releaseDates?.results || data.releases?.results || [] : data.contentRatings?.results || [];
      for (const country of ['GB', 'US']) {
        const entries = records.filter((entry: Record<string, unknown>) => (entry.iso31661 || entry.iso_3166_1) === country);
        const values = entries.flatMap((entry: Record<string, unknown>) => type === 'movie'
          ? (entry.releaseDates || entry.release_dates || []) as { certification?: string }[]
          : [entry]);
        const ratings = values.map((value: { certification?: string; rating?: string }) => value.certification || value.rating || '').filter((value: string) => ratingAge(value) !== null);
        if (ratings.length) return keep(key, ratings.sort((a: string, b: string) => ratingAge(b)! - ratingAge(a)!)[0]);
      }
      return keep(key, null);
    } catch { return keep(key, null); }
  })();
  pending.set(key, task);
  try { return await task; } finally { pending.delete(key); }
}
export async function jellyfinCertification(id: string): Promise<string | null> {
  const item = await new JellyfinClient().getRecommendationSeed(id);
  if (!item) return null;
  if (ratingAge(item.rating) !== null) return item.rating!;
  if (item.type === 'Episode' && item.seriesId) return (await new JellyfinClient().getRecommendationSeed(item.seriesId))?.rating || null;
  return null;
}
