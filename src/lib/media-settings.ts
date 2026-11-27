import { stateDatabase } from '@/state/database';

export interface MediaLibraryConfig {
  id: string;
  name: string;
  type: 'movie' | 'tv';
  paths: string[];
  enabled: boolean;
  scanIntervalMinutes: number;
  preferNfo: boolean;
  autoDownloadArtwork: boolean;
}

export type HwAccelMode = 'none' | 'auto' | 'vaapi' | 'qsv' | 'nvenc' | 'videotoolbox';
export type TranscodePreset = 'ultrafast' | 'superfast' | 'veryfast' | 'faster' | 'fast' | 'medium';
export type SubtitleMode = 'default' | 'forced' | 'always' | 'none';

export interface MediaEngineSettings {
  mediaEngine: 'native';
  libraries: MediaLibraryConfig[];
  // Transcoding & Hardware Acceleration
  hwAccel: HwAccelMode;
  vaapiDevice: string;
  transcodeTempDir: string;
  maxTranscodeBitrateMbps: number;
  maxConcurrentTranscodes: number;
  transcodePreset: TranscodePreset;
  hdrToneMapping: boolean;
  allowDirectPlay: boolean;
  allowDirectStream: boolean;
  burnInImageSubtitles: boolean;
  transcodeIdleTimeoutSeconds: number;
  hlsSegmentSeconds: number;
  // Playback & Extras
  enableSkipIntroCredits: boolean;
  enableMultiVersionGrouping: boolean;
  enableTrickplay: boolean; // Opt-in
  trickplayIntervalSeconds: number;
  trickplayWidth: number;
  enableSyncPlay: boolean;
  enableWatchStats: boolean;
  // Languages & Metadata
  defaultAudioLanguage: string;
  defaultSubtitleLanguage: string;
  subtitleMode: SubtitleMode;
  metadataLanguage: string;
  artworkCacheDir: string;
}

const DEFAULT_LIBRARIES: MediaLibraryConfig[] = [
  {
    id: 'lib-movies',
    name: 'Movies',
    type: 'movie',
    paths: ['/movies'],
    enabled: true,
    scanIntervalMinutes: 720,
    preferNfo: true,
    autoDownloadArtwork: true,
  },
  {
    id: 'lib-tv',
    name: 'TV Shows',
    type: 'tv',
    paths: ['/tv'],
    enabled: true,
    scanIntervalMinutes: 720,
    preferNfo: true,
    autoDownloadArtwork: true,
  },
];

export const DEFAULT_MEDIA_ENGINE_SETTINGS: MediaEngineSettings = {
  mediaEngine: 'native',
  libraries: DEFAULT_LIBRARIES,
  hwAccel: 'auto',
  vaapiDevice: '/dev/dri/renderD128',
  transcodeTempDir: '/tmp/homestream-transcode',
  maxTranscodeBitrateMbps: 20,
  maxConcurrentTranscodes: 2,
  transcodePreset: 'veryfast',
  hdrToneMapping: true,
  allowDirectPlay: true,
  allowDirectStream: true,
  burnInImageSubtitles: true,
  transcodeIdleTimeoutSeconds: 120,
  hlsSegmentSeconds: 4,
  enableSkipIntroCredits: true,
  enableMultiVersionGrouping: true,
  enableTrickplay: false,
  trickplayIntervalSeconds: 10,
  trickplayWidth: 320,
  enableSyncPlay: true,
  enableWatchStats: true,
  defaultAudioLanguage: 'eng',
  defaultSubtitleLanguage: 'eng',
  subtitleMode: 'default',
  metadataLanguage: 'en-US',
  artworkCacheDir: '/app/data/artwork',
};

export function getMediaEngineSettings(): MediaEngineSettings {
  let stored: Partial<MediaEngineSettings> = {};
  try {
    const row = stateDatabase()
      .prepare('SELECT value FROM metadata WHERE name = ?')
      .get('media_engine_settings') as { value?: string } | undefined;
    if (row?.value) stored = JSON.parse(row.value);
  } catch {
    stored = {};
  }
  return {
    ...DEFAULT_MEDIA_ENGINE_SETTINGS,
    ...stored,
    mediaEngine: 'native',
    libraries: Array.isArray(stored.libraries)
      ? stored.libraries
      : DEFAULT_LIBRARIES,
  };
}

export function saveMediaEngineSettings(patch: Partial<MediaEngineSettings>): MediaEngineSettings {
  const current = getMediaEngineSettings();
  const next: MediaEngineSettings = {
    ...current,
    ...patch,
    mediaEngine: 'native',
    libraries: Array.isArray(patch.libraries) ? patch.libraries : current.libraries,
    maxConcurrentTranscodes: Math.max(1, Math.min(32, Math.floor(Number(patch.maxConcurrentTranscodes ?? current.maxConcurrentTranscodes) || 2))),
    maxTranscodeBitrateMbps: Math.max(0, Math.min(200, Number(patch.maxTranscodeBitrateMbps ?? current.maxTranscodeBitrateMbps) || 0)),
    transcodeIdleTimeoutSeconds: Math.max(30, Math.min(3600, Number(patch.transcodeIdleTimeoutSeconds ?? current.transcodeIdleTimeoutSeconds) || 120)),
    hlsSegmentSeconds: Math.max(2, Math.min(15, Number(patch.hlsSegmentSeconds ?? current.hlsSegmentSeconds) || 4)),
    trickplayIntervalSeconds: Math.max(2, Math.min(60, Number(patch.trickplayIntervalSeconds ?? current.trickplayIntervalSeconds) || 10)),
    trickplayWidth: Math.max(160, Math.min(640, Number(patch.trickplayWidth ?? current.trickplayWidth) || 320)),
  };
  stateDatabase()
    .prepare('INSERT OR REPLACE INTO metadata (name, value) VALUES (?, ?)')
    .run('media_engine_settings', JSON.stringify(next));
  return next;
}
