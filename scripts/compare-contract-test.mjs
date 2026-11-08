import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const current=JSON.parse(await readFile('contract/openapi.json'));
const directory=await mkdtemp(join(tmpdir(),'homestream-contract-'));
try {
  const base=join(directory,'base.json');const candidate=join(directory,'candidate.json');
  await writeFile(base,JSON.stringify(current));
  const changed=structuredClone(current);
  delete changed.paths['/api/mobile/v1/playback'];
  await writeFile(candidate,JSON.stringify(changed));
  assert.notEqual(spawnSync(process.execPath,['scripts/compare-contract.mjs',base,candidate]).status,0);
  changed.info.version='2.0.0';await writeFile(candidate,JSON.stringify(changed));
  assert.equal(spawnSync(process.execPath,['scripts/compare-contract.mjs',base,candidate]).status,0);
  console.info('Breaking operation removal is rejected unless the API major version increases');
} finally {await rm(directory,{recursive:true,force:true});}
