import { getMediaEngineSettings } from '../lib/media-settings';

let active = 0;
export class VideoEncodeCapacityError extends Error {}
export function videoEncodeMetrics() { return { active, limit: getMediaEngineSettings().maxConcurrentTranscodes }; }

/** Share encoder slots across native HLS, torrents and downloads. Remuxes need no slot. */
export function reserveVideoEncode(requestedSlots = 1): () => void {
  const limit = getMediaEngineSettings().maxConcurrentTranscodes;
  const slots = Math.min(limit, Math.max(1, Math.ceil(requestedSlots)));
  if (active + slots > limit) {
    throw new VideoEncodeCapacityError('All video encoders are busy. Try again shortly.');
  }
  active += slots;
  let released = false;
  return () => { if (!released) { released = true; active -= slots; } };
}

/** 4K and high frame rate sources need more decode/filter headroom, even with GPU encoding. */
export function videoEncodeSlots(width = 0, height = 0, frameRate = 30): number {
  return (width > 1920 || height > 1080 ? 2 : 1) * (frameRate > 30 ? 2 : 1);
}
export function videoEncodeSlotsFromStreams(raw: string | null): number {
  try {
    const video = JSON.parse(raw || '[]').find((stream: { codec_type?: string }) => stream.codec_type === 'video');
    const [numerator, denominator = 1] = String(video?.avg_frame_rate || video?.r_frame_rate || '30').split('/').map(Number);
    return videoEncodeSlots(Number(video?.width) || 0, Number(video?.height) || 0, numerator / denominator || 30);
  } catch { return 1; }
}
