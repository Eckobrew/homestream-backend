import torrentStream from 'torrent-stream';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { getServerConfig } from './config';

export interface TorrentStreamFile {
  name: string;
  path: string;
  length: number;
  createReadStream: (options?: { start: number; end: number }) => NodeJS.ReadableStream;
  select: () => void;
  deselect: () => void;
}

export interface ActiveStreamEngine {
  engine: any;
  magnet: string;
  files: TorrentStreamFile[];
  ready: Promise<void>;
  lastAccess: number;
  activeReaders: number;
  acquireReader: () => void;
  releaseReader: (file?: TorrentStreamFile) => void;
  destroy: () => void;
}

const engines = new Map<string, ActiveStreamEngine>();
const MAX_ACTIVE_ENGINES = Math.max(1, Number(process.env.HOMESTREAM_MAX_TORRENT_ENGINES || '2') || 2);
const IDLE_WITH_READERS_MS = 10 * 60 * 1000;
const IDLE_NO_READERS_MS = 2 * 60 * 1000;

let sweeperStarted = false;
function ensureSweeper() {
  if (sweeperStarted) return;
  sweeperStarted = true;
  const timer = setInterval(() => {
    const now = Date.now();
    for (const entry of [...engines.values()]) {
      const limit = entry.activeReaders > 0 ? IDLE_WITH_READERS_MS : IDLE_NO_READERS_MS;
      if (now - entry.lastAccess > limit) {
        entry.destroy();
      }
    }
  }, 60_000);
  timer.unref();
}

export async function resolveTorrentSource(release: {
  guid?: string;
  magnetUrl?: string;
  downloadUrl?: string;
  infoHash?: string;
  title?: string;
}): Promise<string | Buffer | null> {
  // 1. Direct magnet in magnetUrl or guid
  if (release.magnetUrl && release.magnetUrl.startsWith('magnet:')) {
    return release.magnetUrl;
  }
  if (release.guid && release.guid.startsWith('magnet:')) {
    return release.guid;
  }
  // 2. Direct infoHash
  if (release.infoHash && /^[a-fA-F0-9]{40}$/.test(release.infoHash)) {
    const dn = release.title ? `&dn=${encodeURIComponent(release.title)}` : '';
    return `magnet:?xt=urn:btih:${release.infoHash}${dn}`;
  }
  // 3. Follow downloadUrl (which may redirect 301/302 to magnet: or return .torrent buffer)
  if (release.downloadUrl && /^https?:\/\//i.test(release.downloadUrl)) {
    try {
      const res = await fetch(release.downloadUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      });
      const location = res.headers.get('location');
      if (location && location.startsWith('magnet:')) {
        return location;
      }
      if (res.status === 200) {
        const arrayBuf = await res.arrayBuffer();
        return Buffer.from(arrayBuf);
      }
    } catch (e) {
      console.warn('[resolveTorrentSource] Failed to fetch downloadUrl:', e);
    }
  }
  return null;
}

export function getOrCreateTorrentEngine(source: string | Buffer): ActiveStreamEngine {
  const normalizedKey = typeof source === 'string'
    ? source.toLowerCase()
    : crypto.createHash('sha1').update(source).digest('hex');

  const existing = engines.get(normalizedKey);
  if (existing) {
    existing.lastAccess = Date.now();
    // Refresh LRU order
    engines.delete(normalizedKey);
    engines.set(normalizedKey, existing);
    return existing;
  }

  ensureSweeper();

  // Evict least-recently-used idle engines when at capacity
  while (engines.size >= MAX_ACTIVE_ENGINES) {
    const oldest = [...engines.values()].find(e => e.activeReaders === 0) || engines.values().next().value;
    if (!oldest) break;
    oldest.destroy();
  }

  const config = getServerConfig();
  const cachePath = path.join(config.downloadsPath || '/tmp', '.stream-cache', normalizedKey.slice(0, 16));
  if (!fs.existsSync(cachePath)) {
    fs.mkdirSync(cachePath, { recursive: true });
  }

  const engine = (torrentStream as any)(source, {
    tmp: cachePath,
    path: cachePath,
    verify: true,
    connections: 25,
    uploads: 2,
  });

  let resolveReady: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const entry: ActiveStreamEngine = {
    engine,
    magnet: typeof source === 'string' ? source : normalizedKey,
    files: [],
    ready: readyPromise,
    lastAccess: Date.now(),
    activeReaders: 0,
    acquireReader: () => {
      entry.activeReaders++;
      entry.lastAccess = Date.now();
    },
    releaseReader: (file?: TorrentStreamFile) => {
      entry.activeReaders = Math.max(0, entry.activeReaders - 1);
      entry.lastAccess = Date.now();
      if (entry.activeReaders === 0 && file) {
        try { file.deselect(); } catch {}
      }
    },
    destroy: () => {
      engines.delete(normalizedKey);
      try {
        engine.remove(() => {});
      } catch {}
      try {
        engine.destroy(() => {
          try { fs.rmSync(cachePath, { recursive: true, force: true }); } catch {}
        });
      } catch {
        try { fs.rmSync(cachePath, { recursive: true, force: true }); } catch {}
      }
    },
  };

  engine.on('ready', () => {
    entry.files = engine.files as TorrentStreamFile[];
    // Deselect all by default, only select when streaming specific range
    engine.files.forEach((f: any) => f.deselect());
    resolveReady();
  });

  engines.set(normalizedKey, entry);

  return entry;
}
