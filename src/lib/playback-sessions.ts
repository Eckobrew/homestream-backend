import crypto from 'node:crypto';

export type SessionDeviceType = 'android-tv' | 'android-mobile' | 'web';
export type SessionMediaType = 'video' | 'music' | 'idle';

export type RemoteCommandType =
  | 'play'
  | 'pause'
  | 'togglePlayPause'
  | 'stop'
  | 'seekTo'
  | 'seekBy'
  | 'next'
  | 'previous'
  | 'volumeUp'
  | 'volumeDown'
  | 'muteToggle'
  | 'dpadUp'
  | 'dpadDown'
  | 'dpadLeft'
  | 'dpadRight'
  | 'dpadCenter'
  | 'back'
  | 'home';

export interface PlaybackSession {
  deviceId: string;
  deviceName: string;
  deviceType: SessionDeviceType;
  profileId: string;
  mediaId: string;
  mediaType: SessionMediaType;
  title: string;
  subtitle: string;
  artworkUrl: string;
  isPlaying: boolean;
  positionMs: number;
  durationMs: number;
  canSeek: boolean;
  canSkipNext: boolean;
  canSkipPrev: boolean;
  updatedAt: number;
}

export interface RemoteCommand {
  id: string;
  type: RemoteCommandType;
  positionMs?: number;
  deltaMs?: number;
  createdAt: number;
}

const SESSION_TTL_MS = 20_000;
const MAX_QUEUED_COMMANDS = 16;

const sessions = new Map<string, PlaybackSession>();
const subscribers = new Map<string, Set<(cmd: RemoteCommand) => void>>();
const pendingCommands = new Map<string, RemoteCommand[]>();

function pruneExpired(now = Date.now()): void {
  for (const [id, session] of sessions) {
    if (now - session.updatedAt > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}

export function upsertPlaybackSession(
  input: Omit<PlaybackSession, 'updatedAt'> & { isStopped?: boolean },
): PlaybackSession | null {
  const now = Date.now();
  pruneExpired(now);

  if (input.isStopped) {
    const existing = sessions.get(input.deviceId);
    if (input.deviceType === 'android-tv') {
      // Keep Android TV reachable as an idle target for the remote control.
      const idle: PlaybackSession = {
        deviceId: input.deviceId,
        deviceName: input.deviceName || existing?.deviceName || 'Android TV',
        deviceType: 'android-tv',
        profileId: input.profileId,
        mediaId: '',
        mediaType: 'idle',
        title: '',
        subtitle: '',
        artworkUrl: '',
        isPlaying: false,
        positionMs: 0,
        durationMs: 0,
        canSeek: false,
        canSkipNext: false,
        canSkipPrev: false,
        updatedAt: now,
      };
      sessions.set(input.deviceId, idle);
      return idle;
    }
    sessions.delete(input.deviceId);
    return null;
  }

  const session: PlaybackSession = {
    deviceId: input.deviceId,
    deviceName: input.deviceName,
    deviceType: input.deviceType,
    profileId: input.profileId,
    mediaId: input.mediaId,
    mediaType: input.mediaType,
    title: input.title,
    subtitle: input.subtitle,
    artworkUrl: input.artworkUrl,
    isPlaying: input.isPlaying,
    positionMs: Math.max(0, Math.floor(input.positionMs)),
    durationMs: Math.max(0, Math.floor(input.durationMs)),
    canSeek: input.canSeek,
    canSkipNext: input.canSkipNext,
    canSkipPrev: input.canSkipPrev,
    updatedAt: now,
  };
  sessions.set(session.deviceId, session);
  return session;
}

export function listProfileSessions(profileId: string, excludeDeviceId?: string): {
  sessions: PlaybackSession[];
  tvDevices: PlaybackSession[];
} {
  const now = Date.now();
  pruneExpired(now);

  const matching: PlaybackSession[] = [];
  const tvDevices: PlaybackSession[] = [];

  for (const session of sessions.values()) {
    if (session.profileId !== profileId) continue;
    if (excludeDeviceId && session.deviceId === excludeDeviceId) continue;
    if (session.deviceType === 'android-tv') {
      tvDevices.push(session);
    }
    if (session.mediaType !== 'idle' && session.title) {
      matching.push(session);
    }
  }

  matching.sort((a, b) => b.updatedAt - a.updatedAt);
  tvDevices.sort((a, b) => b.updatedAt - a.updatedAt);
  return { sessions: matching, tvDevices };
}

export function getPlaybackSession(deviceId: string): PlaybackSession | undefined {
  pruneExpired();
  return sessions.get(deviceId);
}

export function sendRemoteCommand(
  targetDeviceId: string,
  type: RemoteCommandType,
  payload?: { positionMs?: number; deltaMs?: number },
): RemoteCommand {
  const cmd: RemoteCommand = {
    id: crypto.randomUUID(),
    type,
    positionMs: payload?.positionMs,
    deltaMs: payload?.deltaMs,
    createdAt: Date.now(),
  };

  const listeners = subscribers.get(targetDeviceId);
  if (listeners && listeners.size > 0) {
    for (const listener of listeners) {
      try {
        listener(cmd);
      } catch {
        // Ignore broken listener; stream close handler cleans up.
      }
    }
    return cmd;
  }

  const queue = pendingCommands.get(targetDeviceId) || [];
  queue.push(cmd);
  if (queue.length > MAX_QUEUED_COMMANDS) queue.shift();
  pendingCommands.set(targetDeviceId, queue);
  return cmd;
}

export function drainPendingCommands(deviceId: string): RemoteCommand[] {
  const queued = pendingCommands.get(deviceId);
  if (!queued || queued.length === 0) return [];
  pendingCommands.delete(deviceId);
  const cutoff = Date.now() - 20_000;
  return queued.filter((cmd) => cmd.createdAt >= cutoff);
}

export function subscribeRemoteCommands(
  deviceId: string,
  listener: (cmd: RemoteCommand) => void,
): () => void {
  let set = subscribers.get(deviceId);
  if (!set) {
    set = new Set();
    subscribers.set(deviceId, set);
  }
  set.add(listener);

  // Flush any commands queued right before reconnect.
  const queued = pendingCommands.get(deviceId);
  if (queued && queued.length > 0) {
    pendingCommands.delete(deviceId);
    for (const cmd of queued) {
      try {
        listener(cmd);
      } catch {
        break;
      }
    }
  }

  return () => {
    const current = subscribers.get(deviceId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      subscribers.delete(deviceId);
    }
  };
}
