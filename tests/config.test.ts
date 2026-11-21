import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getServerConfig, saveServerConfig } from '../src/lib/config';
import { closeStateDatabases, readState } from '../src/state/database';

test('configuration merges preserve credentials, accept explicit clearing and use environment integrations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'homestream-config-'));
  const previous = { ...process.env };
  process.env.DATA_DIR = directory;
  for (const key of Object.keys(process.env)) {
    if (/^(TMDB_|RADARR_|SONARR_|SLSKD_|BOOKSHELF_|QBITTORRENT_|NEXT_PUBLIC_QBITTORRENT_)/.test(key)) delete process.env[key];
  }
  try {
    process.env.SLSKD_URL = 'http://music.example/';
    assert.equal(getServerConfig().isConfigured, true);
    const saved = saveServerConfig({ slskdUrl: '', radarrUrl: ' http://movies.example/// ', radarrApiKey: 'secret', radarrQualityProfileId: 7 });
    assert.equal(saved.radarrUrl, 'http://movies.example');
    assert.equal(saveServerConfig({ appName: 'Cinema', radarrApiKey: undefined }).radarrApiKey, 'secret');
    assert.equal(getServerConfig().radarrQualityProfileId, 7);
    assert.equal(saveServerConfig({ radarrApiKey: '', tmdbApiKey: '', slskdUrl: '' }).isConfigured, false);
    saveServerConfig({ appName: '', unknownField: 'discard' } as Parameters<typeof saveServerConfig>[0]);
    assert.equal(getServerConfig().appName, 'Cinema');
    assert.equal('unknownField' in readState('config', {}), false);
  } finally {
    closeStateDatabases();
    process.env = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
