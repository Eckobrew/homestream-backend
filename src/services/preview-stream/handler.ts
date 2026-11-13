import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fetch } from '@/upstream';
import { withParentalControls } from '@/lib/parental-controls';
import { withJellyfinSession, requestJellyfinSession } from '@/lib/jellyfin-session';
import { HttpRequest, HttpResponse } from '@/http';
import { JellyfinClient } from '@/lib/jellyfin';
import { getServerConfig } from '@/lib/config';
import { dataDirectory } from '@/state/database';

const run = promisify(execFile);
const queued = new Map<string, { origin: string; token: string }>();
const failedUntil = new Map<string, number>();
let generating = false;
const maxCacheBytes = 8 * 1024 * 1024 * 1024;
const maxAge = 30 * 24 * 60 * 60_000;
function cacheDir() {
  return path.join(dataDirectory(), "video-previews");
}
async function prunePreviews(checkDeleted = false) {
  const directory = cacheDir();
  const files = await fs.promises.readdir(directory).catch(() => []);
  const entries = (await Promise.all(files.filter((name) => /^[\w-]+\.mp4$/.test(name)).map(async (name) => {
    const file = path.join(directory, name);
    const stat = await fs.promises.stat(file).catch(() => null);
    return stat?.isFile() ? { file, id: name.slice(0, -4), stat } : null;
  }))).filter((entry) => entry !== null);
  entries.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  let total = 0;
  for (const entry of entries) {
    total += entry.stat.size;
    if (total > maxCacheBytes || Date.now() - entry.stat.mtimeMs > maxAge) await fs.promises.unlink(entry.file).catch(() => {
    });
  }
  if (!checkDeleted || entries.length === 0) return;
  const config = getServerConfig();
  if (!config.jellyfinUrl || !config.jellyfinApiKey) return;
  const userId = config.jellyfinUserId || await new JellyfinClient().getFirstUserId();
  if (!userId) return;
  for (let offset = 0; offset < entries.length; offset += 50) {
    const batch = entries.slice(offset, offset + 50);
    const url = new URL(config.jellyfinUrl.replace(/\/+$/, "") + "/Items");
    url.searchParams.set("userId", userId);
    url.searchParams.set("Recursive", "true");
    url.searchParams.set("Ids", batch.map((entry) => entry.id).join(","));
    url.searchParams.set("Limit", String(batch.length));
    const response = await fetch(url.toString(), {
      headers: { Authorization: `MediaBrowser Token="${config.jellyfinApiKey}"` },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return;
    const data = await response.json();
    if (!Array.isArray(data.Items) || data.TotalRecordCount !== data.Items.length) return;
    if (data.Items.some((item: { Id: string }) => typeof item.Id !== "string")) return;
    const available = new Set(data.Items.map((item: { Id: string }) => item.Id.toLowerCase()));
    for (const entry of batch) {
      if (!available.has(entry.id.toLowerCase())) await fs.promises.unlink(entry.file).catch(() => {
      });
    }
  }
}
export function startPreviewCleanup() {
  const cleanup = () => void prunePreviews(true).catch(() => {
  });
  setTimeout(cleanup, 60_000).unref();
  setInterval(cleanup, 60 * 60_000).unref();
}
async function generate() {
  if (generating) return;
  generating = true;
  try {
    while (queued.size) {
      const [id, source] = queued.entries().next().value!;
      const directory = cacheDir();
      const destination = path.join(directory, id + ".mp4");
      const partial = destination + ".tmp";
      try {
        await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
        const input = new URL(source.origin.replace(/\/+$/, "") + "/Videos/" + id + "/stream");
        input.searchParams.set("Static", "true");
        await run(
          "nice",
          [
            "-n",
            "10",
            "ffmpeg",
            "-nostdin",
            "-loglevel",
            "error",
            "-threads",
            "1",
            "-rw_timeout",
            "15000000",
            "-headers",
            `X-Emby-Token: ${source.token}\r
`,
            "-ss",
            "30",
            "-i",
            input.toString(),
            "-map",
            "0:v:0",
            "-an",
            "-sn",
            "-t",
            "12",
            "-vf",
            "scale=480:-2,fps=15",
            "-filter_threads",
            "1",
            "-c:v",
            "libx264",
            "-threads",
            "1",
            "-preset",
            "ultrafast",
            "-crf",
            "25",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            "-fs",
            "4000000",
            "-f",
            "mp4",
            "-y",
            partial
          ],
          { timeout: 45_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 }
        );
        const stat = await fs.promises.stat(partial);
        if (stat.size < 2048) throw new Error("Empty preview");
        await fs.promises.rename(partial, destination);
        await prunePreviews();
      } catch {
        failedUntil.delete(id);
        if (failedUntil.size >= 256) failedUntil.delete(failedUntil.keys().next().value!);
        failedUntil.set(id, Date.now() + 60 * 60_000);
      } finally {
        await fs.promises.unlink(partial).catch(() => {
        });
        queued.delete(id);
      }
      if (queued.size) await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  } finally {
    generating = false;
  }
}
async function handleGET(request: HttpRequest) {
  const id = request.nextUrl.searchParams.get("itemId") || "";
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return HttpResponse.json({ error: "Invalid item ID" }, { status: 400 });
  const file = path.join(cacheDir(), id + ".mp4");
  const stat = await fs.promises.stat(file).catch(() => null);
  if (!stat?.isFile() || stat.size > 4_500_000 || Date.now() - stat.mtimeMs > maxAge) {
    const config = getServerConfig();
    const token = requestJellyfinSession()?.accessToken || config.jellyfinApiKey;
    if (request.method === "GET" && queued.size < 8 && !queued.has(id) && (failedUntil.get(id) || 0) <= Date.now() && config.jellyfinUrl && token && !/[\r\n]/.test(token)) {
      queued.set(id, { origin: config.jellyfinUrl, token });
      void generate();
    }
    return new HttpResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }
  const headers = new Headers({ "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=300" });
  let start = 0, end = stat.size - 1, status = 200;
  const range = request.headers.get("range");
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match?.[1]) {
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
    } else if (match?.[2]) {
      start = Math.max(0, stat.size - Number(match[2]));
    }
    if (!match || !(match[1] || match[2]) || start > end) {
      headers.set("Content-Range", `bytes */${stat.size}`);
      return new HttpResponse(null, { status: 416, headers: headers });
    }
    status = 206;
    headers.set("Content-Range", `bytes ${start}-${end}/${stat.size}`);
  }
  headers.set("Content-Length", String(end - start + 1));
  if (request.method === "HEAD") return new HttpResponse(null, { status, headers: headers });
  const handle = await fs.promises.open(file).catch(() => null);
  if (!handle) return new HttpResponse(null, { status: 204 });
  try {
    const buffer = Buffer.alloc(end - start + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    if (bytesRead !== buffer.length) return new HttpResponse(null, { status: 204 });
    return new HttpResponse(new Uint8Array(buffer), { status, headers: headers });
  } finally {
    await handle.close();
  }
}
export const GET = withJellyfinSession(withParentalControls(handleGET));
