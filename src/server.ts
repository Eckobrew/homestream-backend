import { shutdownConversions } from './media/conversions';
import { createApp } from './app';
import { ensureYouTubeTables, processNextDownload, pollAllSubscribedChannels } from './lib/youtube';
const app = createApp();
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, async () => { shutdownConversions(); await app.close(); });
try {
  await app.listen({ host: process.env.HOST || '0.0.0.0', port: Number(process.env.PORT || '3001') });
  console.info('HomeStream backend listening');
  ensureYouTubeTables();
  processNextDownload();
  const youtubePoller = setInterval(() => {
    pollAllSubscribedChannels().catch(() => {});
  }, 30 * 60 * 1000);
  youtubePoller.unref();
} catch {
  console.error('HomeStream backend failed to start');
  process.exitCode = 1;
}
