import { createHash } from 'node:crypto';

export interface ArrRelease {
  guid: string;
  title: string;
  size: number;
  seeders?: number;
  rejected?: boolean;
  approved?: boolean;
  rejections?: string[];
  customFormatScore?: number;
  quality?: { quality?: { id?: number; name?: string; resolution?: number } };
}
interface QualityItem {
  id?: number;
  allowed: boolean;
  quality?: { id: number; name: string };
  items?: QualityItem[];
}
interface QualityDefinition {
  quality: { id: number; name: string };
  minSize?: number;
  preferredSize?: number;
  maxSize?: number;
}
export interface ArrReleasePolicy {
  qualities: Map<string, { rank: number; min?: number; preferred?: number; max?: number }>;
  minimumFormatScore: number;
}
const policies = new Map<string, { expires: number; promise: Promise<ArrReleasePolicy | undefined> }>();

/** Optional ranking metadata; release approval flags remain authoritative on lookup failure. */
export async function loadArrReleasePolicy(baseUrl: string, apiKey: string, profileId?: number): Promise<ArrReleasePolicy | undefined> {
  if (!profileId) return undefined;
  const cacheKey = createHash('sha256').update(`${baseUrl}|${apiKey}|${profileId}`).digest('hex');
  const cached = policies.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.promise;
  const promise = (async () => {
    try {
      const responses = await Promise.all([`qualityprofile/${profileId}`, 'qualitydefinition'].map(path =>
        fetch(`${baseUrl}/api/v3/${path}`, { headers: { 'X-Api-Key': apiKey, Accept: 'application/json' }, signal: AbortSignal.timeout(5000) })));
      if (responses.some(response => !response.ok)) return undefined;
      const [profile, definitions] = await Promise.all(responses.map(response => response.json())) as [
        { items: QualityItem[]; minFormatScore?: number }, QualityDefinition[],
      ];
      if (!Array.isArray(profile.items) || !Array.isArray(definitions)) return undefined;
      const qualities: ArrReleasePolicy['qualities'] = new Map();
      const add = (item: QualityItem, rank: number, allowed: boolean) => {
        if (!allowed || !item.allowed) return;
        if (item.quality) {
          const definition = definitions.find(value => value.quality.id === item.quality!.id);
          const value = { rank, min: definition?.minSize, preferred: definition?.preferredSize, max: definition?.maxSize };
          qualities.set(`id:${item.quality.id}`, value);
          qualities.set(`name:${item.quality.name.toLowerCase()}`, value);
        }
        for (const child of item.items || []) add(child, rank, true);
      };
      profile.items.forEach((item, rank) => add(item, rank, true));
      return { qualities, minimumFormatScore: profile.minFormatScore || 0 };
    } catch { return undefined; }
  })();
  policies.set(cacheKey, { expires: Date.now() + 60000, promise });
  for (const [key, entry] of policies) if (entry.expires <= Date.now() || policies.size > 50) policies.delete(key);
  const result = await promise;
  if (!result && policies.get(cacheKey)?.promise === promise) policies.delete(cacheKey);
  return result;
}

export function isArrReleaseApproved(release: ArrRelease): boolean {
  return release.rejected !== true && release.approved !== false &&
    !(release.rejections || []).some(reason => reason.trim().length > 0);
}

/** Sizes are compared per covered minute, so a season pack is not treated as one episode. */
export function rankArrReleases<T extends ArrRelease>(releases: T[], policy?: ArrReleasePolicy,
  runtimeMinutes?: number, coveredEpisodes: (release: T) => number | undefined = () => 1): T[] {
  const quality = (release: T) => {
    const q = release.quality?.quality;
    return policy?.qualities.get(`id:${q?.id}`) || policy?.qualities.get(`name:${q?.name?.toLowerCase()}`);
  };
  const rate = (release: T): number | undefined => {
    const episodes = coveredEpisodes(release);
    return runtimeMinutes && runtimeMinutes > 0 && episodes && episodes > 0
      ? release.size / 1048576 / (runtimeMinutes * episodes) : undefined;
  };
  const distance = (release: T) => {
    const preferred = quality(release)?.preferred;
    const size = rate(release);
    if (preferred != null && Number.isFinite(preferred) && size !== undefined) return Math.abs(size - preferred);
    const episodes = coveredEpisodes(release);
    return episodes ? release.size / episodes / 1048576 : Infinity;
  };
  return releases.filter(release => {
    if (!isArrReleaseApproved(release) || !Number.isFinite(release.size) || release.size <= 0) return false;
    if (!policy) return true;
    const limits = quality(release);
    if (!limits || (release.customFormatScore || 0) < policy.minimumFormatScore) return false;
    const size = rate(release);
    return size === undefined || ((limits.min == null || size >= limits.min) && (limits.max == null || size <= limits.max));
  }).sort((a, b) => {
    const rank = (release: T) => quality(release)?.rank ?? release.quality?.quality?.resolution ?? 0;
    const qualityDiff = rank(b) - rank(a);
    if (qualityDiff) return qualityDiff;
    const scoreDiff = (b.customFormatScore || 0) - (a.customFormatScore || 0);
    if (scoreDiff) return scoreDiff;
    const aDistance = distance(a), bDistance = distance(b);
    if (aDistance !== bDistance) return aDistance < bDistance ? -1 : 1;
    const seeders = (b.seeders || 0) - (a.seeders || 0);
    if (seeders) return seeders;
    const aCount = coveredEpisodes(a), bCount = coveredEpisodes(b);
    const aSize = aCount ? a.size / aCount : Infinity, bSize = bCount ? b.size / bCount : Infinity;
    if (aSize !== bSize) return aSize < bSize ? -1 : 1;
    return a.guid.localeCompare(b.guid);
  });
}
