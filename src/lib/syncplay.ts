import crypto from 'crypto';

export interface SyncPlayParticipant {
  profileId: string;
  name: string;
  joinedAt: string;
  lastSeenAt: string;
}

export interface SyncPlayRoom {
  code: string;
  hostProfileId: string;
  itemId: string;
  episodeId?: string;
  title: string;
  positionTicks: number;
  isPaused: boolean;
  playbackRate: number;
  updatedAt: number;
  participants: SyncPlayParticipant[];
}

const rooms = new Map<string, SyncPlayRoom>();
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;

function positionAt(room: SyncPlayRoom, now: number): number {
  if (room.isPaused) return room.positionTicks;
  return room.positionTicks + Math.round(Math.max(0, now - room.updatedAt) * 10_000 * room.playbackRate);
}

function cleanupStaleRooms() {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - room.updatedAt > ROOM_TTL_MS || room.participants.length === 0) {
      rooms.delete(code);
    }
  }
}

export function createSyncPlayRoom(input: {
  hostProfileId: string;
  hostName: string;
  itemId: string;
  episodeId?: string;
  title: string;
  positionTicks?: number;
  isPaused?: boolean;
}): SyncPlayRoom {
  cleanupStaleRooms();
  const code = crypto.randomBytes(3).toString('hex').toUpperCase();
  const nowIso = new Date().toISOString();
  const room: SyncPlayRoom = {
    code,
    hostProfileId: input.hostProfileId,
    itemId: input.itemId,
    episodeId: input.episodeId,
    title: input.title,
    positionTicks: input.positionTicks || 0,
    isPaused: input.isPaused ?? true,
    playbackRate: 1,
    updatedAt: Date.now(),
    participants: [
      {
        profileId: input.hostProfileId,
        name: input.hostName || 'Host',
        joinedAt: nowIso,
        lastSeenAt: nowIso,
      },
    ],
  };
  rooms.set(code, room);
  return room;
}

function findRoom(code: string): SyncPlayRoom | null {
  cleanupStaleRooms();
  return rooms.get(code.trim().toUpperCase()) || null;
}

function snapshot(room: SyncPlayRoom): SyncPlayRoom {
  const now = Date.now();
  return { ...room, positionTicks: positionAt(room, now), updatedAt: now };
}

export function getSyncPlayRoom(code: string): SyncPlayRoom | null {
  const room = findRoom(code);
  return room ? snapshot(room) : null;
}

export function joinSyncPlayRoom(code: string, profileId: string, name: string): SyncPlayRoom | null {
  const room = findRoom(code);
  if (!room) return null;
  const nowIso = new Date().toISOString();
  const existing = room.participants.find((p) => p.profileId === profileId);
  if (existing) {
    existing.lastSeenAt = nowIso;
    existing.name = name || existing.name;
  } else {
    room.participants.push({
      profileId,
      name: name || 'Viewer',
      joinedAt: nowIso,
      lastSeenAt: nowIso,
    });
  }
  return snapshot(room);
}

export function leaveSyncPlayRoom(code: string, profileId: string): boolean {
  const room = findRoom(code);
  if (!room) return false;
  room.participants = room.participants.filter((p) => p.profileId !== profileId);
  if (room.participants.length === 0) {
    rooms.delete(room.code);
  }
  return true;
}

export function updateSyncPlayRoom(
  code: string,
  profileId: string,
  patch: {
    positionTicks?: number;
    isPaused?: boolean;
    playbackRate?: number;
    itemId?: string;
    episodeId?: string;
    title?: string;
  }
): SyncPlayRoom | null {
  const room = findRoom(code);
  if (!room) return null;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const participant = room.participants.find((p) => p.profileId === profileId);
  if (!participant) return null;
  participant.lastSeenAt = nowIso;

  room.positionTicks = typeof patch.positionTicks === 'number' ? Math.max(0, patch.positionTicks) : positionAt(room, now);
  if (typeof patch.isPaused === 'boolean') room.isPaused = patch.isPaused;
  if (typeof patch.playbackRate === 'number') room.playbackRate = Math.max(0.5, Math.min(2, patch.playbackRate));
  if (patch.itemId) room.itemId = patch.itemId;
  if (patch.episodeId !== undefined) room.episodeId = patch.episodeId;
  if (patch.title) room.title = patch.title;
  room.updatedAt = now;
  return room;
}
