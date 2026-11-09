import { fetch, registerDependency } from '@/upstream';
import { log } from '@/log';
import { requestParentalProfile } from './parental-runtime';
import { backupPolicy, backedUpPolicy, KidsRating } from './parental-store';
import { TvVideoCapability } from './tv-playback-profile';
import { MediaItem, Season, Episode, SubtitleTrack, UserProfile } from '@/types';
import { getServerConfig } from './config';
import { requestJellyfinSession } from './jellyfin-session';

export interface JellyfinItem {
  Id: string;
  Name: string;
  OriginalTitle?: string;
  Overview?: string;
  Type: 'Movie' | 'Series' | 'Episode' | 'Season' | 'Folder' | string;
  ProductionYear?: number;
  PremiereDate?: string;
  OfficialRating?: string;
  CommunityRating?: number;
  RunTimeTicks?: number;
  Genres?: string[];
  Tags?: string[];
  Path?: string;
  ChildCount?: number; // Season count for Series
  UserData?: {
    PlaybackPositionTicks?: number;
    Played?: boolean;
    IsFavorite?: boolean;
  };
  People?: { Name: string; Role: string; Type: string }[];
  ImageTags?: {
    Primary?: string;
    Backdrop?: string;
    Thumb?: string;
  };
  BackdropImageTags?: string[];
  IndexNumber?: number; // Episode or Season number
  ParentIndexNumber?: number; // Season number for episode
  SeriesName?: string;
  SeriesId?: string;
  SeasonId?: string;
  LocationType?: string;
  Container?: string;
  ProviderIds?: {
    Tmdb?: string;
    Imdb?: string;
    [key: string]: string | undefined;
  };
  Width?: number;
  Height?: number;
  MediaStreams?: {
    Type?: string;
    Index?: number;
    Codec?: string;
    Language?: string;
    Title?: string;
    DisplayTitle?: string;
    IsDefault?: boolean;
    IsForced?: boolean;
    Width?: number;
    Height?: number;
    Channels?: number;
    ChannelLayout?: string;
    VideoRange?: string;
    VideoRangeType?: string;
    AudioSpatialFormat?: string;
  }[];
  MediaSources?: {
    Id?: string;
    Path?: string;
    MediaStreams?: {
      Type?: string;
      Width?: number;
      Height?: number;
      Channels?: number;
      ChannelLayout?: string;
      VideoRange?: string;
      VideoRangeType?: string;
      DisplayTitle?: string;
      AudioSpatialFormat?: string;
      IsDefault?: boolean;
      IsForced?: boolean;
    }[];
  }[];
}

export function isYouTubeItem(item: any): boolean {
  if (!item) return false;
  if (item.source === 'youtube') return true;
  const path = (item.Path || item.path || item.MediaSources?.[0]?.Path || '').toLowerCase();
  if (
    path.includes('/youtube/') ||
    path.includes('\\youtube\\') ||
    path.includes('/media/youtube/') ||
    path.includes('nas-youtube') ||
    path.includes('/mnt/youtube/')
  ) {
    return true;
  }
  if (item.ProviderIds?.youtube || item.ProviderIds?.YouTube) return true;
  if (item.providerIds?.youtube || item.providerIds?.YouTube) return true;
  const name = (item.Name || item.title || '').toLowerCase();
  if (name.startsWith('[youtube]')) return true;
  const genres = item.Genres || item.genres || [];
  if (Array.isArray(genres) && genres.some((g: any) => typeof g === 'string' && /people\s*&\s*blogs|youtube/i.test(g))) return true;
  const tags = item.Tags || item.tags || [];
  if (Array.isArray(tags) && tags.some((t: any) => typeof t === 'string' && /youtube/i.test(t))) return true;
  return false;
}

export class JellyfinClient {
  readonly url: string;
  private apiKey: string;
  private userId: string;
  private viewsCache: { moviesId?: string; tvshowsId?: string; youtubeId?: string; timestamp: number } = { timestamp: 0 };

  async getViewId(type: 'movies' | 'tvshows' | 'youtube'): Promise<string | undefined> {
    if (!this.isConfigured()) return undefined;
    const now = Date.now();
    if (this.viewsCache.timestamp && now - this.viewsCache.timestamp < 300000) {
      if (type === 'movies') return this.viewsCache.moviesId;
      if (type === 'tvshows') return this.viewsCache.tvshowsId;
      if (type === 'youtube') return this.viewsCache.youtubeId;
    }
    try {
      const uid = await this.getFirstUserId();
      const res = await this.fetch(`${this.url}/Users/${uid}/Views`, { headers: this.getHeaders() });
      if (res.ok) {
        const data = await res.json();
        const views = data.Items || [];
        const moviesMatch = views.find((v: any) => v.CollectionType === 'movies' && !/youtube/i.test(v.Name || '') && !/youtube/i.test(v.Path || '')) || views.find((v: any) => /movies/i.test(v.Name || '') && !/youtube/i.test(v.Name || ''));
        const tvMatch = views.find((v: any) => v.CollectionType === 'tvshows' || /shows|tv/i.test(v.Name || ''));
        const ytMatch = views.find((v: any) => /youtube/i.test(v.Name || '') || /youtube/i.test(v.Path || ''));
        this.viewsCache = {
          moviesId: moviesMatch?.Id,
          tvshowsId: tvMatch?.Id,
          youtubeId: ytMatch?.Id,
          timestamp: now
        };
        if (type === 'movies') return this.viewsCache.moviesId;
        if (type === 'tvshows') return this.viewsCache.tvshowsId;
        if (type === 'youtube') return this.viewsCache.youtubeId;
      }
    } catch (e) {
      log.warn('Failed to load Jellyfin views:', e);
    }
    return undefined;
  }

  constructor(url?: string, apiKey?: string, userId?: string) {
    const config = getServerConfig();
    this.url = (url || config.jellyfinUrl).replace(/\/+$/, '');
    const session = !url && !apiKey ? requestJellyfinSession() : null;
    registerDependency('jellyfin', this.url);
    this.apiKey = session?.accessToken || apiKey || config.jellyfinApiKey;
    this.userId = requestParentalProfile()?.jellyfinUserId || session?.id || userId || config.jellyfinUserId;
  }

  private fetch(input: string, options: RequestInit = {}) {
    return fetch(input, { ...options, redirect: 'error', signal: options.signal || AbortSignal.timeout(15000) });
  }

  isConfigured(): boolean {
    return Boolean(this.url && this.apiKey);
  }

  getHeaders(): Record<string, string> {
    return {
      'Accept': 'application/json',
      'X-Emby-Token': this.apiKey,
      'Authorization': `MediaBrowser Client="HomeFlix", Device="Web", DeviceId="homeflix-web", Version="1.0.0", Token="${this.apiKey}"`,
    };
  }

  async testConnection(): Promise<{ success: boolean; serverName?: string; version?: string; error?: string }> {
    if (!this.isConfigured()) {
      return { success: false, error: 'Jellyfin URL and API key are required' };
    }

    try {
      const res = await this.fetch(`${this.url}/System/Info/Public`, {
        headers: this.getHeaders(),
        });

      if (!res.ok) {
        return { success: false, error: `HTTP ${res.status}: ${res.statusText}` };
      }

      const data = await res.json();
      return {
        success: true,
        serverName: data.ServerName || 'Jellyfin Server',
        version: data.Version,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }

  async getFirstUserId(): Promise<string> {
    if (this.userId) return this.userId;
    try {
      const res = await this.fetch(`${this.url}/Users`, {
        headers: this.getHeaders(),
      });
      if (res.ok) {
        const users = await res.json();
        if (Array.isArray(users) && users.length > 0) {
          this.userId = users[0].Id;
          return users[0].Id;
        }
      }
    } catch (e) {
      log.error('Failed to get Jellyfin users', e);
    }
    return '';
  }

  getUserImageUrl(userId: string): string {
    if (!userId) return '';
    return `/api/mobile/v1/image?userId=${userId}&type=Primary`;
  }

  async findUserByName(name: string): Promise<{ id: string; name: string } | null> {
    if (!this.isConfigured() || !name) return null;
    try {
      const res = await this.fetch(`${this.url}/Users`, {
        headers: this.getHeaders(),
        cache: 'no-store',
      });
      if (!res.ok) return null;
      const users = await res.json();
      if (!Array.isArray(users)) return null;
      const target = users.find(
        (u: any) => (u.Name || '').trim().toLowerCase() === name.trim().toLowerCase()
      );
      if (target) {
        return { id: target.Id, name: target.Name };
      }
      return null;
    } catch (e) {
      log.error('Error finding Jellyfin user by name:', e);
      return null;
    }
  }

  async findItemByTmdbId(tmdbId: number, type?: 'movie' | 'tv'): Promise<string | null> {
    if (!this.isConfigured() || !tmdbId) return null;
    try {
      const uid = await this.getFirstUserId();
      const includeTypes = type === 'movie' ? 'Movie' : type === 'tv' ? 'Series' : 'Movie,Series';
      const res = await this.fetch(
        `${this.url}/Users/${uid}/Items?Recursive=true&IncludeItemTypes=${includeTypes}&Fields=ProviderIds`,
        { headers: this.getHeaders(), cache: 'no-store' }
      );
      if (res.ok) {
        const data = await res.json();
        const strId = String(tmdbId);
        const item = (data.Items || []).find((i: JellyfinItem) => i.ProviderIds?.Tmdb === strId);
        if (item) return item.Id;
      }
    } catch (e) {
      log.error(`Error finding Jellyfin item by TMDB ID ${tmdbId}:`, e);
    }
    return null;
  }

  async matchLibraryTmdbIds(ids: number[], type: 'movie' | 'tv'): Promise<Map<number, string>> {
    const matches = new Map<number, string>();
    if (!this.isConfigured() || !ids.length) return matches;
    const wanted = new Set(ids);
    try {
      const uid = await this.getFirstUserId();
      const response = await this.fetch(`${this.url}/Users/${encodeURIComponent(uid)}/Items?Recursive=true&IncludeItemTypes=${type === 'movie' ? 'Movie' : 'Series'}&Fields=ProviderIds,LocationType&EnableImages=false&EnableUserData=false`,
        { headers: this.getHeaders(), signal: AbortSignal.timeout(10000) });
      if (!response.ok) return matches;
      const data = await response.json();
      for (const item of data.Items || []) {
        const tmdb = Number(item.ProviderIds?.Tmdb || item.ProviderIds?.tmdb);
        if (wanted.has(tmdb) && item.Id && item.LocationType !== 'Virtual') matches.set(tmdb, item.Id);
      }
    } catch { log.warn('Could not match recommendation availability'); }
    return matches;
  }

  async findItemByName(name: string, type?: 'movie' | 'tv'): Promise<string | null> {
    if (!this.isConfigured() || !name) return null;
    try {
      const uid = await this.getFirstUserId();
      const includeTypes = type === 'movie' ? 'Movie' : type === 'tv' ? 'Series' : 'Movie,Series';
      const res = await this.fetch(
        `${this.url}/Users/${uid}/Items?SearchTerm=${encodeURIComponent(name)}&IncludeItemTypes=${includeTypes}&Fields=ProviderIds`,
        { headers: this.getHeaders(), cache: 'no-store' }
      );
      if (res.ok) {
        const data = await res.json();
        const cleanName = name.trim().toLowerCase();
        const item = (data.Items || []).find((i: JellyfinItem) => (i.Name || '').trim().toLowerCase() === cleanName)
          || (data.Items || [])[0];
        if (item) return item.Id;
      }
    } catch {}
    return null;
  }

  async createUser(name: string, password?: string): Promise<{ id: string; name: string } | null> {
    if (!this.isConfigured() || !name) return null;
    try {
      const res = await this.fetch(`${this.url}/Users/New`, {
        method: 'POST',
        headers: {
          ...this.getHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ Name: name.trim(), ...(password !== undefined ? { Password: password } : {}) }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        const text = await res.text();
        log.error(`Failed to create Jellyfin user (${res.status}):`, text);
        return null;
      }
      const data = await res.json();
      return { id: data.Id, name: data.Name };
    } catch (e) {
      log.error('Error creating Jellyfin user:', e);
      return null;
    }
  }

  async applyKidsPolicy(userId: string, rating: KidsRating | null): Promise<void> {
    const headers = { ...this.getHeaders(), 'Content-Type': 'application/json' };
    const userResponse = await this.fetch(`${this.url}/Users/${encodeURIComponent(userId)}`, { headers, cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!userResponse.ok) throw new Error('Cannot read the linked Jellyfin account policy');
    const user = await userResponse.json();
    if (rating && user.Policy?.IsAdministrator) throw new Error('Kids profiles must use a non-administrator Jellyfin account');
    let policy = backedUpPolicy(userId);
    if (rating) {
      if (!user.Policy) throw new Error('Jellyfin account policy unavailable');
      backupPolicy(userId, user.Policy);
      const ratings = await this.fetch(`${this.url}/Localization/ParentalRatings`, { headers, signal: AbortSignal.timeout(10000) });
      if (!ratings.ok) throw new Error('Jellyfin parental ratings unavailable');
      const choices = await ratings.json();
      const selected = choices.find((entry: { Name: string }) => entry.Name?.toUpperCase() === `GB-${rating}`) || choices.find((entry: { Name: string }) => entry.Name?.toUpperCase() === rating);
      if (!selected || !Number.isFinite(selected.Value)) throw new Error(`Jellyfin does not recognize the ${rating} rating limit`);
      policy = { ...user.Policy, MaxParentalRating: selected.Value,
        ...(Number.isFinite(selected.RatingScore?.SubScore) ? { MaxParentalSubRating: selected.RatingScore.SubScore } : {}),
        EnableContentDeletion: false, EnableContentDeletionFromFolders: [], EnablePublicSharing: false,
        EnableCollectionManagement: false, EnableSubtitleManagement: false, EnableLyricManagement: false,
        BlockUnratedItems: ['Movie', 'Series', 'Trailer', 'Other', 'Book', 'Music', 'ChannelContent', 'LiveTvChannel', 'LiveTvProgram'],
        EnableContentDownloading: false, EnableRemoteControlOfOtherUsers: false, EnableSharedDeviceControl: false,
        EnableLiveTvAccess: false, EnableLiveTvManagement: false, EnableUserPreferenceAccess: false };
    }
    if (!policy) return;
    const response = await this.fetch(`${this.url}/Users/${encodeURIComponent(userId)}/Policy`, { method: 'POST', headers, body: JSON.stringify(policy), signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Jellyfin refused the parental-control policy; profile was not saved');
    if (rating) {
      const verified = await this.fetch(`${this.url}/Users/${encodeURIComponent(userId)}`, { headers, cache: 'no-store', signal: AbortSignal.timeout(10000) });
      const applied = verified.ok ? (await verified.json()).Policy : null;
      if (!applied || applied.IsAdministrator || applied.MaxParentalRating !== policy.MaxParentalRating || !policy.BlockUnratedItems || !(policy.BlockUnratedItems as string[]).every(value => applied.BlockUnratedItems?.includes(value))) throw new Error('Jellyfin did not apply the parental-control policy');
    }
  }

  async deleteUser(userId: string): Promise<boolean> {
    if (!this.isConfigured() || !userId) return false;
    try {
      const res = await this.fetch(`${this.url}/Users/${userId}`, {
        method: 'DELETE',
        headers: this.getHeaders(),
      });
      return res.ok;
    } catch (e) {
      log.error('Error deleting Jellyfin user:', e);
      return false;
    }
  }

  async getUsers(): Promise<UserProfile[]> {
    if (!this.isConfigured()) {
      return [
        {
          id: 'mock-nathan',
          name: 'Nathan',
          avatarColor: 'from-red-600 to-red-800',
          avatarBg: 'bg-red-600',
          initials: 'NA',
          isAdministrator: true,
        },
        {
          id: 'mock-mirelle',
          name: 'Mirelle',
          avatarColor: 'from-purple-600 to-pink-600',
          avatarBg: 'bg-purple-600',
          initials: 'MI',
          isAdministrator: false,
        },
      ];
    }

    try {
      const res = await this.fetch(`${this.url}/Users`, {
        headers: this.getHeaders(),
        });

      if (!res.ok) {
        return [];
      }

      const rawUsers = await res.json();
      if (!Array.isArray(rawUsers)) return [];

      const palettes = [
        { avatarColor: 'from-red-600 to-red-800', avatarBg: 'bg-red-600' },
        { avatarColor: 'from-purple-600 to-pink-600', avatarBg: 'bg-purple-600' },
        { avatarColor: 'from-sky-500 to-blue-700', avatarBg: 'bg-blue-600' },
        { avatarColor: 'from-emerald-500 to-teal-700', avatarBg: 'bg-emerald-600' },
        { avatarColor: 'from-amber-500 to-orange-700', avatarBg: 'bg-amber-600' },
        { avatarColor: 'from-rose-500 to-red-700', avatarBg: 'bg-rose-600' },
        { avatarColor: 'from-indigo-500 to-purple-700', avatarBg: 'bg-indigo-600' },
      ];

      return rawUsers.map((u: any, idx: number) => {
        const lowerName = (u.Name || '').toLowerCase();
        let palette = palettes[idx % palettes.length];

        if (lowerName.includes('nathan')) {
          palette = palettes[0]; // Red
        } else if (lowerName.includes('mirelle')) {
          palette = palettes[1]; // Purple/Pink
        } else if (lowerName.includes('david')) {
          palette = palettes[2]; // Sky/Blue
        } else if (lowerName.includes('harry')) {
          palette = palettes[3]; // Emerald
        } else if (lowerName.includes('messy')) {
          palette = palettes[4]; // Amber
        }

        const initials = (u.Name || 'HF')
          .trim()
          .split(/\s+/)
          .map((n: string) => n[0])
          .join('')
          .slice(0, 2)
          .toUpperCase() || 'HF';

        return {
          id: u.Id,
          name: u.Name,
          avatarColor: palette.avatarColor,
          avatarBg: palette.avatarBg,
          initials,
          avatarUrl: u.PrimaryImageTag ? `/api/mobile/v1/image?userId=${u.Id}&type=Primary` : undefined,
          isAdministrator: Boolean(u.Policy?.IsAdministrator),
        };
      });
    } catch (e) {
      log.error('Error fetching Jellyfin users:', e);
      return [];
    }
  }

  getImageUrl(itemId: string, type: 'Primary' | 'Backdrop' | 'Thumb' = 'Primary', maxWidth = 800): string {
    if (!itemId) return '';
    return `/api/mobile/v1/image?itemId=${itemId}&type=${type}&maxWidth=${maxWidth}`;
  }

  getStreamUrl(itemId: string): string {
    if (!this.url || !itemId) return '';
    return `${this.url}/Videos/${itemId}/stream?static=true&api_key=${this.apiKey}`;
  }

  async getPlaybackStream(
    itemId: string,
    options?: {
      canPlayHevc?: boolean;
      receiver?: 'cast' | 'browser' | 'native-tv';
      tvCapabilities?: TvVideoCapability[];
      videoCodecs?: string[];
      maxWidth?: number;
      maxHeight?: number;
      audioCodecs?: string[];
      forceTranscode?: boolean;
      startTimeTicks?: number;
    }
  ): Promise<{
    streamUrl: string;
    isTranscoding: boolean;
    error?: string;
    playMethod?: string;
    sourceVideoCodec?: string;
    sourceAudioCodec?: string;
    transcodeReasons?: string;
    playSessionId?: string;
    mediaSourceId?: string;
    totalDurationTicks?: number;
    durationSeconds?: number;
    resumePositionTicks?: number;
  }> {
    if (!this.isConfigured() || !itemId) {
      return {
        streamUrl: '',
        isTranscoding: false,
      };
    }

    let targetItemId = itemId;
    const seerrMatch = itemId.match(/^seerr-(movie|tv)-(\d+)$/);
    if (seerrMatch) targetItemId = await this.findItemByTmdbId(Number(seerrMatch[2]), seerrMatch[1] === 'movie' ? 'movie' : 'tv') || itemId;
    const details = await this.getItemDetails(targetItemId);
    if (details?.type === 'Series') targetItemId = details.playableEpisodeId || await this.getSeriesFirstPlayableEpisodeId(targetItemId) || targetItemId;
    const resumePositionTicks = details ? details.playbackPositionTicks || 0 : undefined;

    try {
      const uid = await this.getFirstUserId();
      const startTimeTicksParam =
        typeof options?.startTimeTicks === 'number' && options.startTimeTicks > 0
          ? `&StartTimeTicks=${options.startTimeTicks}`
          : '';

      const supportedVideoCodecs = options?.videoCodecs?.length ? options.videoCodecs : options?.canPlayHevc ? ['h264', 'hevc'] : ['h264'];
      const directVideoCodecs = options?.forceTranscode ? '' : supportedVideoCodecs.join(',');
      const containers = options?.receiver && options.receiver !== 'native-tv' ? ['mp4', 'm4v', 'mov', 'webm'] : ['mkv', 'mp4', 'm4v', 'mov', 'webm', 'ts'];
      const directPlayProfiles = directVideoCodecs ? containers.map(Container => ({
        Container, Type: 'Video', VideoCodec: directVideoCodecs,
        AudioCodec: options?.audioCodecs?.length ? options.audioCodecs.join(',') : 'aac,mp3',
      })) : [];
      const hlsProfile = { Container: 'ts', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'aac', Protocol: 'hls', Context: 'Streaming',
        MaxAudioChannels: options?.receiver === 'cast' && options?.forceTranscode ? '2' : undefined };
      const progressiveProfile = { Container: 'mp4', Type: 'Video', VideoCodec: options?.forceTranscode ? 'h264' : supportedVideoCodecs.filter(codec => ['h264', 'hevc'].includes(codec)).join(',') || 'h264',
        AudioCodec: 'aac', Protocol: 'http', Context: 'Streaming', MaxAudioChannels: options?.receiver === 'cast' && options?.forceTranscode ? '2' : undefined };
      const profilePayload = {
        StartTimeTicks: options?.startTimeTicks,
        // Native clients load external subtitles themselves; do not burn a default track into video.
        SubtitleStreamIndex: -1,
        DeviceProfile: {
          MaxStreamingBitrate: 120000000,
          DirectPlayProfiles: directPlayProfiles,
          CodecProfiles: options?.receiver === 'cast' ? [{
            Type: 'Video', Conditions: [
              { Condition: 'LessThanEqual', Property: 'Width', Value: String(options.maxWidth || 1920), IsRequired: true },
              { Condition: 'LessThanEqual', Property: 'Height', Value: String(options.maxHeight || 1080), IsRequired: true },
            ],
          }] : options?.receiver === 'native-tv' ? (options.tvCapabilities || []).map(capability => ({
            Type: 'Video', Codec: capability.codec, Conditions: [
              { Condition: 'LessThanEqual', Property: 'Width', Value: String(capability.width), IsRequired: true },
              { Condition: 'LessThanEqual', Property: 'Height', Value: String(capability.height), IsRequired: true },
              ...(capability.profiles.length ? [{ Condition: 'EqualsAny', Property: 'VideoProfile', Value: capability.profiles.join('|'), IsRequired: true }] : []),
            ],
          })) : [],
          // Keep a finite, seekable manifest when the original cannot play.
          // A growing fragmented MP4 reports encoded duration instead of title duration.
          TranscodingProfiles: [hlsProfile, progressiveProfile],
        },
      };

      const res = await this.fetch(
        `${this.url}/Items/${encodeURIComponent(targetItemId)}/PlaybackInfo?UserId=${uid}${startTimeTicksParam}`,
        {
          method: 'POST',
          headers: {
            ...this.getHeaders(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(profilePayload),
        }
      );

      if (res.ok) {
        const data = await res.json();
        const mediaSource = data.MediaSources?.[0];
        if (mediaSource) {
          if (mediaSource.LocationType === 'Virtual') return { streamUrl: '', isTranscoding: false, error: 'Media file is not available' };
          let totalDurationTicks = mediaSource.RunTimeTicks;
          if (!totalDurationTicks || totalDurationTicks <= 0) {
            const itemDetails = await this.getItemDetails(targetItemId);
            if (itemDetails?.totalDurationTicks) {
              totalDurationTicks = itemDetails.totalDurationTicks;
            }
          }
          const durationSeconds = typeof totalDurationTicks === 'number' && totalDurationTicks > 0
            ? totalDurationTicks / 10000000
            : undefined;

          // Jellyfin can offer a transcode URL even when the strict receiver
          // profile supports the original file. Prefer the original timeline.
          if (!options?.forceTranscode && mediaSource.SupportsDirectPlay) {
            return {
              streamUrl: `${this.url}/Videos/${encodeURIComponent(targetItemId)}/stream.${encodeURIComponent(mediaSource.Container || 'mp4')}?api_key=${encodeURIComponent(this.apiKey)}&Static=true&MediaSourceId=${encodeURIComponent(mediaSource.Id)}`,
              isTranscoding: false, playMethod: 'DirectPlay', sourceVideoCodec: mediaSource.MediaStreams?.find((s: { Type: string }) => s.Type === 'Video')?.Codec, sourceAudioCodec: mediaSource.MediaStreams?.find((s: { Type: string }) => s.Type === 'Audio')?.Codec, playSessionId: data.PlaySessionId, mediaSourceId: mediaSource.Id, totalDurationTicks, durationSeconds, resumePositionTicks,
            };
          }
          if (!options?.forceTranscode && mediaSource.SupportsDirectStream && mediaSource.DirectStreamUrl) {
            return {
              streamUrl: `${this.url}${mediaSource.TranscodingUrl && /\.m3u8(?:\?|$)/i.test(mediaSource.TranscodingUrl) ? mediaSource.TranscodingUrl : mediaSource.DirectStreamUrl}`,
              isTranscoding: false,
              playMethod: 'DirectStream',
              playSessionId: data.PlaySessionId,
              mediaSourceId: mediaSource.Id,
              totalDurationTicks,
              durationSeconds,
              resumePositionTicks,
            };
          }

          if (mediaSource.TranscodingUrl) {
            return {
              streamUrl: `${this.url}${mediaSource.TranscodingUrl}`,
              isTranscoding: true,
              playMethod: 'Transcode',
              sourceVideoCodec: mediaSource.MediaStreams?.find((s: { Type: string }) => s.Type === 'Video')?.Codec,
              sourceAudioCodec: mediaSource.MediaStreams?.find((s: { Type: string }) => s.Type === 'Audio')?.Codec,
              transcodeReasons: mediaSource.TranscodeReasons?.join(', '),
              playSessionId: data.PlaySessionId,
              mediaSourceId: mediaSource.Id,
              totalDurationTicks,
              durationSeconds,
              resumePositionTicks,
            };
          }
        }
      }
    } catch (e) {
      log.error(`Error negotiating playback for item ${itemId}:`, e);
    }

    return { streamUrl: '', isTranscoding: false, error: 'Jellyfin did not provide a compatible playback stream' };
  }

  /** API-key sessions have no Jellyfin user: UserId in a session report is ignored.
   * Persist only playback fields through the explicit user-data endpoint instead. */
  private async saveHouseholdProgress(itemId: string, positionTicks: number): Promise<boolean> {
    if (requestJellyfinSession()) return true;
    const uid = await this.getFirstUserId();
    const response = await this.fetch(`${this.url}/Users/${encodeURIComponent(uid)}/Items/${encodeURIComponent(itemId)}?Fields=RunTimeTicks`, {
      headers: this.getHeaders(), cache: 'no-store',
    });
    if (!response.ok) return false;
    const item = await response.json();
    const duration = Number(item.RunTimeTicks) || 0;
    const complete = duration > 0 && positionTicks >= duration * 0.9;
    const saved = await this.fetch(`${this.url}/UserItems/${encodeURIComponent(itemId)}/UserData?userId=${encodeURIComponent(uid)}`, {
      method: 'POST', headers: { ...this.getHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ PlaybackPositionTicks: complete ? 0 : positionTicks,
        ...(complete ? { Played: true } : {}), LastPlayedDate: new Date().toISOString() }),
    });
    return saved.ok;
  }

  async reportPlaybackStarted(itemId: string, positionTicks: number, isPaused = false): Promise<boolean> {
    if (!this.isConfigured() || !itemId) return false;
    const uid = await this.getFirstUserId();
    const response = await this.fetch(`${this.url}/Sessions/Playing`, {
      method: 'POST', headers: { ...this.getHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ItemId: itemId, UserId: uid, PositionTicks: positionTicks, IsPaused: isPaused, CanSeek: true }),
    });
    return response.ok && await this.saveHouseholdProgress(itemId, positionTicks);
  }

  async reportPlaybackProgress(itemId: string, positionTicks: number, isPaused = false): Promise<boolean> {
    if (!this.isConfigured() || !itemId) return false;
    try {
      const uid = await this.getFirstUserId();
      const response = await this.fetch(`${this.url}/Sessions/Playing/Progress`, {
        method: 'POST',
        headers: {
          ...this.getHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ItemId: itemId,
          UserId: uid,
          PositionTicks: positionTicks,
          IsPaused: isPaused,
        }),
      });
      return response.ok && await this.saveHouseholdProgress(itemId, positionTicks);
    } catch {
      return false;
    }
  }

  async reportPlaybackStopped(itemId: string, positionTicks: number): Promise<boolean> {
    if (!this.isConfigured() || !itemId) return false;
    try {
      const uid = await this.getFirstUserId();
      const response = await this.fetch(`${this.url}/Sessions/Playing/Stopped`, {
        method: 'POST',
        headers: {
          ...this.getHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ItemId: itemId,
          UserId: uid,
          PositionTicks: positionTicks,
        }),
      });
      return response.ok && await this.saveHouseholdProgress(itemId, positionTicks);
    } catch {
      return false;
    }
  }

  getSubtitleStreamUrl(itemId: string, mediaSourceId: string, index: number): string {
    if (!this.url || !itemId) return '';
    const sourceId = mediaSourceId || itemId;
    return `${this.url}/Videos/${encodeURIComponent(itemId)}/${encodeURIComponent(sourceId)}/Subtitles/${index}/0/Stream.vtt?api_key=${encodeURIComponent(this.apiKey)}`;
  }

  async getSubtitles(itemId: string): Promise<SubtitleTrack[]> {
    if (!this.isConfigured() || !itemId) return [];
    try {
      const uid = await this.getFirstUserId();
      const res = await this.fetch(
        `${this.url}/Users/${uid}/Items/${itemId}?Fields=MediaStreams,MediaSources`,
        { headers: this.getHeaders() }
      );
      if (!res.ok) return [];
      const data: JellyfinItem = await res.json();
      const mediaSourceId = data.MediaSources?.[0]?.Id || itemId;
      const subStreams = (data.MediaStreams || []).filter(
        (s) => s.Type === 'Subtitle' && typeof s.Index === 'number'
      );

      return subStreams.map((s) => ({
        id: String(s.Index),
        index: s.Index!,
        title: s.DisplayTitle || s.Title || s.Language || `Subtitle ${s.Index}`,
        language: s.Language || 'und',
        isDefault: Boolean(s.IsDefault),
        isForced: Boolean(s.IsForced),
        src: `/api/subtitles?itemId=${itemId}&mediaSourceId=${mediaSourceId}&index=${s.Index}`,
      }));
    } catch (e) {
      log.error(`Error fetching subtitles for item ${itemId}:`, e);
      return [];
    }
  }

  private parseMediaQuality(item: JellyfinItem): {
    resolution?: string;
    videoQuality?: string;
    audioQuality?: string;
    hasHdr?: boolean;
  } {
    const streams = item.MediaStreams || item.MediaSources?.[0]?.MediaStreams || [];
    const videoStream = streams.find((s) => s.Type === 'Video');
    const audioStream =
      streams.find((s) => s.Type === 'Audio' && s.IsDefault) ||
      streams.find((s) => s.Type === 'Audio');

    const width = videoStream?.Width || item.Width || 0;
    const height = videoStream?.Height || item.Height || 0;
    const videoTitle = (videoStream?.DisplayTitle || '').toLowerCase();
    const path = (item.MediaSources?.[0]?.Path || '').toLowerCase();

    let resolution: string | undefined;
    let videoQuality: string | undefined;

    if (
      width >= 3800 ||
      height >= 2000 ||
      videoTitle.includes('4k') ||
      videoTitle.includes('2160p') ||
      path.includes('4k') ||
      path.includes('2160p') ||
      path.includes('uhd')
    ) {
      resolution = '4K UHD';
      videoQuality = '4K';
    } else if (
      width >= 1800 ||
      height >= 1000 ||
      videoTitle.includes('1080p') ||
      path.includes('1080p') ||
      videoTitle.includes('fhd')
    ) {
      resolution = '1080p HD';
      videoQuality = '1080p';
    } else if (
      width >= 1200 ||
      height >= 700 ||
      videoTitle.includes('720p') ||
      path.includes('720p') ||
      videoTitle.includes('hd')
    ) {
      resolution = '720p HD';
      videoQuality = '720p';
    } else if (
      (height > 0 && height < 700) ||
      (width > 0 && width < 1200) ||
      videoTitle.includes('sd') ||
      path.includes('480p') ||
      path.includes('576p')
    ) {
      resolution = 'SD';
      videoQuality = 'SD';
    } else if (item.Type === 'Series') {
      resolution = 'HD';
      videoQuality = 'HD';
    }

    // HDR detection
    const range = (videoStream?.VideoRange || videoStream?.VideoRangeType || '').toUpperCase();
    const hasHdr =
      range.includes('HDR') ||
      range.includes('DOVI') ||
      videoTitle.includes('hdr') ||
      videoTitle.includes('dovi') ||
      path.includes('hdr') ||
      path.includes('dolby vision');

    // Audio Quality detection
    let audioQuality: string | undefined;
    const audioTitle = (audioStream?.DisplayTitle || '').toLowerCase();
    const channels = audioStream?.Channels || 0;
    const layout = (audioStream?.ChannelLayout || '').toLowerCase();
    const spatial = (audioStream?.AudioSpatialFormat || '').toLowerCase();

    if (spatial.includes('atmos') || audioTitle.includes('atmos') || path.includes('atmos')) {
      audioQuality = 'Dolby Atmos';
    } else if (channels >= 8 || layout.includes('7.1') || audioTitle.includes('7.1') || path.includes('7.1')) {
      audioQuality = '7.1 Surround';
    } else if (channels >= 5 || layout.includes('5.1') || audioTitle.includes('5.1') || path.includes('5.1')) {
      audioQuality = '5.1 Surround';
    } else if (
      channels === 2 ||
      layout.includes('stereo') ||
      audioTitle.includes('stereo') ||
      path.includes('2.0') ||
      path.includes('stereo')
    ) {
      audioQuality = 'Stereo';
    } else if (channels === 1 || layout.includes('mono') || audioTitle.includes('mono')) {
      audioQuality = 'Mono';
    } else if (audioStream) {
      audioQuality = 'Stereo';
    }

    return { resolution, videoQuality, audioQuality, hasHdr };
  }

  mapJellyfinItem(item: JellyfinItem): MediaItem {
    const isSeries = item.Type === 'Series';
    const isEpisode = item.Type === 'Episode';
    const isMovie = item.Type === 'Movie';

    const posterUrl = this.getImageUrl(item.Id, 'Primary', 600);
    const backdropUrl = (item.BackdropImageTags && item.BackdropImageTags.length > 0)
      ? this.getImageUrl(item.Id, 'Backdrop', 1920)
      : (item.SeriesId ? this.getImageUrl(item.SeriesId, 'Backdrop', 1920) : posterUrl);

    const playbackTicks = item.UserData?.PlaybackPositionTicks || 0;
    const totalTicks = item.RunTimeTicks || 0;
    const progressPercent = totalTicks > 0 ? Math.round((playbackTicks / totalTicks) * 100) : 0;

    const durationMinutes = totalTicks > 0 ? Math.round(totalTicks / (10000 * 1000 * 60)) : undefined;

    const quality = this.parseMediaQuality(item);

    return {
      id: item.Id,
      title: item.Name,
      originalTitle: item.OriginalTitle,
      overview: item.Overview || 'No description available.',
      type: isSeries ? 'Series' : isEpisode ? 'Episode' : 'Movie',
      posterUrl,
      backdropUrl,
      year: item.ProductionYear || (item.PremiereDate ? new Date(item.PremiereDate).getFullYear() : undefined),
      releaseDate: item.PremiereDate,
      rating: item.OfficialRating || undefined,
      matchPercentage: item.CommunityRating ? Math.min(100, Math.max(0, Math.round(item.CommunityRating * 10 + 5))) : 95,
      communityRating: item.CommunityRating,
      durationMinutes,
      genres: item.Genres || [],
      seasonsCount: isSeries && typeof item.ChildCount === 'number' && item.ChildCount > 0 ? item.ChildCount : undefined,
      source: isYouTubeItem(item) ? 'youtube' : 'jellyfin',
      jellyfinId: item.Id,
      seriesId: item.SeriesId,
      seasonNumber: item.ParentIndexNumber,
      episodeNumber: item.IndexNumber,
      seriesName: item.SeriesName,
      tmdbId: (item.ProviderIds?.Tmdb || item.ProviderIds?.tmdb || item.ProviderIds?.TheMovieDb)
        ? Number(item.ProviderIds?.Tmdb || item.ProviderIds?.tmdb || item.ProviderIds?.TheMovieDb)
        : undefined,
      status: 'available',
      played: Boolean(item.UserData?.Played),
      playbackPositionTicks: playbackTicks,
      totalDurationTicks: totalTicks,
      progressPercent,
      resolution: quality.resolution,
      videoQuality: quality.videoQuality,
      audioQuality: quality.audioQuality,
      hasHdr: quality.hasHdr,
      cast: item.People?.map((p) => ({
        name: p.Name,
        role: p.Role || p.Type,
      })),
      videoStreamUrl:
        isMovie || isEpisode
          ? `/api/preview-stream?itemId=${item.Id}${playbackTicks > 0 ? `&ticks=${playbackTicks}` : ''}`
          : undefined,
    };
  }

  async getUserTopGenres(userId?: string): Promise<string[]> {
    if (!this.isConfigured()) return [];
    try {
      const uid = userId || (await this.getFirstUserId());
      if (!uid) return [];

      const genreWeights: Record<string, number> = {};

      // 1. Fetch Resume items (weight: 3)
      const resumeRes = await this.fetch(
        `${this.url}/UserItems/Resume?userId=${uid}&Limit=20&Fields=Genres`,
        { headers: this.getHeaders(), }
      );
      if (resumeRes.ok) {
        const resumeData = await resumeRes.json();
        for (const item of resumeData.Items || []) {
          for (const g of item.Genres || []) {
            genreWeights[g] = (genreWeights[g] || 0) + 3;
          }
        }
      }

      // 2. Fetch Played / Watched items (weight: 1)
      const playedRes = await this.fetch(
        `${this.url}/Users/${uid}/Items?SortBy=DatePlayed&SortOrder=Descending&Filters=IsPlayed&Limit=30&Recursive=true&Fields=Genres`,
        { headers: this.getHeaders(), }
      );
      if (playedRes.ok) {
        const playedData = await playedRes.json();
        for (const item of playedData.Items || []) {
          for (const g of item.Genres || []) {
            genreWeights[g] = (genreWeights[g] || 0) + 1;
          }
        }
      }

      // Sort by accumulated weight descending
      return Object.entries(genreWeights)
        .sort((a, b) => b[1] - a[1])
        .map(([genre]) => genre);
    } catch (e) {
      log.error('Failed fetching user top genres from Jellyfin:', e);
      return [];
    }
  }

  async searchMedia(query: string): Promise<MediaItem[]> {
    if (!this.isConfigured() || !query.trim()) return [];
    const uid = await this.getFirstUserId();
    const params = new URLSearchParams({ SearchTerm: query.trim().slice(0, 200), IncludeItemTypes: 'Movie,Series', Recursive: 'true', Limit: '40', Fields: 'ProviderIds,Overview,Genres,OfficialRating,CommunityRating,RunTimeTicks,LocationType,MediaStreams,SeriesId,SeriesName,Path,Tags' });
    try {
      const response = await this.fetch(`${this.url}/Users/${encodeURIComponent(uid)}/Items?${params}`, { headers: this.getHeaders(), cache: 'no-store' });
      if (!response.ok) return [];
      const data = await response.json();
      return (data.Items || []).filter((item: JellyfinItem) => item.LocationType !== 'Virtual' && !isYouTubeItem(item)).map((item: JellyfinItem) => this.mapJellyfinItem(item));
    } catch { return []; }
  }

  async getResumeItems(strict = false): Promise<MediaItem[]> {
    if (!this.isConfigured()) { if (strict) throw new Error('Jellyfin not configured'); return []; }
    try {
      const uid = await this.getFirstUserId();
      const res = await this.fetch(
        `${this.url}/UserItems/Resume?userId=${uid}&Limit=16&Fields=Overview,Genres,OfficialRating,CommunityRating,People,RunTimeTicks,LocationType,MediaStreams,Width,Height,MediaSources,SeriesId,SeriesName,SeasonId,IndexNumber,ParentIndexNumber,Path,ProviderIds,Tags`,
        { headers: this.getHeaders(), ...(strict ? { cache: 'no-store' as const } : { }) }
      );
      if (!res.ok) { if (strict) throw new Error(`Resume history unavailable (${res.status})`); return []; }
      const data = await res.json();
      // Filter out Virtual items and Season containers (episodes and movies are what users actually resume), and exclude YouTube videos
      const validItems = (data.Items || []).filter(
        (item: JellyfinItem) => item.LocationType !== 'Virtual' && item.Type !== 'Season' && !isYouTubeItem(item)
      );
      const mapped = validItems.map((item: JellyfinItem) => this.mapJellyfinItem(item));
      return await this.attachPlayableStreamsToItems(mapped);
    } catch (e) {
      log.error('Error fetching resume items from Jellyfin:', e);
      if (strict) throw e;
      return [];
    }
  }

  async getLatestMedia(type: 'Movie' | 'Series', limit = 15): Promise<MediaItem[]> {
    if (!this.isConfigured()) return [];
    try {
      const uid = await this.getFirstUserId();
      let parentParam = '';
      if (type === 'Movie') {
        const moviesParentId = await this.getViewId('movies');
        if (moviesParentId) parentParam = `&ParentId=${encodeURIComponent(moviesParentId)}`;
      } else if (type === 'Series') {
        const tvParentId = await this.getViewId('tvshows');
        if (tvParentId) parentParam = `&ParentId=${encodeURIComponent(tvParentId)}`;
      }
      const res = await this.fetch(
        `${this.url}/Users/${uid}/Items?IncludeItemTypes=${type}&SortBy=DateCreated&SortOrder=Descending&Limit=${limit * 2}&Recursive=true&Fields=Overview,Genres,OfficialRating,CommunityRating,People,BackdropImageTags,ChildCount,RunTimeTicks,LocationType,MediaStreams,Width,Height,MediaSources,Path,ProviderIds,Tags${parentParam}`,
        { headers: this.getHeaders(), }
      );
      if (!res.ok) return [];
      const data = await res.json();
      const validItems = (data.Items || []).filter((item: JellyfinItem) => item.LocationType !== 'Virtual' && !isYouTubeItem(item)).slice(0, limit);
      const mapped = validItems.map((item: JellyfinItem) => this.mapJellyfinItem(item));
      if (type === 'Series') {
        return await this.attachPlayableStreamsToItems(mapped);
      }
      return mapped;
    } catch (e) {
      log.error(`Error fetching latest ${type} from Jellyfin:`, e);
      return [];
    }
  }

  async getTopRated(limit = 10): Promise<MediaItem[]> {
    if (!this.isConfigured()) return [];
    try {
      const uid = await this.getFirstUserId();
      const res = await this.fetch(
        `${this.url}/Users/${uid}/Items?IncludeItemTypes=Movie,Series&SortBy=CommunityRating&SortOrder=Descending&Limit=${limit * 2}&Recursive=true&Fields=Overview,Genres,OfficialRating,CommunityRating,People,BackdropImageTags,ChildCount,RunTimeTicks,LocationType,MediaStreams,Width,Height,MediaSources,Path,ProviderIds,Tags`,
        { headers: this.getHeaders(), }
      );
      if (!res.ok) return [];
      const data = await res.json();
      const validItems = (data.Items || []).filter((item: JellyfinItem) => item.LocationType !== 'Virtual' && !isYouTubeItem(item)).slice(0, limit);
      const mapped = validItems.map((item: JellyfinItem) => this.mapJellyfinItem(item));
      return await this.attachPlayableStreamsToItems(mapped);
    } catch (e) {
      log.error('Error fetching top rated from Jellyfin:', e);
      return [];
    }
  }

  async getSeriesFirstPlayableEpisodeId(seriesId: string): Promise<string | undefined> {
    if (!this.isConfigured() || !seriesId) return undefined;
    try {
      const uid = await this.getFirstUserId();
      // First check NextUp for this specific series
      const nextUpRes = await this.fetch(
        `${this.url}/Shows/NextUp?SeriesId=${seriesId}&UserId=${uid}&Limit=1`,
        { headers: this.getHeaders(), }
      );
      if (nextUpRes.ok) {
        const nextUpData = await nextUpRes.json();
        const candidate = (nextUpData.Items || []).find((ep: JellyfinItem) => ep.LocationType !== 'Virtual');
        if (candidate) return candidate.Id;
      }

      // Fallback: fetch non-missing episodes of the series, skipping Virtual or Specials
      const epRes = await this.fetch(
        `${this.url}/Shows/${seriesId}/Episodes?UserId=${uid}&IsMissing=false&Limit=30&Fields=LocationType,ParentIndexNumber,IndexNumber`,
        { headers: this.getHeaders(), }
      );
      if (epRes.ok) {
        const epData = await epRes.json();
        const realEps = (epData.Items || []).filter((ep: JellyfinItem) => ep.LocationType !== 'Virtual');
        // Prefer season 1+ first
        const regularEp = realEps.find((ep: JellyfinItem) => (ep.ParentIndexNumber || 0) > 0);
        if (regularEp) return regularEp.Id;
        if (realEps.length > 0) return realEps[0].Id;
      }
    } catch (e) {
      log.error(`Error resolving first episode for series ${seriesId}:`, e);
    }
    return undefined;
  }

  async attachPlayableStreamsToItems(items: MediaItem[]): Promise<MediaItem[]> {
    if (!this.isConfigured() || items.length === 0) return items;
    const seriesItems = items.filter((item) => item.type === 'Series' && !item.videoStreamUrl);
    if (seriesItems.length === 0) return items;

    try {
      const uid = await this.getFirstUserId();
      const nextUpRes = await this.fetch(
        `${this.url}/Shows/NextUp?UserId=${uid}&Limit=100`,
        { headers: this.getHeaders(), }
      );
      const nextUpMap = new Map<string, { epId: string; positionTicks?: number; totalTicks?: number }>();
      if (nextUpRes.ok) {
        const nextUpData = await nextUpRes.json();
        for (const ep of nextUpData.Items || []) {
          if (ep.SeriesId && ep.Id && ep.LocationType !== 'Virtual') {
            nextUpMap.set(ep.SeriesId, {
              epId: ep.Id,
              positionTicks: ep.UserData?.PlaybackPositionTicks,
              totalTicks: ep.RunTimeTicks,
            });
          }
        }
      }

      for (let offset = 0; offset < seriesItems.length; offset += 6) await Promise.all(
        seriesItems.slice(offset, offset + 6).map(async (series) => {
          const nextUp = nextUpMap.get(series.id);
          const epId = nextUp?.epId || await this.getSeriesFirstPlayableEpisodeId(series.id);
          if (epId) {
            const ticks = nextUp?.positionTicks && nextUp.positionTicks > 0 ? nextUp.positionTicks : 0;
            series.videoStreamUrl = `/api/preview-stream?itemId=${epId}${ticks > 0 ? `&ticks=${ticks}` : ''}`;
            series.playableEpisodeId = epId;
            if (ticks > 0) {
              series.playbackPositionTicks = ticks;
              if (nextUp?.totalTicks && nextUp.totalTicks > 0) {
                series.progressPercent = Math.round((ticks / nextUp.totalTicks) * 100);
              }
            }
          }
        })
      );
    } catch (e) {
      log.error('Error attaching series stream URLs:', e);
    }

    return items;
  }

  async getItemDetails(itemId: string): Promise<MediaItem | null> {
    if (!this.isConfigured()) return null;
    try {
      const uid = await this.getFirstUserId();
      const res = await this.fetch(
        `${this.url}/Users/${uid}/Items/${itemId}?Fields=Overview,Genres,OfficialRating,CommunityRating,People,BackdropImageTags,ChildCount,RunTimeTicks,ProviderIds,LocationType,SeriesId,SeriesName,MediaStreams,Width,Height,MediaSources`,
        { headers: this.getHeaders(), cache: 'no-store' }
      );
      if (!res.ok) return null;
      const data: JellyfinItem = await res.json();
      const media = this.mapJellyfinItem(data);

      if (data.Type === 'Series') {
        media.seasons = await this.getSeriesSeasons(itemId);
        const playable = media.seasons.flatMap((s) => s.episodes || []).filter(ep => ep.videoStreamUrl);
        // Resume an in-progress episode before choosing the next unwatched one.
        const regular = playable.filter(ep => (ep.seasonNumber || 0) > 0);
        const ordered = regular.length ? regular : playable;
        const firstEp = ordered.find(ep => (ep.playbackPositionTicks || 0) > 0 && !ep.played)
          || ordered.find(ep => !ep.played) || ordered[0];
        if (firstEp) {
          media.playableEpisodeId = firstEp.jellyfinId || firstEp.id;
          media.videoStreamUrl = firstEp.videoStreamUrl;
          media.playbackPositionTicks = firstEp.playbackPositionTicks || 0;
          media.totalDurationTicks = firstEp.totalDurationTicks;
          media.progressPercent = firstEp.progressPercent;
        } else {
          const epId = await this.getSeriesFirstPlayableEpisodeId(itemId);
          if (epId) {
            media.playableEpisodeId = epId;
            media.videoStreamUrl = this.getStreamUrl(epId);
          }
        }
      } else if (data.Type === 'Episode' && data.SeriesId) {
        media.seasons = await this.getSeriesSeasons(data.SeriesId);
        media.playableEpisodeId = data.Id;
        media.videoStreamUrl = this.getStreamUrl(data.Id);
      }

      return media;
    } catch (e) {
      log.error('Error fetching item details from Jellyfin:', e);
      return null;
    }
  }

  async getRecommendationSeed(itemId: string): Promise<MediaItem | null> {
    if (!this.isConfigured() || !itemId) return null;
    try {
      const uid = await this.getFirstUserId();
      const response = await this.fetch(`${this.url}/Users/${encodeURIComponent(uid)}/Items/${encodeURIComponent(itemId)}?Fields=ProviderIds,Genres,People,Overview,SeriesId,SeriesName,LocationType`,
        { headers: this.getHeaders(), signal: AbortSignal.timeout(8000) });
      return response.ok ? this.mapJellyfinItem(await response.json()) : null;
    } catch { return null; }
  }

  async getSimilarItems(itemId: string, limit = 12): Promise<MediaItem[]> {
    if (!this.isConfigured() || !itemId) return [];
    try {
      const uid = await this.getFirstUserId();
      const res = await this.fetch(
        `${this.url}/Items/${itemId}/Similar?userId=${uid}&limit=${limit}&Fields=Overview,Genres,OfficialRating,CommunityRating,People,BackdropImageTags,RunTimeTicks,ProviderIds,LocationType`,
        { headers: this.getHeaders(), }
      );
      if (!res.ok) return [];
      const data = await res.json();
      const validItems = (data.Items || []).filter((item: JellyfinItem) => item.LocationType !== 'Virtual');
      return validItems.map((item: JellyfinItem) => this.mapJellyfinItem(item));
    } catch (e) {
      log.error('Error fetching similar items from Jellyfin:', e);
      return [];
    }
  }

  async setWatched(itemId: string, played: boolean): Promise<boolean> {
    const uid = await this.getFirstUserId();
    const response = await this.fetch(`${this.url}/Users/${encodeURIComponent(uid)}/PlayedItems/${encodeURIComponent(itemId)}`, {
      method: played ? 'POST' : 'DELETE', headers: this.getHeaders(), cache: 'no-store',
    });
    return response.ok;
  }

  async getEpisodeQueue(itemId: string): Promise<MediaItem[]> {
    const uid = await this.getFirstUserId();
    const response = await this.fetch(`${this.url}/Users/${encodeURIComponent(uid)}/Items/${encodeURIComponent(itemId)}`, { headers: this.getHeaders(), cache: 'no-store' });
    if (!response.ok) throw new Error('Episode not found');
    const current: JellyfinItem = await response.json();
    const seriesId = current.Type === 'Series' ? current.Id : current.SeriesId;
    if (!seriesId) return [];
    const episodes = await this.fetch(`${this.url}/Shows/${encodeURIComponent(seriesId)}/Episodes?UserId=${encodeURIComponent(uid)}&IsMissing=false&Fields=Overview,RunTimeTicks,IndexNumber,ParentIndexNumber,LocationType,UserData,SeriesId,SeriesName&SortBy=ParentIndexNumber,IndexNumber&SortOrder=Ascending`, { headers: this.getHeaders(), cache: 'no-store' });
    if (!episodes.ok) throw new Error('Episodes unavailable');
    const data = await episodes.json();
    return (data.Items || []).filter((episode: JellyfinItem) => episode.LocationType !== 'Virtual' && (current.ParentIndexNumber === 0 || (episode.ParentIndexNumber ?? 1) > 0))
      .sort((a: JellyfinItem, b: JellyfinItem) => (a.ParentIndexNumber ?? 1) - (b.ParentIndexNumber ?? 1) || (a.IndexNumber ?? 0) - (b.IndexNumber ?? 0))
      .map((episode: JellyfinItem) => this.mapJellyfinItem({ ...episode, Type: 'Episode', SeriesId: seriesId, SeriesName: episode.SeriesName || current.SeriesName || current.Name }));
  }

  async getSeriesSeasons(seriesId: string): Promise<Season[]> {
    if (!this.isConfigured()) return [];
    try {
      const uid = await this.getFirstUserId();
      const res = await this.fetch(
        `${this.url}/Shows/${seriesId}/Seasons?userId=${uid}&Fields=Overview,ItemCounts`,
        { headers: this.getHeaders(), cache: 'no-store' }
      );
      if (!res.ok) return [];
      const data = await res.json();
      const seasons: Season[] = [];

      if (!data.Items || data.Items.length === 0) {
        // Fallback: Fetch all episodes directly for the series and group by ParentIndexNumber
        const allEpRes = await this.fetch(
          `${this.url}/Shows/${seriesId}/Episodes?userId=${uid}&Fields=Overview,RunTimeTicks,IndexNumber,ParentIndexNumber,LocationType,UserData,ImageTags`,
          { headers: this.getHeaders(), cache: 'no-store' }
        );
        if (allEpRes.ok) {
          const allEpData = await allEpRes.json();
          const rawItems = allEpData.Items || [];
          const epItems = rawItems.some((ep: JellyfinItem) => ep.LocationType !== 'Virtual')
            ? rawItems.filter((ep: JellyfinItem) => ep.LocationType !== 'Virtual')
            : rawItems;
          const seasonMap = new Map<number, Episode[]>();
          for (const ep of epItems) {
            const sNum = ep.ParentIndexNumber || 1;
            if (!seasonMap.has(sNum)) seasonMap.set(sNum, []);
            const epPlaybackTicks = ep.UserData?.PlaybackPositionTicks || 0;
            const epTotalTicks = ep.RunTimeTicks || 0;
            const epProgress = epTotalTicks > 0 ? Math.round((epPlaybackTicks / epTotalTicks) * 100) : 0;
            const epPlayed = Boolean(ep.UserData?.Played);
            seasonMap.get(sNum)!.push({
              id: ep.Id,
              locationType: ep.LocationType,
              episodeNumber: ep.IndexNumber || 1,
              seasonNumber: sNum,
              name: ep.Name,
              overview: ep.Overview || 'No description available.',
              durationMinutes: ep.RunTimeTicks ? Math.round(ep.RunTimeTicks / (10000 * 1000 * 60)) : 45,
              totalDurationTicks: ep.RunTimeTicks,
              playbackPositionTicks: epPlaybackTicks,
              progressPercent: epProgress,
              played: epPlayed,
              thumbnailUrl: `/api/mobile/v1/image?itemId=${ep.Id}&type=Primary&maxWidth=400`,
              jellyfinId: ep.Id,
              videoStreamUrl: this.getStreamUrl(ep.Id),
            });
          }

          const sortedEntries = Array.from(seasonMap.entries()).sort(([a], [b]) => a - b);
          return sortedEntries.map(([sNum, eps]) => ({
            id: `season-${sNum}`,
            seasonNumber: sNum,
            name: `Season ${sNum}`,
            episodeCount: eps.length,
            episodes: eps.sort((a, b) => a.episodeNumber - b.episodeNumber),
          }));
        }
        return [];
      }

      for (const s of data.Items || []) {
        // Fetch episodes for season
        const epRes = await this.fetch(
          `${this.url}/Shows/${seriesId}/Episodes?seasonId=${s.Id}&userId=${uid}&Fields=Overview,RunTimeTicks,IndexNumber,LocationType,UserData,ImageTags`,
          { headers: this.getHeaders(), cache: 'no-store' }
        );
        let episodes: Episode[] = [];
        if (epRes.ok) {
          const epData = await epRes.json();
          const rawItems = epData.Items || [];
          const filtered = rawItems.some((ep: JellyfinItem) => ep.LocationType !== 'Virtual')
            ? rawItems.filter((ep: JellyfinItem) => ep.LocationType !== 'Virtual')
            : rawItems;
          episodes = filtered.map((ep: JellyfinItem) => {
              const epPlaybackTicks = ep.UserData?.PlaybackPositionTicks || 0;
              const epTotalTicks = ep.RunTimeTicks || 0;
              const epProgress = epTotalTicks > 0 ? Math.round((epPlaybackTicks / epTotalTicks) * 100) : 0;
              const epPlayed = Boolean(ep.UserData?.Played);
              return {
                id: ep.Id,
              locationType: ep.LocationType,
                episodeNumber: ep.IndexNumber || 1,
                seasonNumber: s.IndexNumber || 1,
                name: ep.Name,
                overview: ep.Overview || 'No description available.',
                durationMinutes: ep.RunTimeTicks ? Math.round(ep.RunTimeTicks / (10000 * 1000 * 60)) : 45,
                totalDurationTicks: ep.RunTimeTicks,
                playbackPositionTicks: epPlaybackTicks,
                progressPercent: epProgress,
                played: epPlayed,
                thumbnailUrl: `/api/mobile/v1/image?itemId=${ep.Id}&type=Primary&maxWidth=400`,
                jellyfinId: ep.Id,
                videoStreamUrl: this.getStreamUrl(ep.Id),
              };
            });
        }

        seasons.push({
          id: s.Id,
          seasonNumber: s.IndexNumber || 1,
          name: s.Name || `Season ${s.IndexNumber}`,
          episodeCount: episodes.length,
          overview: s.Overview,
          episodes,
        });
      }

      return seasons;
    } catch (e) {
      log.error('Error fetching seasons from Jellyfin:', e);
      return [];
    }
  }

  async getMovieCollection(itemId: string): Promise<MediaItem[]> {
    if (!this.isConfigured() || !itemId) return [];
    try {
      const uid = await this.getFirstUserId();
      const itemRes = await this.fetch(
        `${this.url}/Users/${uid}/Items/${itemId}?Fields=Collections,ProviderIds`,
        { headers: this.getHeaders(), cache: 'no-store' }
      );
      if (!itemRes.ok) return [];
      const itemData = await itemRes.json();
      const collections = itemData.Collections || [];
      if (collections.length > 0) {
        const colId = collections[0].Id;
        const colItemsRes = await this.fetch(
          `${this.url}/Users/${uid}/Items?ParentId=${colId}&SortBy=ProductionYear,SortName&SortOrder=Ascending&Fields=Overview,Genres,OfficialRating,CommunityRating,People,BackdropImageTags,ChildCount,RunTimeTicks,LocationType,MediaStreams,Width,Height,MediaSources`,
          { headers: this.getHeaders(), cache: 'no-store' }
        );
        if (colItemsRes.ok) {
          const colData = await colItemsRes.json();
          return (colData.Items || []).map((i: JellyfinItem) => this.mapJellyfinItem(i));
        }
      }
      return [];
    } catch (e) {
      log.error('Error fetching movie collection from Jellyfin:', e);
      return [];
    }
  }
}
