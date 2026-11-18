import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/app';
import { closeStateDatabases, writeState } from '../src/state/database';

test('demo mode is explicit and configured upstream failures never substitute sample titles', async () => {
  const directory=mkdtempSync(join(tmpdir(),'homestream-unavailable-'));
  process.env.DATA_DIR=directory; process.env.HOMESTREAM_DEMO_MODE='false';
  const app=createApp();
  try {
    const setup=await app.inject('/api/v1/home');
    assert.equal(setup.statusCode,503); assert.equal(setup.json().isDemoMode,false);
    process.env.HOMESTREAM_DEMO_MODE='true';
    assert.equal((await app.inject('/api/v1/home')).json().isDemoMode,true);
    writeState('config',{qbittorrentUrl:'http://127.0.0.1:1',qbittorrentUsername:'fixture',qbittorrentPassword:'fake-test-password'});
    // Home no longer polls qBittorrent for download playback. An unavailable
    // download manager must not break browsing or bring demo titles back.
    const home=await app.inject('/api/v1/home');
    assert.equal(home.statusCode,200); assert.equal(home.json().isDemoMode,false); assert.ok(!home.body.includes('Stranger'));
    assert.match(home.headers['x-request-id'] as string,/^[a-f0-9-]+$/);
    assert.equal((await app.inject('/health/metrics')).json().upstream.failures,0);
    const failed=await app.inject({url:'/api/v1/config',method:'POST',payload:{action:'test-qbittorrent',url:'http://127.0.0.1:1',username:'fixture',password:'fake-test-password'}});
    assert.equal(failed.statusCode,200); assert.equal(failed.json().success,false);
    assert.equal((await app.inject('/health/live')).statusCode,200);
    assert.ok((await app.inject('/health/metrics')).json().upstream.failures>0);
  } finally { await app.close(); closeStateDatabases(); rmSync(directory,{recursive:true,force:true}); }
});
