// Generated from backend models. Do not edit.
export type MediaType = 'Movie' | 'Series' | 'Episode';

export type AvailabilityStatus = 'available' | 'partially_available' | 'requested' | 'processing' | 'not_requested';

export interface SubtitleTrack {
  id: string;
  index: number;
  title: string;
  language: string;
  isDefault?: boolean;
  isForced?: boolean;
  src: string;
}

export interface Episode {
  locationType?: string;
  id: string;
  episodeNumber: number;
  seasonNumber: number;
  name: string;
  overview: string;
  durationMinutes: number;
  thumbnailUrl: string;
  playbackPositionTicks?: number;
  totalDurationTicks?: number;
  progressPercent?: number;
  played?: boolean;
  jellyfinId?: string;
  videoStreamUrl?: string;
  downloadStreamUrl?: string;
}

export interface Season {
  id: string;
  seasonNumber: number;
  name: string;
  episodeCount: number;
  overview?: string;
  episodes?: Episode[];
}

export interface CastMember {
  name: string;
  role: string;
  profileUrl?: string;
}

export interface MediaItem {
  id: string;
  title: string;
  originalTitle?: string;
  overview: string;
  type: MediaType;
  posterUrl: string;
  backdropUrl: string;
  year?: number;
  releaseDate?: string;
  rating?: string; // e.g. "TV-MA", "PG-13"
  matchPercentage?: number; // e.g. 98
  communityRating?: number; // e.g. 8.6
  durationMinutes?: number;
  genres: string[];
  seasonsCount?: number;
  source: 'jellyfin' | 'seerr' | 'demo';
  jellyfinId?: string;
  seerrId?: number;
  tmdbId?: number;
  playableEpisodeId?: string;
  status: AvailabilityStatus;
  played?: boolean;
  playbackPositionTicks?: number;
  totalDurationTicks?: number;
  progressPercent?: number; // 0 - 100 for Continue Watching
  cast?: CastMember[];
  director?: string;
  seriesId?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  seriesName?: string;
  seasons?: Season[];
  videoStreamUrl?: string;
  trailerKey?: string; // YouTube video key e.g. "dfeUzm6KF4g"
  trailerUrl?: string; // YouTube video URL
  resolution?: string;   // e.g. "4K UHD", "1080p HD", "720p HD", "HD", "SD"
  videoQuality?: string; // e.g. "4K", "1080p", "720p", "SD"
  audioQuality?: string; // e.g. "Dolby Atmos", "5.1 Surround", "7.1 Surround", "Stereo", "Mono"
  hasHdr?: boolean;
  isDownloading?: boolean;
  downloadProgress?: number; // 0 - 100
  downloadSpeed?: number;
  downloadEta?: number;
  downloaded?: number;
  torrentHash?: string;
  downloadStreamUrl?: string;
  mediaFiles?: DownloadingTorrentFile[];
}

export interface MediaRowSection {
  id: string;
  title: string;
  items: MediaItem[];
  isTop10?: boolean;
}



export interface DownloadingTorrentFile {
  index: number;
  name: string;
  size: number;
  progress: number;
  isMedia: boolean;
}

export interface DownloadingTorrentItem {
  hash: string;
  name: string;
  progress: number; // 0 to 1
  progressPercent: number; // 0 to 100
  downloadSpeed: number; // bytes/sec
  eta: number; // seconds
  state: string;
  size: number;
  downloaded: number;
  seqDl: boolean;
  fLPiecePrio: boolean;
  category?: string;
  tags?: string;
  streamable: boolean;
  streamUrl?: string;
  videoFile?: DownloadingTorrentFile;
  mediaFiles?: DownloadingTorrentFile[];
}

export interface UserProfile {
  isKids?: boolean;
  kidsDateOfBirth?: string;
  kidsRating?: 'U' | 'PG' | '12' | '15' | '18';
  avatarId?: string;
  id: string;
  name: string;
  avatarColor: string; // Tailwind gradient e.g. "from-red-600 to-red-800"
  avatarBg: string;    // Tailwind bg color e.g. "bg-red-600"
  initials: string;    // e.g. "NA"
  avatarUrl?: string;  // Jellyfin avatar image URL if available
  isAdministrator?: boolean;
  jellyfinUserId?: string;
}

export interface RequestMediaPayload {
  mediaType: 'movie' | 'tv';
  mediaId: number; // TMDB ID
  seasons?: number[] | 'all'; // [1, 2, 3] or all
  is4k?: boolean;
  profileId?: number;
  serverId?: number;
}
