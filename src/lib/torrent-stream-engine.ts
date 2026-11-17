import torrentStream from 'torrent-stream';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { dataDirectory } from '@/state/database';

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
  const magnet = [release.magnetUrl, release.guid].find(value => value?.startsWith('magnet:'));
  // Fetch the torrent before falling back to a bare hash: its metadata and tracker
  // list are essential for starting without waiting on DHT metadata discovery.
  if (release.downloadUrl && /^https?:\/\//i.test(release.downloadUrl)) {
    try {
      let url = release.downloadUrl;
      const signal = AbortSignal.timeout(15000);
      for (let redirects = 0; redirects <= 5; redirects++) {
        const res = await fetch(url, { redirect: 'manual', signal });
        const location = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && location) {
          await res.body?.cancel();
          if (location.startsWith('magnet:')) return location;
          const next = new URL(location, url);
          if (!['http:', 'https:'].includes(next.protocol)) break;
          url = next.href;
          continue;
        }
        if (res.ok) {
          const data = Buffer.from(await res.arrayBuffer());
          if (data[0] === 100) return data; // A bencoded torrent dictionary.
          const magnet = data.toString('utf8').trim();
          if (magnet.startsWith('magnet:')) return magnet;
        } else {
          await res.body?.cancel();
        }
        break;
      }
    } catch {
      // Do not log indexer URLs: they can contain API keys.
      console.warn('[torrent-stream] Torrent metadata download failed; trying hash discovery');
    }
  }
  if (magnet) return magnet;
  if (release.infoHash && /^[a-fA-F0-9]{40}$/.test(release.infoHash)) {
    const dn = release.title ? `&dn=${encodeURIComponent(release.title)}` : '';
    return `magnet:?xt=urn:btih:${release.infoHash}${dn}`;
  }
  return null;
}

export function getOrCreateTorrentEngine(source: string | Buffer): ActiveStreamEngine {
  const normalizedKey = typeof source === 'string'
    ? source
    : crypto.createHash('sha1').update(source).digest('hex');

  const key = engines.has(normalizedKey) ? normalizedKey
    : [...engines].find(([, entry]) => entry.magnet === normalizedKey)?.[0];
  const existing = key === undefined ? undefined : engines.get(key);
  if (key !== undefined && existing) {
    existing.lastAccess = Date.now();
    // Refresh LRU order
    engines.delete(key);
    engines.set(key, existing);
    return existing;
  }

  ensureSweeper();

  // Evict least-recently-used idle engines when at capacity
  while (engines.size >= MAX_ACTIVE_ENGINES) {
    const oldest = [...engines.values()].find(e => e.activeReaders === 0) || engines.values().next().value;
    if (!oldest) break;
    oldest.destroy();
  }

  const cacheKey = crypto.createHash('sha256').update(normalizedKey).digest('hex');
  const cachePath = path.join(dataDirectory(), '.stream-cache', cacheKey);
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
  let rejectReady: (error: Error) => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  engine.on('error', (error: Error) => rejectReady(error));

  const entry: ActiveStreamEngine = {
    engine,
    magnet: typeof source === 'string' ? source : `magnet:?xt=urn:btih:${engine.infoHash}`,
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
