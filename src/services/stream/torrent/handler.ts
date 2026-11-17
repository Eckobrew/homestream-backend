import { castStreamResponse } from '@/lib/cast-stream';
import { videoEncodeSlotsFromStreams } from '@/media/encode-capacity';
import { prepareHardwareEncoding } from '@/lib/native-hardware';
import { getMediaEngineSettings } from '@/lib/media-settings';
import { probeStreamVideo, streamVideoStrategy, canDirectStreamSource, streamAudioArguments } from '@/lib/stream-capabilities';
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

const releaseLookups = new Map<string, { promise: Promise<string | Buffer | null>; expires: number }>();

async function handleGET(request: HttpRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const magnetParam = searchParams.get('magnet');
    const tmdbIdParam = searchParams.get('tmdbId');
    const typeParam = searchParams.get('type') || 'movie';
    const seasonParam = searchParams.get('season');
    const episodeParam = searchParams.get('episode');
    const titleParam = searchParams.get('title') || '';
    const forceTranscode = searchParams.get('forceTranscode') === 'true' || searchParams.get('transcode') === '1';
    const sourceParam = searchParams.get('source') === '1';
    const probeParam = searchParams.get('probe') === '1';
    const startSec = parseFloat(searchParams.get('start') || String(Number(searchParams.get('startTimeTicks') || 0) / 10000000));

    let torrentSource: string | Buffer | null = magnetParam || null;

    // Share release lookup between browser playback, duration probing and retries.
    if (!torrentSource && tmdbIdParam) {
      const key = JSON.stringify([tmdbIdParam, typeParam, seasonParam, episodeParam, titleParam]);
      let lookup = releaseLookups.get(key);
      if (!lookup || lookup.expires <= Date.now()) {
        const promise = (async (): Promise<string | Buffer | null> => {
          const tmdbId = parseInt(tmdbIdParam, 10);
          if (typeParam === 'movie') {
            const radarr = new RadarrClient();
            if (radarr.isConfigured()) {
              const release = await radarr.getBestRelease(tmdbId);
              if (release) {
                return resolveTorrentSource(release);
              }
            }
          } else {
            const sonarr = new SonarrClient();
            if (sonarr.isConfigured()) {
              const season = seasonParam ? parseInt(seasonParam, 10) : 1;
              const episode = episodeParam ? parseInt(episodeParam, 10) : 1;
              const result = await sonarr.getBestRelease(titleParam || tmdbId, season, episode);
              if (result?.release) {
                return resolveTorrentSource(result.release);
              }
            }
          }
          return null;
        })();
        lookup = { promise, expires: Date.now() + 60_000 };
        releaseLookups.set(key, lookup);
        // Bound cached indexer results without interrupting in-flight callers.
        for (const [cachedKey, cached] of releaseLookups) {
          if (cached.expires <= Date.now() || releaseLookups.size > 100) releaseLookups.delete(cachedKey);
        }
        void promise.then(result => {
          if (!result && releaseLookups.get(key)?.promise === promise) releaseLookups.delete(key);
        }, () => {
          if (releaseLookups.get(key)?.promise === promise) releaseLookups.delete(key);
        });
      }
      torrentSource = await lookup.promise;
    }

    if (!torrentSource) {
      return HttpResponse.json({ error: 'No streamable release found' }, { status: 404 });
    }

    // 2. Initialize in-process streaming engine
    const active = getOrCreateTorrentEngine(torrentSource);

    // Allow a cold swarm time to return metadata before failing startup.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Torrent metadata is not available yet. Please retry shortly.')), 30000);
    });
    try {
      await Promise.race([active.ready, timeout]);
    } catch (err: any) {
      return HttpResponse.json({ error: err?.message || 'Failed connecting to swarm metadata' }, { status: 504 });
    } finally {
      clearTimeout(timer);
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
        ...(files.some(file => /s\d+[._ -]*e\d+|\d+x\d+/i.test(file.name)) ? [] : [
          new RegExp(`\\be0*${epNum}\\b`, 'i'),
          new RegExp(`[._ -]0*${epNum}[._ -]`, 'i'),
        ]),
      ];
      for (const pattern of patterns) {
        const found = files.find(f => isVideoFile(f.name) && pattern.test(f.path || f.name));
        if (found) {
          targetFile = found;
          break;
        }
      }
      if (!targetFile) return HttpResponse.json({ error: 'Requested episode not found in torrent' }, { status: 404 });
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
      return torrentStreamFileResponse(
        request,
        targetFile,
        types[ext] || 'video/mp4',
        () => active.acquireReader(),
        () => active.releaseReader(targetFile),
      );
    }

    const nativeRequest = searchParams.get('native') === '1' && !forceTranscode;

    if (!probeParam && nativeRequest) {
      return torrentStreamFileResponse(
        request,
        targetFile,
        types[ext] || 'video/mp4',
        () => active.acquireReader(),
        () => active.releaseReader(targetFile),
      );
    }

    const port = process.env.PORT || '3001';
    const internalHost = process.env.HOMESTREAM_INTERNAL_URL || `http://127.0.0.1:${port}`;
    const sourceQuery = new URLSearchParams({ magnet: active.magnet, source: '1', type: typeParam });
    if (seasonParam) sourceQuery.set('season', seasonParam);
    if (episodeParam) sourceQuery.set('episode', episodeParam);
    const sourceUrl = `${internalHost}/api/stream/torrent?${sourceQuery}`;

    if (probeParam) {
      return HttpResponse.json({ durationSeconds: await probeDuration(sourceUrl) });
    }

    const sourceVideo = await probeStreamVideo(sourceUrl);
    if (searchParams.get('receiver') === 'cast') return castStreamResponse(request, sourceUrl, sourceVideo);
    if (startSec === 0 && canDirectStreamSource(sourceVideo, searchParams, ext)) {
      return torrentStreamFileResponse(request, targetFile, types[ext] || 'video/mp4',
        () => active.acquireReader(), () => active.releaseReader(targetFile));
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

    const videoStrategy = streamVideoStrategy(sourceVideo, searchParams);

    const ffmpegArgs: string[] = ['-hide_banner', '-loglevel', 'error'];

    if (startSec > 0) {
      ffmpegArgs.push('-ss', startSec.toString());
    }

    ffmpegArgs.push('-rw_timeout', '120000000', '-i', sourceUrl);
    ffmpegArgs.push('-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn');

    ffmpegArgs.push(...videoStrategy.args);

    ffmpegArgs.push(...streamAudioArguments(sourceVideo, searchParams));

    ffmpegArgs.push(
      '-f',
      'mp4',
      '-movflags',
      'frag_keyframe+empty_moov+default_base_moof',
      'pipe:1'
    );

    let ffmpegProc: ReturnType<typeof startConversion>;
    try {
      ffmpegProc = startConversion(await prepareHardwareEncoding(ffmpegArgs, getMediaEngineSettings()), request.signal, 'ffmpeg', videoEncodeSlotsFromStreams(JSON.stringify(sourceVideo ? [sourceVideo] : [])));
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
