import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importLegacyState, readState, stateDatabase, closeStateDatabases } from '../src/state/database';
import { registeredDevice } from '../src/lib/devices';

test('explicit transactional import preserves identities, rejects bad policy, hashes tokens and retries safely', () => {
  const directory = mkdtempSync(join(tmpdir(),'homestream-import-'));
  const token = 'hst_dev_'+'a'.repeat(48);
  process.env.DATA_DIR = directory;
  try {
    writeFileSync(join(directory,'profiles.json'),JSON.stringify([{ id:'kid',name:'Child',isKids:true,kidsRating:'PG' }]));
    assert.throws(() => stateDatabase(),/explicit import/);
    assert.throws(() => importLegacyState(directory),/PIN/);
    writeFileSync(join(directory,'parental-controls.json'),JSON.stringify({ salt:'a'.repeat(32),hash:'b'.repeat(64),policies:{} }));
    writeFileSync(join(directory,'devices.json'),JSON.stringify({ [token]: { token,deviceId:'phone',client:'android',pairedLocally:true,activeProfileId:'kid' } }));
    const result = importLegacyState(directory);
    assert.ok(result.imported); assert.ok(result.backup);
    assert.equal(importLegacyState(directory).imported,false);
    assert.equal(registeredDevice(token)?.activeProfileId,'kid');
    assert.ok(!readFileSync(join(directory,'homestream.sqlite')).includes(Buffer.from(token)));
    assert.equal(readState<{id:string}[]>('profiles',[])[0].id,'kid');
    const backup=join(directory,'snapshot.sqlite');
    execFileSync(process.execPath,['dist/backup-state.js',backup],{env:{...process.env,DATA_DIR:directory}});
    assert.equal(statSync(backup).mode & 0o777,0o600);
    const snapshot=new DatabaseSync(backup,{readOnly:true});
    try { assert.ok(String(snapshot.prepare("SELECT value FROM documents WHERE kind='profiles'").get()?.value).includes('kid')); } finally {snapshot.close();}
    writeFileSync(join(directory,'profiles.json'),'[]');
    assert.throws(() => importLegacyState(directory),/already exists/);
    assert.equal(readState<{id:string}[]>('profiles',[])[0].id,'kid');
  } finally { closeStateDatabases(); rmSync(directory,{ recursive:true,force:true }); }
});
