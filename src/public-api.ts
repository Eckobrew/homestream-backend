import type { MediaAudioTrack, MediaItem, MediaRowSection, MediaVersion, SkipSegment, UserProfile, SubtitleTrack } from './types';
export type { MediaItem, MediaRowSection, UserProfile, SubtitleTrack, RequestMediaPayload, Episode, Season, DownloadingTorrentItem } from './types';
export interface ApiError { error: string; }
export interface HomeResponse { hero?: MediaItem | null; sections: MediaRowSection[]; requestSections?: MediaRowSection[]; isDemoMode: boolean; }
export interface LibraryResponse { items: MediaItem[]; totalCount?: number; filteredCount?: number; availableLetters?: string[]; }
export interface MediaResponse { item: MediaItem; }
export interface ProfilesResponse { profiles: UserProfile[]; activeProfileId?: string; canSwitchProfile?: boolean; needsSetup?: boolean; }
export interface PlaybackResponse {
  streamUrl: string;
  isTranscoding: boolean;
  durationSeconds?: number;
  totalDurationTicks?: number;
  playMethod?: string;
  transport?: string;
  contentType?: string;
  versions?: MediaVersion[];
  skipSegments?: SkipSegment[];
  trickplayUrl?: string;
  subtitles?: SubtitleTrack[];
  audioTracks?: MediaAudioTrack[];
}
export interface PublicConfig { appName: string; isConfigured: boolean; mediaEngine?: 'native'; qbittorrentUrl?: string; qbittorrentUsername?: string; hasQbittorrentPassword: boolean; downloadsPath: string; isQbittorrentConfigured: boolean; isSetupNeeded: boolean; profilesCount: number; }
export interface Capabilities { apiVersion: number; appName: string; cast: boolean; canManageIntegrations?: boolean; }

export type { MusicAlbum, MusicTrack, MusicResponse, MusicAlbumResponse, BookItem, BookRequestItem, BookProgress, BooksResponse, BookSearchResponse, BookDetailResponse, BookQueueItem, BookQueueResponse, RequestedItem, RequestedResponse, IntegrationSummary, IntegrationsResponse, YouTubeSearchResult, YouTubeSearchResponse, YouTubeStreamResponse, YouTubeSubscription, YouTubeSubscriptionsResponse, YouTubeDownloadItem, YouTubeQueueResponse, YouTubeArchiveItem, YouTubeArchiveResponse } from './types';
