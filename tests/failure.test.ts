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
    writeState('config',{jellyfinUrl:'http://127.0.0.1:1',jellyfinApiKey:'fake-test-key'});
    const failed=await app.inject('/api/v1/home');
    assert.equal(failed.statusCode,503); assert.equal(failed.json().isDemoMode,false); assert.ok(!failed.body.includes('Stranger'));
    assert.match(failed.headers['x-request-id'] as string,/^[a-f0-9-]+$/);
    assert.equal((await app.inject('/health/live')).statusCode,200);
    assert.ok((await app.inject('/health/metrics')).json().upstream.failures>0);
  } finally { await app.close(); closeStateDatabases(); rmSync(directory,{recursive:true,force:true}); }
});
