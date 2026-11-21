import { withParentalControls } from '@/lib/parental-controls';
import { HttpRequest, HttpResponse } from '@/http';
import { TmdbClient } from '@/lib/tmdb';
import { MediaItem } from '@/types';
import { getNativeItemById, getNativeSimilarItems, getNativeTmdbIdMap } from '@/lib/native-media';

const normalize = (text: string) =>
  text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function handleGET(request: HttpRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const query = request.nextUrl.searchParams;
  let type: 'movie' | 'tv' =
    /^(tv|Series|Episode)$/.test(query.get('type') || '') || id.startsWith('tmdb-tv-')
      ? 'tv'
      : 'movie';
  let tmdb =
    Number(query.get('tmdbId')) ||
    Number(/^tmdb-(?:movie-|tv-)?(\d+)$/.exec(id)?.[1]) ||
    (/^\d+$/.test(id) ? Number(id) : 0);
  if (!Number.isSafeInteger(tmdb) || tmdb < 0) {
    return HttpResponse.json({ error: 'Invalid TMDB ID' }, { status: 400 });
  }

  const tmdbClient = new TmdbClient();
  let seed: MediaItem | null = null;
  let sourceId = id;

  if (id.startsWith('nat-')) {
    seed = getNativeItemById(id);
    if (seed?.type === 'Episode' && seed.seriesId) {
      sourceId = seed.seriesId;
      seed = getNativeItemById(sourceId);
    }
    if (seed) {
      type = seed.type === 'Movie' ? 'movie' : 'tv';
      tmdb = seed.tmdbId || tmdb;
    }
    if (!tmdb && !tmdbClient.isConfigured()) {
      return HttpResponse.json({ success: true, source: 'native', recommendations: getNativeSimilarItems(sourceId) });
    }
  }

  if (!tmdb && seed && tmdbClient.isConfigured()) {
    const matches = await tmdbClient.search(seed.title);
    const match = matches.find(
      candidate =>
        candidate.type === (type === 'tv' ? 'Series' : 'Movie') &&
        [seed!.title, seed!.originalTitle || ''].some(title => title && normalize(title) === normalize(candidate.title)) &&
        (!seed!.year || !candidate.year || Math.abs(seed!.year - candidate.year) <= 1)
    );
    tmdb = match?.tmdbId || 0;
  }

  let recommendations: MediaItem[] = [];
  let source = 'discovery';
  if (tmdb && tmdbClient.isConfigured()) {
    recommendations = await tmdbClient.getRecommendations(tmdb, type);
  }
  if (recommendations.length) {
    const available = getNativeTmdbIdMap();
    recommendations = recommendations.map(item => {
      const local = available.get(item.tmdbId || 0);
      return local ? { ...item, id: local, nativeId: local, status: 'available' as const } : item;
    });
  } else if (seed && sourceId.startsWith('nat-')) {
    source = 'native';
    recommendations = getNativeSimilarItems(sourceId);
  }

  const seen = new Set<string>();
  recommendations = recommendations
    .filter(item => {
      if (item.id === id || item.id === sourceId || (tmdb > 0 && item.tmdbId === tmdb)) return false;
      if (seed && normalize(item.title) === normalize(seed.title) && (!seed.year || !item.year || seed.year === item.year)) return false;
      const key = item.tmdbId ? `${item.type}:${item.tmdbId}` : `${item.type}:${normalize(item.title)}:${item.year || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 24);

  return HttpResponse.json({ success: true, source, recommendations }, { headers: { 'Cache-Control': 'no-store' } });
}

export const GET = withParentalControls(handleGET);
