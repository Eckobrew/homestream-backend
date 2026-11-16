import { stateDatabase } from '@/state/database';
import { getServerConfig } from './config';
import { JellyfinClient, type JellyfinItem } from './jellyfin';
import { ensureNativeMediaTables } from './native-media';
import { getHomeflixProfiles } from './profiles';

type CatalogItem = { id: string; title: string; year: number | null; tmdb_id: number | null };
type Episode = { id: string; series_id: string; season_number: number; episode_number: number; tmdb_id: number | null };

const normalizeTitle = (value: string) => value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
const tmdbId = (item: JellyfinItem) => Number(item.ProviderIds?.Tmdb || item.ProviderIds?.tmdb || item.ProviderIds?.TheMovieDb) || 0;

function matchItem(item: JellyfinItem, catalog: CatalogItem[]): CatalogItem | undefined {
  const providerId = tmdbId(item);
  const providerMatches = providerId ? catalog.filter(candidate => candidate.tmdb_id === providerId) : [];
  if (providerMatches.length) return providerMatches.length === 1 ? providerMatches[0] : undefined;
  const matches = catalog.filter(candidate => {
    if (providerId && candidate.tmdb_id) return false;
    return Boolean(item.ProductionYear && candidate.year === item.ProductionYear && normalizeTitle(candidate.title) === normalizeTitle(item.Name));
  });
  return matches.length === 1 ? matches[0] : undefined;
}

export async function importJellyfinWatchHistory() {
  const config = getServerConfig();
  if (!config.jellyfinUrl || !config.jellyfinApiKey) throw new Error('Configure Jellyfin before importing watch history');
  ensureNativeMediaTables();
  const db = stateDatabase();
  const movies = db.prepare("SELECT id, title, year, tmdb_id FROM native_media_items WHERE type = 'Movie'").all() as CatalogItem[];
  const series = db.prepare("SELECT id, title, year, tmdb_id FROM native_media_items WHERE type = 'Series'").all() as CatalogItem[];
  const episodes = db.prepare('SELECT id, series_id, season_number, episode_number, tmdb_id FROM native_media_episodes').all() as Episode[];
  if (movies.length + episodes.length === 0) throw new Error('Scan the native libraries before importing watch history');
  const profiles = (await getHomeflixProfiles()).filter(profile => profile.jellyfinUserId && !profile.jellyfinUserId.startsWith('hf-'));
  if (profiles.length === 0) throw new Error('Link a HomeStream profile to a Jellyfin user before importing watch history');
  const client = new JellyfinClient(config.jellyfinUrl, config.jellyfinApiKey);
  const store = db.prepare(`
    INSERT OR IGNORE INTO native_watch_history
      (profile_id, item_id, series_id, position_ticks, duration_ticks, played, watch_seconds, play_count, last_played_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
  `);
  const stats = { imported: 0, unmatched: 0, alreadyPresent: 0 };
  for (const profile of profiles) {
    const userId = profile.jellyfinUserId!;
    const items: JellyfinItem[] = [];
    let previousPageId: string | undefined;
    for (let offset = 0; ; offset += 200) {
      const page = await client.getWatchHistoryPage(userId, offset);
      if (page.length && page[0].Id === previousPageId) throw new Error('Jellyfin returned a repeated watch history page');
      items.push(...page);
      if (page.length < 200) break;
      previousPageId = page[0].Id;
    }
    const seriesById = new Map(items.filter(item => item.Type === 'Series').map(item => [item.Id, matchItem(item, series)]));
    for (const item of items) {
      const played = item.UserData?.Played === true;
      const position = item.UserData?.PlaybackPositionTicks ?? 0;
      if ((!played && position <= 0) || (item.Type !== 'Movie' && item.Type !== 'Episode')) continue;
      const seriesId = item.SeriesId ? seriesById.get(item.SeriesId)?.id : undefined;
      const providerId = tmdbId(item);
      const matchingEpisodes = item.Type === 'Episode' ? episodes.filter(episode =>
        (Boolean(providerId) && episode.tmdb_id === providerId) ||
        (episode.series_id === seriesId && episode.season_number === item.ParentIndexNumber && episode.episode_number === item.IndexNumber)
      ) : [];
      const match = item.Type === 'Movie' ? matchItem(item, movies) : matchingEpisodes.length === 1 ? matchingEpisodes[0] : undefined;
      if (!match) {
        stats.unmatched++;
        continue;
      }
      const lastPlayed = item.UserData?.LastPlayedDate;
      const date = lastPlayed && Number.isFinite(Date.parse(lastPlayed)) ? new Date(lastPlayed).toISOString() : new Date().toISOString();
      const result = store.run(
        userId, match.id, 'series_id' in match ? match.series_id : null,
        played || !Number.isSafeInteger(position) ? 0 : position,
        Number.isSafeInteger(item.RunTimeTicks) ? item.RunTimeTicks! : 0,
        played ? 1 : 0, Number.isSafeInteger(item.UserData?.PlayCount) ? item.UserData!.PlayCount! : Number(played), date,
      );
      if (result.changes) stats.imported++;
      else stats.alreadyPresent++;
    }
  }
  return stats;
}
