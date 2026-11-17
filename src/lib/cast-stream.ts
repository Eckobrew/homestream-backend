import crypto from 'node:crypto';
import { VideoEncodeCapacityError } from '@/media/encode-capacity';
import { HttpRequest, HttpResponse } from '@/http';
import { startNativeHlsTranscode } from './native-transcode';
import { GET as nativeStream } from '@/services/native/stream/handler';
import { parseTvCapabilities } from './tv-playback-profile';
import { h264OutputProfile, streamVideoStrategy, type StreamVideo } from './stream-capabilities';

/** Cast needs addressable HLS segments when seeking a converted torrent, not a restarted MP4 pipe. */
async function createCastStreamResponse(request: HttpRequest, sourceUrl: string, video: StreamVideo | undefined, inputHeaders?: string): Promise<Response> {
  const query = request.nextUrl.searchParams;
  const capabilities = parseTvCapabilities(query.get('videoCapabilities'));
  const strategy = streamVideoStrategy(video, query);
  const copyVideo = strategy.copy && ['h264', 'hevc'].includes(video?.codec_name || '');
  const output = capabilities.find(c => c.codec === (copyVideo ? video?.codec_name : 'h264'));
  const bound = (key: string, fallback: number) => {
    const value = Number(query.get(key));
    return value > 0 && Number.isFinite(value) ? value : fallback;
  };
  const width = Math.min(bound('maxWidth', 3840), output?.width || 1920);
  const height = Math.min(bound('maxHeight', 2160), output?.height || 1080);
  const id = 'cast-stream-' + crypto.createHash('sha256').update(sourceUrl).digest('hex').slice(0, 24);
  const session = await startNativeHlsTranscode({
    file: {
      id, item_id: id, episode_id: null, file_path: sourceUrl, file_size: 0,
      version_label: 'Stream', resolution: '', video_codec: video?.codec_name || '', audio_codec: video?.audio_codec || '',
      has_hdr: 0, duration_ticks: 0, streams_json: JSON.stringify(video ? [video] : []),
      chapters_json: '[]', trickplay_vtt_path: null, updated_at: new Date().toISOString(),
    },
    title: 'Cast stream', profileId: query.get('userId') || 'cast-stream',
    startSeconds: Number(query.get('start') || Number(query.get('startTimeTicks') || 0) / 10000000),
    copyVideo, h264Profile: h264OutputProfile(capabilities), hlsSegmentType: 'fmp4', inputHeaders,
    maxWidth: (video?.width || 0) > width ? width : undefined,
    maxHeight: (video?.height || 0) > height ? height : undefined,
  });
  const url = new URL('/api/native/stream', request.url);
  url.searchParams.set('hls', session.id); url.searchParams.set('segment', 'master.m3u8');
  const response = await nativeStream(new HttpRequest(url, { method: request.method, headers: request.headers, signal: request.signal }));
  if (!response.ok) return response;
  const playlist = (await response.text())
    .replace(/^(\?hls=[^\r\n]+)$/gm, '/api/native/stream$1')
    .replace(/URI="(\?hls=[^"]+)"/g, 'URI="/api/native/stream$1"');
  return new HttpResponse(playlist, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' } });
}

export async function castStreamResponse(request: HttpRequest, sourceUrl: string, video: StreamVideo | undefined, inputHeaders?: string): Promise<Response> {
  try { return await createCastStreamResponse(request, sourceUrl, video, inputHeaders); }
  catch (error) {
    if (error instanceof VideoEncodeCapacityError) return HttpResponse.json({ error: error.message }, { status: 503, headers: { 'Retry-After': '5' } });
    throw error;
  }
}
