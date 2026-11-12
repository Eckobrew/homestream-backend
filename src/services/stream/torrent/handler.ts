import { HttpRequest, HttpResponse } from '@/http';
import { withParentalControls } from '@/lib/parental-controls';
import { RadarrClient } from '@/lib/radarr';
import { SonarrClient } from '@/lib/sonarr';
import { getOrCreateTorrentEngine, resolveTorrentSource, TorrentStreamFile } from '@/lib/torrent-stream-engine';
import { torrentStreamFileResponse } from '@/lib/torrent-stream-reader';
import { isVideoFile } from '@/lib/qbittorrent';
import { startConversion, ConversionCapacityError } from '@/media/conversions';
import { spawn } from 'node:child_process';
import path from 'path';
import { log } from '@/log';

async function probeVideoCodec(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      '-rw_timeout', '10000000',
      url
    ]);
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve(null); }, 4000);
    proc.once('close', () => { clearTimeout(timer); resolve(out.trim().toLowerCase() || null); });
    proc.once('error', () => { clearTimeout(timer); resolve(null); });
  });
}

async function probeDuration(url: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      '-rw_timeout', '10000000',
      url
    ]);
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve(0); }, 4000);
    proc.once('close', () => { clearTimeout(timer); resolve(parseFloat(out.trim()) || 0); });
    proc.once('error', () => { clearTimeout(timer); resolve(0); });
  });
}

async function handleGET(request: HttpRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const magnetParam = searchParams.get('magnet');
    const tmdbIdParam = searchParams.get('tmdbId');
    const typeParam = searchParams.get('type') || 'movie';
    const seasonParam = searchParams.get('season');
    const episodeParam = searchParams.get('episode');
    const titleParam = searchParams.get('title') || '';
    const receiver = searchParams.get('receiver');
    const forceTranscode = searchParams.get('forceTranscode') === 'true' || searchParams.get('transcode') === '1';
    const canPlayHevc = searchParams.get('canPlayHevc') === 'true';
    const sourceParam = searchParams.get('source') === '1';
    const probeParam = searchParams.get('probe') === '1';
    const startSec = parseFloat(searchParams.get('start') || '0');

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

    if (sourceParam) {
      return torrentStreamFileResponse(request, targetFile, types[ext] || 'video/mp4');
    }

    const isDirectWebPlayable = !forceTranscode && receiver !== 'cast' && receiver !== 'native-tv' && (ext === '.mp4' || ext === '.webm');
    const nativeRequest = searchParams.get('native') === '1' && !forceTranscode;

    if (isDirectWebPlayable || nativeRequest) {
      return torrentStreamFileResponse(request, targetFile, types[ext] || 'video/mp4');
    }

    const port = process.env.PORT || '3001';
    const internalHost = process.env.HOMESTREAM_INTERNAL_URL || `http://127.0.0.1:${port}`;
    const sourceUrl = `${internalHost}/api/stream/torrent?magnet=${encodeURIComponent(active.magnet)}&source=1${seasonParam ? `&season=${seasonParam}` : ''}${episodeParam ? `&episode=${episodeParam}` : ''}`;

    if (probeParam) {
      return HttpResponse.json({ durationSeconds: await probeDuration(sourceUrl) });
    }

    if (request.method === 'HEAD') {
      return new HttpResponse(null, {
        status: 200,
        headers: {
          'Content-Type': 'video/mp4',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          Connection: 'keep-alive',
        },
      });
    }

    const detectedCodec = await probeVideoCodec(sourceUrl);

    const ffmpegArgs: string[] = ['-hide_banner', '-loglevel', 'error'];

    if (startSec > 0) {
      ffmpegArgs.push('-ss', startSec.toString());
    }

    ffmpegArgs.push('-rw_timeout', '120000000', '-i', sourceUrl);
    ffmpegArgs.push('-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn');

    if (forceTranscode) {
      ffmpegArgs.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
    } else if (detectedCodec === 'h264') {
      ffmpegArgs.push('-c:v', 'copy');
    } else if (detectedCodec === 'hevc' && canPlayHevc) {
      ffmpegArgs.push('-c:v', 'copy', '-tag:v', 'hvc1');
    } else if (detectedCodec === 'hevc' && !canPlayHevc) {
      ffmpegArgs.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
    } else if (!detectedCodec && ext === '.mkv') {
      ffmpegArgs.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
    } else {
      ffmpegArgs.push('-c:v', 'copy');
    }

    ffmpegArgs.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');

    ffmpegArgs.push(
      '-f',
      'mp4',
      '-movflags',
      'frag_keyframe+empty_moov+default_base_moof',
      'pipe:1'
    );

    let ffmpegProc: ReturnType<typeof startConversion>;
    try {
      ffmpegProc = startConversion(ffmpegArgs, request.signal);
    } catch (error) {
      if (error instanceof ConversionCapacityError) {
        return HttpResponse.json({ error: 'Server is busy converting other streams. Try again shortly.' }, { status: 503, headers: { 'Retry-After': '5' } });
      }
      throw error;
    }

    const stream = new ReadableStream({
      start(controller) {
        ffmpegProc.once('error', error => { try { controller.error(error); } catch {} });
        ffmpegProc.stdout.on('data', (chunk) => {
          try {
            controller.enqueue(chunk);
            if (controller.desiredSize !== null && controller.desiredSize <= 0) {
              ffmpegProc.stdout.pause();
            }
          } catch {}
        });

        ffmpegProc.once('close', (code) => {
          try {
            if (code === 0) controller.close();
            else {
              log.warn('[torrent-stream] FFmpeg exited:', code);
              controller.error(new Error('Torrent stream conversion interrupted'));
            }
          } catch {}
        });

        ffmpegProc.stdout.on('error', (err) => {
          try { controller.error(err); } catch {}
        });

        ffmpegProc.stderr.on('data', (errData) => {
          const msg = errData.toString();
          if (!msg.includes('Output file is empty')) {
            log.warn('[FFmpeg Torrent Warning]', msg);
          }
        });
      },
      pull() {
        if (ffmpegProc.stdout.isPaused()) {
          ffmpegProc.stdout.resume();
        }
      },
      cancel() {
        try { ffmpegProc.kill('SIGKILL'); } catch {}
      },
    });

    request.signal.addEventListener('abort', () => {
      try { ffmpegProc.kill('SIGKILL'); } catch {}
    });

    return new HttpResponse(stream, {
      status: 200,
      headers: {
        'Content-Type': 'video/mp4',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Connection: 'keep-alive',
      },
    });
  } catch (err: any) {
    console.error('[stream/torrent] ERROR:', err);
    return HttpResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}

export const GET = withParentalControls(handleGET);
