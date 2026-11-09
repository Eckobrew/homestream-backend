import { HttpRequest, HttpResponse } from '@/http';
import { withParentalControls } from '@/lib/parental-controls';
import { RadarrClient } from '@/lib/radarr';
import { SonarrClient } from '@/lib/sonarr';
import { getOrCreateTorrentEngine, resolveTorrentSource, TorrentStreamFile } from '@/lib/torrent-stream-engine';
import { torrentStreamFileResponse } from '@/lib/torrent-stream-reader';
import { isVideoFile } from '@/lib/qbittorrent';
import path from 'path';

async function handleGET(request: HttpRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const magnetParam = searchParams.get('magnet');
    const tmdbIdParam = searchParams.get('tmdbId');
    const typeParam = searchParams.get('type') || 'movie';
    const seasonParam = searchParams.get('season');
    const episodeParam = searchParams.get('episode');
    const titleParam = searchParams.get('title') || '';

    let torrentSource: string | Buffer | null = magnetParam || null;

    // 1. If magnet not provided directly, query Radarr or Sonarr for top release
    if (!torrentSource && tmdbIdParam) {
      const tmdbId = parseInt(tmdbIdParam, 10);
      if (typeParam === 'movie') {
        const radarr = new RadarrClient();
        if (radarr.isConfigured()) {
          const release = await radarr.getBestRelease(tmdbId);
          if (release) {
            torrentSource = await resolveTorrentSource(release);
          }
        }
      } else {
        const sonarr = new SonarrClient();
        if (sonarr.isConfigured()) {
          const season = seasonParam ? parseInt(seasonParam, 10) : 1;
          const episode = episodeParam ? parseInt(episodeParam, 10) : 1;
          const result = await sonarr.getBestRelease(titleParam || tmdbId, season, episode);
          if (result?.release) {
            torrentSource = await resolveTorrentSource(result.release);
          }
        }
      }
    }

    if (!torrentSource) {
      return HttpResponse.json({ error: 'No streamable release found' }, { status: 404 });
    }

    // 2. Initialize in-process streaming engine
    const active = getOrCreateTorrentEngine(torrentSource);

    // Wait up to 15s for torrent metadata / file list
    const timeout = new Promise<void>((_, reject) => setTimeout(() => reject(new Error('Torrent metadata timeout')), 15000));
    try {
      await Promise.race([active.ready, timeout]);
    } catch (err: any) {
      return HttpResponse.json({ error: err?.message || 'Failed connecting to swarm metadata' }, { status: 504 });
    }

    const files = active.files;
    if (!files || files.length === 0) {
      return HttpResponse.json({ error: 'No files in torrent swarm' }, { status: 404 });
    }

    // 3. Locate the target video file (with full season pack support!)
    let targetFile: TorrentStreamFile | undefined;

    if (typeParam === 'tv' && (seasonParam || episodeParam)) {
      const sNum = seasonParam ? parseInt(seasonParam, 10) : 1;
      const epNum = episodeParam ? parseInt(episodeParam, 10) : 1;
      const patterns = [
        new RegExp(`s0*${sNum}[._ -]*e0*${epNum}\\b`, 'i'),
        new RegExp(`\\b${sNum}x0*${epNum}\\b`, 'i'),
        new RegExp(`\\be0*${epNum}\\b`, 'i'),
        new RegExp(`[._ -]0*${epNum}[._ -]`, 'i'),
      ];
      for (const pattern of patterns) {
        const found = files.find(f => isVideoFile(f.name) && pattern.test(f.path || f.name));
        if (found) {
          targetFile = found;
          break;
        }
      }
    }

    // Default to largest video file if no specific episode match
    if (!targetFile) {
      const videoFiles = files.filter(f => isVideoFile(f.name));
      if (videoFiles.length > 0) {
        videoFiles.sort((a, b) => b.length - a.length);
        targetFile = videoFiles[0];
      }
    }

    if (!targetFile) {
      return HttpResponse.json({ error: 'No playable video file found in torrent' }, { status: 404 });
    }

    const ext = path.extname(targetFile.name).toLowerCase();
    const types: Record<string, string> = {
      '.mkv': 'video/x-matroska',
      '.webm': 'video/webm',
      '.ts': 'video/mp2t',
      '.avi': 'video/x-msvideo',
      '.mov': 'video/quicktime',
    };

    return torrentStreamFileResponse(request, targetFile, types[ext] || 'video/mp4');
  } catch (err: any) {
    console.error('[stream/torrent] ERROR:', err);
    return HttpResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}

export const GET = withParentalControls(handleGET);
