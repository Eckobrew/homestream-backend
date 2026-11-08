import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const files = ['openapi.json', 'models.ts', 'paths.d.ts'];
const before = await Promise.all(files.map(file => readFile(`contract/${file}`, 'utf8')));
const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/generate-contract.ts'], { stdio: 'inherit' });
assert.equal(result.status, 0, 'Contract generation failed');
for (let index = 0; index < files.length; index++) assert.equal(await readFile(`contract/${files[index]}`, 'utf8'), before[index], `Regenerate and commit contract/${files[index]}`);
const spec = JSON.parse(before[0]);
const pkg = JSON.parse(await readFile('contract/package.json','utf8'));
assert.equal(spec.info.version, pkg.version);
assert.ok((await readFile('contract/client.ts','utf8')).includes(`API_CONTRACT_VERSION = '${pkg.version}'`));
console.info('Generated contract is current and version-consistent');

const compatibility = spawnSync(process.execPath, ['scripts/compare-contract.mjs'], { stdio: 'inherit' });
assert.equal(compatibility.status, 0, 'Breaking contract change requires a new API major version');
