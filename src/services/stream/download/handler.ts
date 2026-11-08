import { startConversion, ConversionCapacityError } from '@/media/conversions';
import { log } from '@/log';
import { withParentalControls } from '@/lib/parental-controls';
import { HttpRequest, HttpResponse } from '@/http';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { torrentResponse, PieceSource } from '@/lib/torrent-reader';
import { QBittorrentClient, isVideoFile } from '@/lib/qbittorrent';
import { getServerConfig } from '@/lib/config';



function confinedFile(root: string, candidate: string): string | null {
  try {
    const realRoot = fs.realpathSync(root);
    const realFile = fs.realpathSync(candidate);
    const relative = path.relative(realRoot, realFile);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !fs.statSync(realFile).isFile()) return null;
    return realFile;
  } catch { return null; }
}

function findTorrentFilePath(
  downloadsPath: string,
  contentPath: string,
  torrentName: string,
  fileName: string
): string | null {
  const candidates: string[] = [];
  // Translate qBittorrent's mount into our shared downloads mount, preserving
  // the selected file's relative path inside multi-file/season torrents.
  const normalized = fileName.replace(/\\/g, '/');
  const relativeInsideRoot = normalized.startsWith(`${torrentName}/`) ? normalized.slice(torrentName.length + 1) : normalized;
  if (contentPath) {
    if (path.basename(contentPath) === path.basename(normalized)) candidates.push(contentPath);
    candidates.push(path.join(contentPath, relativeInsideRoot));
    const remoteRoot = process.env.QBITTORRENT_DOWNLOADS_PATH;
    const marker = `/${path.basename(downloadsPath)}/`;
    const markerIndex = contentPath.indexOf(marker);
    const translated = remoteRoot && (contentPath === remoteRoot || contentPath.startsWith(`${remoteRoot}/`))
      ? path.join(downloadsPath, path.relative(remoteRoot, contentPath))
      : markerIndex >= 0 ? path.join(downloadsPath, contentPath.slice(markerIndex + marker.length)) : null;
    if (translated) {
      if (path.basename(contentPath) === path.basename(normalized)) candidates.push(translated);
      candidates.push(path.join(translated, relativeInsideRoot));
    }
    const mappedRoot = path.join(downloadsPath, path.basename(contentPath));
    candidates.push(path.join(mappedRoot, relativeInsideRoot));
    if (path.basename(contentPath) === path.basename(normalized)) candidates.push(mappedRoot);
  }
  candidates.push(path.join(downloadsPath, normalized));
  candidates.push(path.join(downloadsPath, torrentName, relativeInsideRoot));
  for (const candidate of candidates) {
    for (const name of [candidate, `${candidate}.!qB`]) {
      const file = confinedFile(downloadsPath, name);
      if (file) return file;
    }
  }

  return null;
}

async function handleGET(request: HttpRequest) {
  const { searchParams } = new URL(request.url);
  const hash = searchParams.get('hash');
  const rawPath = searchParams.get('path');
  const fileIndexParam = searchParams.get('fileIndex');
  const fileIndex = fileIndexParam !== null ? parseInt(fileIndexParam, 10) : undefined;
  const seasonParam = searchParams.get('season');
  const episodeParam = searchParams.get('episode');
  const startSec = parseFloat(searchParams.get('start') || '0');
  const forceTranscode = searchParams.get('transcode') === '1';

  if (!Number.isFinite(startSec) || startSec < 0 ||
      (fileIndexParam !== null && (!/^\d+$/.test(fileIndexParam) || !Number.isSafeInteger(fileIndex))) ||
      [seasonParam, episodeParam].some(value => value !== null && (!/^\d+$/.test(value) || Number(value) < 1 || !Number.isSafeInteger(Number(value))))) {
    return HttpResponse.json({ error: 'Invalid stream parameters' }, { status: 400 });
  }
  const config = getServerConfig();
  const downloadsPath = config.downloadsPath || '/downloads';

  let resolvedPath: string | null = null;
  let isActivelyDownloading = false;
  let targetFileSize = 0;
  let targetFileProgress = 1.0;
  let pieceSource: PieceSource | undefined;
  let selectedFileIndex: number | undefined;
  let torrentHash: string | undefined;

  // Direct-path access is for complete files only; growing torrents need a hash
  // so piece availability can be checked.
  if (rawPath) {
    if (!isVideoFile(rawPath)) return HttpResponse.json({ error: 'Only video files can be streamed' }, { status: 400 });
    if (/\.!qB$/i.test(rawPath)) return HttpResponse.json({ error: 'Use the torrent hash to stream incomplete files safely' }, { status: 400 });
    if (searchParams.get('growing') === '1') return HttpResponse.json({ error: 'Use the torrent hash to stream an incomplete file safely' }, { status: 400 });
    const candidate = path.resolve(downloadsPath, rawPath);
    const safePath = confinedFile(downloadsPath, candidate);
    if (!safePath) return HttpResponse.json({ error: 'Invalid or unavailable file path' }, { status: 403 });
    resolvedPath = safePath;
    targetFileSize = fs.statSync(safePath).size;
    targetFileProgress = isActivelyDownloading ? 0.5 : 1.0;
  } else {
    // 2. Standard torrent hash streaming
    if (!hash) {
      return HttpResponse.json({ error: 'Missing torrent hash or path' }, { status: 400 });
    }

    const client = new QBittorrentClient();
    if (!client.isConfigured()) {
      return HttpResponse.json({ error: 'qBittorrent is not configured' }, { status: 503 });
    }

    // Fetch torrent info
    const rawList = await client.getAllActiveTorrents();
    const torrent = rawList.find((t) => t.hash.toLowerCase() === hash.toLowerCase());

    if (!torrent) {
      return HttpResponse.json({ error: 'Torrent not found' }, { status: 404 });
    }

    // Ensure sequential downloading & first/last piece priority are enabled
    if (!torrent.seq_dl || !torrent.f_l_piece_prio) {
      await client.ensureSequentialAndHeader(torrent.hash, torrent.seq_dl, torrent.f_l_piece_prio);
    }

    // Get file list (handling season packs and multi-file torrents)
    const files = await client.getTorrentFiles(torrent.hash);
    let targetFile = fileIndex !== undefined ? files.find(file => file.index === fileIndex) : undefined;

    // If season and episode are specified, find matching episode file in season pack
    if (!targetFile && (seasonParam || episodeParam)) {
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
        const found = files.find((f) => isVideoFile(f.name) && pattern.test(f.name));
        if (found) {
          targetFile = found;
          break;
        }
      }
    }

    if (!targetFile && (seasonParam || episodeParam || fileIndexParam !== null)) {
      return HttpResponse.json({ error: 'Requested video file not found in torrent' }, { status: 404 });
    }

    // Default: earliest episode if TV season pack, otherwise largest video file
    if (!targetFile) {
      const videoFiles = files.filter((f) => isVideoFile(f.name));
      targetFile = videoFiles.sort((a, b) => {
        const s1 = a.name.match(/s(\d+)e(\d+)/i);
        const s2 = b.name.match(/s(\d+)e(\d+)/i);
        if (s1 && s2) {
          const sDiff = parseInt(s1[1], 10) - parseInt(s2[1], 10);
          if (sDiff !== 0) return sDiff;
          return parseInt(s1[2], 10) - parseInt(s2[2], 10);
        }
        return b.size - a.size;
      })[0];
    }

    if (!targetFile || !isVideoFile(targetFile.name)) {
      return HttpResponse.json({ error: 'No video files found in torrent' }, { status: 404 });
    }

    // Prioritize downloading this specific file (season pack optimization!)
    if (!await client.prioritizeFile(torrent.hash, targetFile.index)) log.warn('[torrent] Could not prioritize selected file');
    selectedFileIndex = targetFile.index;
    torrentHash = torrent.hash;

    resolvedPath = findTorrentFilePath(
      downloadsPath,
      torrent.content_path,
      torrent.name,
      targetFile.name
    );

    if (!resolvedPath) {
      if (targetFile.progress === 0) {
        return HttpResponse.json({ error: 'Waiting for qBittorrent to create the selected video file' }, { status: 425 });
      }
      return HttpResponse.json(
        {
          error: `Torrent file not found in downloads volume (${downloadsPath}). Check your volume mount settings.`,
          torrentName: torrent.name,
          fileName: targetFile.name,
        },
        { status: 404 }
      );
    }

    targetFileSize = targetFile.size;
    targetFileProgress = targetFile.progress;
    isActivelyDownloading = targetFile.progress < 1;
    if (isActivelyDownloading) {
      const pieceSize = await client.getPieceSize(torrent.hash);
      const range = targetFile.piece_range;
      const precedingSize = files.filter(file => file.index < targetFile!.index).reduce((total, file) => total + file.size, 0);
      const offset = range ? Math.max(precedingSize, range[0] * pieceSize) : precedingSize;
      if ((!range && files.length > 1) || !Number.isSafeInteger(pieceSize) || pieceSize <= 0 || !Number.isSafeInteger(offset) || offset < 0 ||
          (range && (Math.floor(offset / pieceSize) !== range[0] || Math.floor((offset + targetFile.size - 1) / pieceSize) !== range[1]))) {
        return HttpResponse.json({ error: 'Cannot determine verified torrent pieces. Wait for the download to complete.' }, { status: 503 });
      }
      pieceSource = { client, hash: torrent.hash, size: pieceSize, offset };
    }
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedPath);
  } catch (err) {
    return HttpResponse.json({ error: 'Cannot access downloading file on disk' }, { status: 500 });
  }

  // Quick probe support: return durationSeconds measured directly by ffprobe
  if (searchParams.get('probe') === '1') {
    if (pieceSource) return HttpResponse.json({ durationSeconds: 0 });
    try {
      const probeProc = spawn('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        resolvedPath,
      ]);
      let out = '';
      probeProc.stdout.on('data', (d) => { out += d.toString(); });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { probeProc.kill('SIGKILL'); reject(new Error('Probe timed out')); }, 10000);
        probeProc.once('error', error => { clearTimeout(timeout); reject(error); });
        probeProc.once('close', () => { clearTimeout(timeout); resolve(); });
      });
      const dur = parseFloat(out.trim());
      if (dur > 0) {
        return HttpResponse.json({ durationSeconds: dur });
      }
    } catch {}
    return HttpResponse.json({ durationSeconds: 0 });
  }

  // Check initial buffer: ensure at least 10MB exists so headers/keyframes are present
  const minBuffer = 10 * 1024 * 1024;
  if (stat.size < minBuffer && targetFileSize > minBuffer && targetFileProgress < 0.01) {
    return HttpResponse.json(
      {
        error: 'Buffering initial pieces. Please wait a few seconds before streaming.',
        progress: targetFileProgress,
      },
      { status: 425 }
    );
  }

  const ext = path.extname(resolvedPath.replace(/\.!qB$/i, '')).toLowerCase();

  // If download is already 100% complete and directly playable (e.g. MP4/AAC)
  const isDirectWebPlayable =
    !isActivelyDownloading &&
    !forceTranscode &&
    (ext === '.mp4' || ext === '.m4v' || ext === '.webm');

  const sourceRequest = searchParams.get('source') === '1';
  const nativeRequest = searchParams.get('native') === '1' && !forceTranscode;
  if (nativeRequest && pieceSource) {
    const states = await pieceSource.client.getPieceStates(pieceSource.hash);
    const firstPiece = Math.floor(pieceSource.offset / pieceSource.size);
    if (!states || firstPiece >= states.length) {
      return HttpResponse.json({ error: 'Cannot read verified torrent pieces from qBittorrent' }, { status: 503 });
    }
    if (states[firstPiece] !== 2) {
      return HttpResponse.json({ error: 'Waiting for the selected video file to buffer' }, { status: 425 });
    }
  }
  if (isDirectWebPlayable || sourceRequest || nativeRequest) {
    const types: Record<string, string> = { '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.ts': 'video/mp2t', '.avi': 'video/x-msvideo', '.mov': 'video/quicktime' };
    return torrentResponse(request, resolvedPath, targetFileSize || stat.size, types[ext] || 'video/mp4', pieceSource);
  }

  // Transcoding / remuxing pipeline using FFmpeg
  // Complete files can be read directly; incomplete sources use verified ranges.
  const ffmpegArgs: string[] = ['-hide_banner', '-loglevel', 'error'];

  if (startSec > 0) {
    ffmpegArgs.push('-ss', startSec.toString());
  }

  if (pieceSource && torrentHash && selectedFileIndex !== undefined) {
    // HTTP byte ranges let FFmpeg seek to MP4 headers while the source endpoint
    // waits for verified pieces. Reading the sparse file directly is unsafe.
    const token = process.env.HOMESTREAM_MOBILE_TOKEN || '';
    if (token.length < 32) return HttpResponse.json({ error: 'Configure mobile streaming credentials before streaming incomplete downloads' }, { status: 503 });
    const sourceUrl = `${process.env.HOMESTREAM_INTERNAL_URL || `http://127.0.0.1:${process.env.PORT || '3001'}`}/api/mobile/v1/stream/download?hash=${encodeURIComponent(torrentHash)}&fileIndex=${selectedFileIndex}&source=1`;
    ffmpegArgs.push('-headers', `Authorization: Bearer ${token}\r\n`, '-rw_timeout', '120000000', '-i', sourceUrl);
  } else ffmpegArgs.push('-i', resolvedPath);

  ffmpegArgs.push('-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn');

  // Video strategy: copy video stream directly (fastest, lossless, zero CPU)
  if (forceTranscode) ffmpegArgs.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
  else ffmpegArgs.push('-c:v', 'copy');

  // Audio strategy: transcode audio to standard stereo AAC for universal browser playback
  ffmpegArgs.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');

  // Output format: Fragmented MP4 (fMP4) playable live without moov header at end
  ffmpegArgs.push(
    '-f',
    'mp4',
    '-movflags',
    'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1'
  );

  let ffmpegProc: ReturnType<typeof startConversion>;
  try { ffmpegProc = startConversion(ffmpegArgs, request.signal); }
  catch (error) {
    if (error instanceof ConversionCapacityError) return HttpResponse.json({ error: 'Server is busy converting other streams. Try again shortly.' }, { status: 503, headers: { 'Retry-After': '5' } });
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
        } catch {
          // Controller might already be closed
        }
      });

      ffmpegProc.once('close', (code) => {
        try {
          if (code === 0) controller.close();
          else { log.warn('[torrent] FFmpeg exited:', code); controller.error(new Error('Download stream conversion interrupted')); }
        } catch {}
      });

      ffmpegProc.stdout.on('error', (err) => {
        try {
          controller.error(err);
        } catch {}
      });

      ffmpegProc.stderr.on('data', (errData) => {
        const msg = errData.toString();
        if (!msg.includes('Output file is empty')) {
          log.warn('[FFmpeg Stream Warning]', msg);
        }
      });
    },
    pull() {
      if (ffmpegProc.stdout.isPaused()) {
        ffmpegProc.stdout.resume();
      }
    },
    cancel() {
      try {
        ffmpegProc.kill('SIGKILL');
      } catch {}
    },
  });

  // Handle client disconnect / aborted connection
  request.signal.addEventListener('abort', () => {
    try {
      ffmpegProc.kill('SIGKILL');
    } catch {}
  });

  return new HttpResponse(stream, {
    status: 200,
    headers: {
      'Content-Type': 'video/mp4',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Connection: 'keep-alive',
    },
  });
}

export const GET = withParentalControls(handleGET);
