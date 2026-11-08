import type { MediaItem, MediaRowSection, UserProfile, SubtitleTrack } from './types';
export type { MediaItem, MediaRowSection, UserProfile, SubtitleTrack, RequestMediaPayload, Episode, Season, DownloadingTorrentItem } from './types';
export interface ApiError { error: string; }
export interface HomeResponse { hero?: MediaItem | null; sections: MediaRowSection[]; requestSections?: MediaRowSection[]; isDemoMode: boolean; }
export interface LibraryResponse { items: MediaItem[]; totalCount?: number; filteredCount?: number; availableLetters?: string[]; }
export interface MediaResponse { item: MediaItem; }
export interface ProfilesResponse { profiles: UserProfile[]; activeProfileId?: string; canSwitchProfile?: boolean; needsSetup?: boolean; }
export interface PlaybackResponse { streamUrl: string; isTranscoding: boolean; durationSeconds?: number; transport?: string; contentType?: string; }
export interface PublicConfig { appName: string; isConfigured: boolean; jellyfinUrl: string; hasJellyfinKey: boolean; jellyfinUserId: string; seerrUrl: string; hasSeerrKey: boolean; qbittorrentUrl?: string; qbittorrentUsername?: string; hasQbittorrentPassword: boolean; downloadsPath: string; isJellyfinConfigured: boolean; isSeerrConfigured: boolean; isQbittorrentConfigured: boolean; isSetupNeeded: boolean; profilesCount: number; }
export interface Capabilities { apiVersion: number; appName: string; cast: boolean; jellyfinLogin?: boolean; }
