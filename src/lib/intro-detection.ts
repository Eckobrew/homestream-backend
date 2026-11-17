import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { stateDatabase } from '@/state/database';
import {
  autoApproveHighConfidenceSkips,
  ensureNativeMediaTables,
  parseSkipPreviewItems,
  serializeSkipPreviewItems,
  setManualSkipSegments,
} from './native-media';
import type { SkipSegment } from '@/types';
import { getActiveTranscodeCount } from './native-transcode';

const execFileAsync = promisify(execFile);

export const AUTO_APPROVE_SKIP_CONFIDENCE = 0.9;

export type IntroPreviewEntry = {
  fileId: string;
  itemId: string;
  title: string;
  seriesTitle?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  type: SkipSegment['type'];
  confidence: number;
  startSeconds: number;
  endSeconds: number;
  detectedAt: string;
};

type DetectionJobState = {
  running: boolean;
  total: number;
  completed: number;
  detected: number;
  currentSeries?: string;
  lastFinishedAt?: string;
};

const detectionStatus: DetectionJobState = {
  running: false,
  total: 0,
  completed: 0,
  detected: 0,
};

type EnvelopeOptions = {
  maxSeconds?: number;
  sseofSeconds?: number;
};

async function extractEnvelope(filePath: string, options: EnvelopeOptions = {}): Promise<number[] | null> {
  if (!fs.existsSync(filePath)) return null;
  const maxSeconds = options.maxSeconds ?? 480;
  try {
    const inputArgs = options.sseofSeconds
      ? ['-sseof', `-${options.sseofSeconds}`, '-t', String(maxSeconds), '-i', filePath]
      : ['-t', String(maxSeconds), '-i', filePath];
    const { stdout } = await execFileAsync('ffmpeg', [
      '-v', 'error',
      ...inputArgs,
      '-vn', '-ac', '1', '-ar', '2000', '-f', 's16le', 'pipe:1',
    ], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024, timeout: 45000 });
    const samplesPerBucket = 1000; // 0.5s per bucket at 2kHz
    const totalSamples = Math.floor(stdout.length / 2);
    const buckets: number[] = [];
    for (let i = 0; i + samplesPerBucket <= totalSamples; i += samplesPerBucket) {
      let sumSq = 0;
      for (let j = 0; j < samplesPerBucket; j++) {
        const s = stdout.readInt16LE((i + j) * 2) / 32768;
        sumSq += s * s;
      }
      buckets.push(Math.sqrt(sumSq / samplesPerBucket));
    }
    return buckets.length >= 60 ? buckets : null;
  } catch {
    return null;
  }
}

type SegmentMatch = { startA: number; startB: number; lengthSec: number; confidence: number };

function findRepeatedSegment(
  a: number[],
  b: number[],
  options: {
    minSec?: number;
    maxSec?: number;
    searchLimitBucketsA?: number;
    searchLimitBucketsB?: number;
    minCorr?: number;
  } = {}
): SegmentMatch | null {
  const minBuckets = Math.max(16, Math.round((options.minSec ?? 15) * 2));
  const maxBuckets = Math.max(minBuckets, Math.round((options.maxSec ?? 130) * 2));
  const limitA = Math.min(a.length, options.searchLimitBucketsA ?? 720);
  const limitB = Math.min(b.length, options.searchLimitBucketsB ?? 720);
  const minCorr = options.minCorr ?? 0.82;
  let bestScore = 0;
  let bestStartA = 0;
  let bestStartB = 0;
  let bestLen = 0;

  // Normalized correlation over sliding 15s (30-bucket) anchor windows
  const win = 30;
  for (let i = 0; i + win <= limitA; i += 2) {
    let meanA = 0;
    for (let k = 0; k < win; k++) meanA += a[i + k];
    meanA /= win;
    let varA = 0;
    for (let k = 0; k < win; k++) varA += (a[i + k] - meanA) ** 2;
    if (varA < 1e-6) continue;

    for (let j = 0; j + win <= limitB; j += 2) {
      let meanB = 0;
      for (let k = 0; k < win; k++) meanB += b[j + k];
      meanB /= win;
      let varB = 0;
      let cov = 0;
      for (let k = 0; k < win; k++) {
        const da = a[i + k] - meanA;
        const db = b[j + k] - meanB;
        varB += db * db;
        cov += da * db;
      }
      if (varB < 1e-6) continue;
      const corr = cov / Math.sqrt(varA * varB);
      if (corr > minCorr && corr > bestScore) {
        let ext = win;
        while (
          ext < maxBuckets &&
          i + ext < limitA &&
          j + ext < limitB &&
          Math.abs(a[i + ext] - b[j + ext]) < 0.08
        ) {
          ext++;
        }
        if (ext >= minBuckets) {
          bestScore = corr;
          bestStartA = i;
          bestStartB = j;
          bestLen = ext;
        }
      }
    }
  }

  if (bestLen < minBuckets || bestScore < minCorr) return null;
  return {
    startA: bestStartA * 0.5,
    startB: bestStartB * 0.5,
    lengthSec: bestLen * 0.5,
    confidence: Number(Math.min(0.99, bestScore).toFixed(2)),
  };
}

function findRepeatedIntro(a: number[], b: number[]): SegmentMatch | null {
  return findRepeatedSegment(a, b, { minSec: 15, maxSec: 130, minCorr: 0.82 });
}

function recordDetectedSkip(
  db: ReturnType<typeof stateDatabase>,
  fileId: string,
  segType: SkipSegment['type'],
  startSeconds: number,
  endSeconds: number,
  confidence: number,
  detectedAt: string
): void {
  if (confidence >= AUTO_APPROVE_SKIP_CONFIDENCE) {
    approveIntroPreview(fileId, startSeconds, endSeconds, segType);
    return;
  }
  const row = db
    .prepare('SELECT skip_preview_json FROM native_media_files WHERE id = ?')
    .get(fileId) as { skip_preview_json: string | null } | undefined;
  const existing = parseSkipPreviewItems(row?.skip_preview_json).filter((p) => p.segment.type !== segType);
  existing.push({
    confidence,
    detectedAt,
    segment: { type: segType, startSeconds, endSeconds },
  });
  db.prepare('UPDATE native_media_files SET skip_preview_json = ? WHERE id = ?').run(
    serializeSkipPreviewItems(existing),
    fileId
  );
}

export { autoApproveHighConfidenceSkips };

export function startIntroDetectionJob(seriesId?: string): { started: boolean; status: DetectionJobState } {
  if (detectionStatus.running) return { started: false, status: { ...detectionStatus } };
  ensureNativeMediaTables();
  autoApproveHighConfidenceSkips(AUTO_APPROVE_SKIP_CONFIDENCE);
  detectionStatus.running = true;
  detectionStatus.total = 0;
  detectionStatus.completed = 0;
  detectionStatus.detected = 0;

  void (async () => {
    try {
      const db = stateDatabase();
      const seriesRows = seriesId
        ? db.prepare("SELECT id, title FROM native_media_items WHERE id = ? AND type = 'Series'").all(seriesId) as Array<{ id: string; title: string }>
        : db.prepare("SELECT id, title FROM native_media_items WHERE type = 'Series'").all() as Array<{ id: string; title: string }>;
      detectionStatus.total = seriesRows.length;

      for (const series of seriesRows) {
        detectionStatus.currentSeries = series.title;
        while (getActiveTranscodeCount() > 0) {
          await new Promise(resolve => setTimeout(resolve, 1500));
        }
        const episodes = db.prepare(`
          SELECT e.id AS ep_id, e.season_number, e.episode_number, f.id AS file_id, f.file_path, f.duration_ticks
          FROM native_media_episodes e
          JOIN native_media_files f ON f.episode_id = e.id
          WHERE e.series_id = ?
          ORDER BY e.season_number ASC, e.episode_number ASC, f.file_size DESC
        `).all(series.id) as Array<{
          ep_id: string;
          season_number: number;
          episode_number: number;
          file_id: string;
          file_path: string;
          duration_ticks: number;
        }>;

        // Deduplicate alternate versions per episode and group by season
        const seenEpIds = new Set<string>();
        const bySeason = new Map<number, typeof episodes>();
        for (const ep of episodes) {
          if (seenEpIds.has(ep.ep_id)) continue;
          seenEpIds.add(ep.ep_id);
          const list = bySeason.get(ep.season_number) || [];
          list.push(ep);
          bySeason.set(ep.season_number, list);
        }

        for (const [, seasonEps] of bySeason) {
          if (seasonEps.length < 2) continue;
          const batchEps = seasonEps.slice(0, 12);
          const epByFileId = new Map(batchEps.map((e) => [e.file_id, e]));
          const envelopes = new Map<string, number[]>();
          const tailEnvelopes = new Map<string, { env: number[]; durationSec: number; tailOffsetSec: number }>();

          for (const ep of batchEps) {
            const env = await extractEnvelope(ep.file_path);
            if (env) envelopes.set(ep.file_id, env);
            const durSec = ep.duration_ticks > 0 ? ep.duration_ticks / 10_000_000 : 0;
            if (durSec >= 300) {
              const tailSec = 240;
              const tailEnv = await extractEnvelope(ep.file_path, { sseofSeconds: tailSec, maxSeconds: tailSec });
              if (tailEnv) {
                const actualTailDur = tailEnv.length * 0.5;
                tailEnvelopes.set(ep.file_id, {
                  env: tailEnv,
                  durationSec: durSec,
                  tailOffsetSec: Math.max(0, durSec - actualTailDur),
                });
              }
            }
          }

          const ids = [...envelopes.keys()];
          if (ids.length >= 2) {
            const refId = ids[0];
            const refEnv = envelopes.get(refId)!;
            for (let k = 1; k < ids.length; k++) {
              const curId = ids[k];
              const curEnv = envelopes.get(curId)!;
              const match = findRepeatedIntro(refEnv, curEnv);
              if (match) {
                const now = new Date().toISOString();
                recordDetectedSkip(db, refId, 'intro', match.startA, match.startA + match.lengthSec, match.confidence, now);
                recordDetectedSkip(db, curId, 'intro', match.startB, match.startB + match.lengthSec, match.confidence, now);
                detectionStatus.detected += 1;

                // Check for a distinct repeated pre-intro recap segment when the intro begins after an opening sequence.
                if (match.startA >= 20 && match.startB >= 20) {
                  const recapMatch = findRepeatedSegment(refEnv, curEnv, {
                    minSec: 12,
                    maxSec: 120,
                    searchLimitBucketsA: Math.floor(match.startA * 2),
                    searchLimitBucketsB: Math.floor(match.startB * 2),
                    minCorr: 0.85,
                  });
                  if (recapMatch) {
                    recordDetectedSkip(db, refId, 'recap', recapMatch.startA, recapMatch.startA + recapMatch.lengthSec, recapMatch.confidence, now);
                    recordDetectedSkip(db, curId, 'recap', recapMatch.startB, recapMatch.startB + recapMatch.lengthSec, recapMatch.confidence, now);
                    detectionStatus.detected += 1;
                  }
                }
              }
            }
          }

          const tailIds = [...tailEnvelopes.keys()];
          if (tailIds.length >= 2) {
            const refTailId = tailIds[0];
            const refTail = tailEnvelopes.get(refTailId)!;
            const refDur = refTail.durationSec || (epByFileId.get(refTailId)?.duration_ticks ?? 0) / 10_000_000;
            for (let k = 1; k < tailIds.length; k++) {
              const curTailId = tailIds[k];
              const curTail = tailEnvelopes.get(curTailId)!;
              const creditsMatch = findRepeatedSegment(refTail.env, curTail.env, {
                minSec: 15,
                maxSec: 180,
                searchLimitBucketsA: refTail.env.length,
                searchLimitBucketsB: curTail.env.length,
                minCorr: 0.84,
              });
              if (creditsMatch) {
                const now = new Date().toISOString();
                const refStart = Number((refTail.tailOffsetSec + creditsMatch.startA).toFixed(2));
                const refEnd = Number(Math.min(refDur || refStart + creditsMatch.lengthSec, refStart + creditsMatch.lengthSec).toFixed(2));
                const curDur = curTail.durationSec || (epByFileId.get(curTailId)?.duration_ticks ?? 0) / 10_000_000;
                const curStart = Number((curTail.tailOffsetSec + creditsMatch.startB).toFixed(2));
                const curEnd = Number(Math.min(curDur || curStart + creditsMatch.lengthSec, curStart + creditsMatch.lengthSec).toFixed(2));
                recordDetectedSkip(db, refTailId, 'credits', refStart, refEnd, creditsMatch.confidence, now);
                recordDetectedSkip(db, curTailId, 'credits', curStart, curEnd, creditsMatch.confidence, now);
                detectionStatus.detected += 1;
              }
            }
          }
        }
        detectionStatus.completed += 1;
      }
    } finally {
      detectionStatus.running = false;
      detectionStatus.currentSeries = undefined;
      detectionStatus.lastFinishedAt = new Date().toISOString();
    }
  })();

  return { started: true, status: { ...detectionStatus } };
}

export function getIntroDetectionStatus(): DetectionJobState {
  return { ...detectionStatus };
}

export function listIntroPreviews(): IntroPreviewEntry[] {
  ensureNativeMediaTables();
  autoApproveHighConfidenceSkips(AUTO_APPROVE_SKIP_CONFIDENCE);
  const db = stateDatabase();
  const rows = db.prepare(`
    SELECT f.id AS file_id, f.item_id, f.skip_preview_json,
           COALESCE(e.name, m.title) AS title,
           s.title AS series_title,
           e.season_number, e.episode_number
    FROM native_media_files f
    LEFT JOIN native_media_episodes e ON e.id = f.episode_id
    LEFT JOIN native_media_items s ON s.id = e.series_id
    LEFT JOIN native_media_items m ON m.id = f.item_id
    WHERE f.skip_preview_json IS NOT NULL
  `).all() as Array<{
    file_id: string;
    item_id: string;
    skip_preview_json: string;
    title: string | null;
    series_title: string | null;
    season_number: number | null;
    episode_number: number | null;
  }>;

  const out: IntroPreviewEntry[] = [];
  for (const row of rows) {
    for (const item of parseSkipPreviewItems(row.skip_preview_json)) {
      out.push({
        fileId: row.file_id,
        itemId: row.item_id,
        title: row.title || row.item_id,
        seriesTitle: row.series_title || undefined,
        seasonNumber: row.season_number ?? undefined,
        episodeNumber: row.episode_number ?? undefined,
        type: item.segment.type,
        confidence: item.confidence,
        startSeconds: item.segment.startSeconds,
        endSeconds: item.segment.endSeconds,
        detectedAt: item.detectedAt,
      });
    }
  }
  return out;
}

export function approveIntroPreview(
  fileId: string,
  startSeconds: number,
  endSeconds: number,
  segmentType?: SkipSegment['type']
): boolean {
  ensureNativeMediaTables();
  const db = stateDatabase();
  const row = db
    .prepare('SELECT manual_skip_json, chapters_json, skip_preview_json FROM native_media_files WHERE id = ?')
    .get(fileId) as { manual_skip_json: string | null; chapters_json: string | null; skip_preview_json: string | null } | undefined;
  if (!row) return false;
  const previews = parseSkipPreviewItems(row.skip_preview_json);
  const matchedPreview = previews.find(
    (p) => Math.abs(p.segment.startSeconds - startSeconds) < 0.05 && Math.abs(p.segment.endSeconds - endSeconds) < 0.05
  );
  const resolvedType: SkipSegment['type'] = segmentType || matchedPreview?.segment.type || 'intro';
  let existing: SkipSegment[] = [];
  const baseRaw = row.manual_skip_json || row.chapters_json;
  if (baseRaw) {
    try { existing = JSON.parse(baseRaw) as SkipSegment[]; } catch {}
  }
  const filtered = existing.filter(s => s.type !== resolvedType);
  filtered.push({ type: resolvedType, startSeconds, endSeconds });
  setManualSkipSegments(fileId, filtered);
  const remaining = previews.filter((p) => p.segment.type !== resolvedType);
  db.prepare('UPDATE native_media_files SET skip_preview_json = ? WHERE id = ?').run(
    serializeSkipPreviewItems(remaining),
    fileId
  );
  return true;
}

export function dismissIntroPreview(fileId: string): boolean {
  ensureNativeMediaTables();
  return stateDatabase().prepare('UPDATE native_media_files SET skip_preview_json = NULL WHERE id = ?').run(fileId).changes > 0;
}
