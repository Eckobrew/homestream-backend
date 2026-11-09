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
  destroy: () => void;
}

const engines = new Map<string, ActiveStreamEngine>();

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
    return existing;
  }

  const config = getServerConfig();
  const cachePath = path.join(config.downloadsPath || '/tmp', '.stream-cache');
  if (!fs.existsSync(cachePath)) {
    fs.mkdirSync(cachePath, { recursive: true });
  }

  const engine = (torrentStream as any)(source, {
    tmp: cachePath,
    path: cachePath,
    verify: true,
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
    destroy: () => {
      try {
        engine.destroy();
      } catch {}
      engines.delete(normalizedKey);
    },
  };

  engine.on('ready', () => {
    entry.files = engine.files as TorrentStreamFile[];
    // Deselect all by default, only select when streaming specific range
    engine.files.forEach((f: any) => f.deselect());
    resolveReady();
  });

  engines.set(normalizedKey, entry);

  // Auto cleanup after 30 minutes of inactivity
  setTimeout(() => {
    const current = engines.get(normalizedKey);
    if (current && Date.now() - current.lastAccess > 30 * 60 * 1000) {
      current.destroy();
    }
  }, 35 * 60 * 1000).unref();

  return entry;
}
