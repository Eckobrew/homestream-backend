import { withParentalControls } from '@/lib/parental-controls';
import { withJellyfinSession } from '@/lib/jellyfin-session';
import { HttpRequest, HttpResponse } from '@/http';
import { SeerrClient } from '@/lib/seerr';
import { TmdbClient } from '@/lib/tmdb';
import { JellyfinClient } from '@/lib/jellyfin';
import { MediaItem } from '@/types';
import { resolveJellyfinUserId } from '@/lib/profiles';


const normalize = (text: string) => text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function handleGET(request: HttpRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const query = request.nextUrl.searchParams;
  let type: 'movie' | 'tv' = /^(tv|Series|Episode)$/.test(query.get('type') || '') || id.startsWith('seerr-tv-') || id.startsWith('tmdb-tv-') ? 'tv' : 'movie';
  let tmdb = Number(query.get('tmdbId')) || Number(/^(?:seerr|tmdb)-(?:movie-|tv-)?(\d+)$/.exec(id)?.[1]) || (/^\d+$/.test(id) ? Number(id) : 0);
  if (!Number.isSafeInteger(tmdb) || tmdb < 0) return HttpResponse.json({ error: 'Invalid TMDB ID' }, { status: 400 });
  const seerr = new SeerrClient();
  const tmdbClient = new TmdbClient();
  const userId = await resolveJellyfinUserId(query.get('userId') || request.cookies.get('homeflix_profile_id')?.value);
  const jellyfin = new JellyfinClient(undefined, undefined, userId);
  let seed: MediaItem | null = null;
  let sourceId = id;
  if (!id.startsWith('seerr-') && !id.startsWith('tmdb-') && !/^\d+$/.test(id) && jellyfin.isConfigured()) {
    seed = await jellyfin.getRecommendationSeed(id);
    // Episode TMDB IDs belong to episodes; TV recommendations require the series ID.
    if (seed?.type === 'Episode' && seed.seriesId) {
      sourceId = seed.seriesId;
      seed = await jellyfin.getRecommendationSeed(sourceId);
      tmdb = seed?.tmdbId || 0;
    }
    if (seed) {
      type = seed.type === 'Movie' ? 'movie' : 'tv';
      tmdb = seed.tmdbId || tmdb;
    }
  }
  const hasDiscovery = tmdbClient.isConfigured() || seerr.isConfigured();
  if (!tmdb && seed && hasDiscovery) {
    const matches = tmdbClient.isConfigured() ? await tmdbClient.search(seed.title) : await seerr.search(seed.title);
    const match = matches.find(candidate => candidate.type === (type === 'tv' ? 'Series' : 'Movie') &&
      [seed!.title, seed!.originalTitle || ''].some(title => title && normalize(title) === normalize(candidate.title)) &&
      (!seed!.year || !candidate.year || Math.abs(seed!.year - candidate.year) <= 1));
    tmdb = match?.tmdbId || 0;
  }

  let recommendations: MediaItem[] = [];
  let source = 'discovery';
  if (tmdb) {
    if (tmdbClient.isConfigured()) {
      recommendations = await tmdbClient.getRecommendations(tmdb, type);
    } else if (seerr.isConfigured()) {
      recommendations = await seerr.getRecommendations(tmdb, type);
    }
  }
  if (recommendations.length) {
    // Preserve the discovery service's relevance ranking. Library membership only
    // changes availability; it never earns an unrelated title a recommendation slot.
    const available = await jellyfin.matchLibraryTmdbIds(recommendations.map(item => item.tmdbId || 0).filter(Boolean), type);
    recommendations = recommendations.map(item => {
      const local = available.get(item.tmdbId || 0);
      return local ? { ...item, jellyfinId: local, status: 'available' as const } : item;
    });
  } else if (seed && jellyfin.isConfigured()) {
    source = 'library-fallback';
    const genres = new Set(seed.genres.map(normalize));
    const actors = new Set((seed.cast || []).map(person => normalize(person.name)));
    const similar = await jellyfin.getSimilarItems(sourceId, 24);
    recommendations = similar.filter(item => {
      if (item.type !== (type === 'tv' ? 'Series' : 'Movie')) return false;
      const overlap = item.genres.filter(genre => genres.has(normalize(genre))).length;
      const sharedCast = (item.cast || []).filter(person => actors.has(normalize(person.name))).length;
      const director = Boolean(seed!.director && item.director && normalize(seed!.director) === normalize(item.director));
      // A lone broad genre such as Drama is not enough to pad a recommendation row.
      return overlap >= 2 || director || sharedCast >= 2;
    });
  }
  const seen = new Set<string>();
  recommendations = recommendations.filter(item => {
    if (item.id === id || item.id === sourceId || (tmdb > 0 && item.tmdbId === tmdb)) return false;
    if (seed && normalize(item.title) === normalize(seed.title) && (!seed.year || !item.year || seed.year === item.year)) return false;
    const key = item.tmdbId ? `${item.type}:${item.tmdbId}` : `${item.type}:${normalize(item.title)}:${item.year || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 24);
  return HttpResponse.json({ success: true, source, recommendations }, { headers: { 'Cache-Control': 'no-store' } });
}
export const GET = withJellyfinSession(withParentalControls(handleGET));
