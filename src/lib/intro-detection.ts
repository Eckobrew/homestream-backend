import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { stateDatabase } from '@/state/database';
import { ensureNativeMediaTables, setManualSkipSegments } from './native-media';
import type { SkipSegment } from '@/types';
import { getActiveTranscodeCount } from './native-transcode';

const execFileAsync = promisify(execFile);

export type IntroPreviewEntry = {
  fileId: string;
  itemId: string;
  title: string;
  seriesTitle?: string;
  seasonNumber?: number;
  episodeNumber?: number;
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

async function extractEnvelope(filePath: string): Promise<number[] | null> {
  if (!fs.existsSync(filePath)) return null;
  try {
    const { stdout } = await execFileAsync('ffmpeg', [
      '-v', 'error',
      '-t', '480',
      '-i', filePath,
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

function findRepeatedIntro(a: number[], b: number[]): { startA: number; startB: number; lengthSec: number; confidence: number } | null {
  const minBuckets = 30; // 15 seconds
  const maxBuckets = 260; // 130 seconds
  let bestScore = 0;
  let bestStartA = 0;
  let bestStartB = 0;
  let bestLen = 0;

  // Normalize buckets to zero-mean unit-variance locally? Simple normalized correlation on 30-bucket windows
  const win = 30;
  for (let i = 0; i + win <= Math.min(a.length, 720); i += 2) {
    let meanA = 0;
    for (let k = 0; k < win; k++) meanA += a[i + k];
    meanA /= win;
    let varA = 0;
    for (let k = 0; k < win; k++) varA += (a[i + k] - meanA) ** 2;
    if (varA < 1e-6) continue;

    for (let j = 0; j + win <= Math.min(b.length, 720); j += 2) {
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
      if (corr > 0.82 && corr > bestScore) {
        // Extend forward while matching
        let ext = win;
        while (
          ext < maxBuckets &&
          i + ext < a.length &&
          j + ext < b.length &&
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

  if (bestLen < minBuckets || bestScore < 0.82) return null;
  return {
    startA: bestStartA * 0.5,
    startB: bestStartB * 0.5,
    lengthSec: bestLen * 0.5,
    confidence: Number(Math.min(0.99, bestScore).toFixed(2)),
  };
}

export function startIntroDetectionJob(seriesId?: string): { started: boolean; status: DetectionJobState } {
  if (detectionStatus.running) return { started: false, status: { ...detectionStatus } };
  ensureNativeMediaTables();
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
          const envelopes = new Map<string, number[]>();
          for (const ep of seasonEps.slice(0, 12)) {
            const env = await extractEnvelope(ep.file_path);
            if (env) envelopes.set(ep.file_id, env);
          }
          const ids = [...envelopes.keys()];
          if (ids.length < 2) continue;
          const refId = ids[0];
          const refEnv = envelopes.get(refId)!;
          for (let k = 1; k < ids.length; k++) {
            const curId = ids[k];
            const curEnv = envelopes.get(curId)!;
            const match = findRepeatedIntro(refEnv, curEnv);
            if (match) {
              const now = new Date().toISOString();
              const savePreview = (fileId: string, startSeconds: number, endSeconds: number) => {
                db.prepare('UPDATE native_media_files SET skip_preview_json = ? WHERE id = ?').run(
                  JSON.stringify({
                    confidence: match.confidence,
                    detectedAt: now,
                    segment: { type: 'intro', startSeconds, endSeconds },
                  }),
                  fileId
                );
              };
              savePreview(refId, match.startA, match.startA + match.lengthSec);
              savePreview(curId, match.startB, match.startB + match.lengthSec);
              detectionStatus.detected += 1;
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
    try {
      const parsed = JSON.parse(row.skip_preview_json) as {
        confidence?: number;
        detectedAt?: string;
        segment?: { startSeconds?: number; endSeconds?: number };
      };
      if (!parsed?.segment || typeof parsed.segment.startSeconds !== 'number' || typeof parsed.segment.endSeconds !== 'number') continue;
      out.push({
        fileId: row.file_id,
        itemId: row.item_id,
        title: row.title || row.item_id,
        seriesTitle: row.series_title || undefined,
        seasonNumber: row.season_number ?? undefined,
        episodeNumber: row.episode_number ?? undefined,
        confidence: parsed.confidence ?? 0,
        startSeconds: parsed.segment.startSeconds,
        endSeconds: parsed.segment.endSeconds,
        detectedAt: parsed.detectedAt || new Date().toISOString(),
      });
    } catch {}
  }
  return out;
}

export function approveIntroPreview(fileId: string, startSeconds: number, endSeconds: number): boolean {
  ensureNativeMediaTables();
  const db = stateDatabase();
  const row = db.prepare('SELECT manual_skip_json, chapters_json FROM native_media_files WHERE id = ?').get(fileId) as { manual_skip_json: string | null; chapters_json: string | null } | undefined;
  if (!row) return false;
  let existing: SkipSegment[] = [];
  const baseRaw = row.manual_skip_json || row.chapters_json;
  if (baseRaw) {
    try { existing = JSON.parse(baseRaw) as SkipSegment[]; } catch {}
  }
  const filtered = existing.filter(s => s.type !== 'intro');
  filtered.push({ type: 'intro', startSeconds, endSeconds });
  setManualSkipSegments(fileId, filtered);
  db.prepare('UPDATE native_media_files SET skip_preview_json = NULL WHERE id = ?').run(fileId);
  return true;
}

export function dismissIntroPreview(fileId: string): boolean {
  ensureNativeMediaTables();
  return stateDatabase().prepare('UPDATE native_media_files SET skip_preview_json = NULL WHERE id = ?').run(fileId).changes > 0;
}
