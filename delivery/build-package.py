#!/usr/bin/env python3
"""Package already-verified production builds; never read application .env files."""
import hashlib,json,pathlib,shutil,tarfile,subprocess
root=pathlib.Path('/workspace'); out=root/'homestream-delivery'; stage=out/'staging'
if stage.exists(): shutil.rmtree(stage)
(stage/'runtime/bin').mkdir(parents=True)
archive=pathlib.Path('/tmp/homestream-node-v22.23.4-linux-x64.tar.xz')
checks=pathlib.Path('/tmp/homestream-node-SHASUMS256.txt').read_text().splitlines()
expected=next(x.split()[0] for x in checks if x.split()[-1]=='node-v22.23.4-linux-x64.tar.xz')
assert hashlib.sha256(archive.read_bytes()).hexdigest()==expected
with tarfile.open(archive) as t:
 for name,target in [('bin/node','runtime/bin/node'),('LICENSE','runtime/LICENSE')]:
  with t.extractfile('node-v22.23.4-linux-x64/'+name) as src,open(stage/target,'wb') as dst:shutil.copyfileobj(src,dst)
(stage/'runtime/bin/node').chmod(0o755)
b=root/'homestream-backend'; w=root/'homestream-web'
shutil.copytree(b/'dist',stage/'backend/dist')
for name in ['package.json','LICENSE']:shutil.copy2(b/name,stage/'backend'/name)
# Copy package contents without recursively including development-only nested packages.
for line in pathlib.Path('/tmp/homestream-prod-paths.txt').read_text().splitlines()[1:]:
 source=pathlib.Path(line); target=stage/'backend'/source.relative_to(b)
 shutil.copytree(source,target,dirs_exist_ok=True,ignore=shutil.ignore_patterns('node_modules'))
shutil.copytree(w/'.next/standalone',stage/'web')
shutil.copy2(w/'LICENSE',stage/'web/LICENSE')
(stage/'tools').mkdir()
for name in ['inspect.cjs','configure.cjs','verify-state.cjs','upgrade-guest.sh']:shutil.copy2(b/'delivery'/name,stage/'tools'/name)
files={str(p.relative_to(stage)):hashlib.sha256(p.read_bytes()).hexdigest() for p in stage.rglob('*') if p.is_file()}
(stage/'manifest.json').write_text(json.dumps({'version':'1.1.0','node':'22.23.4','architecture':'linux-x64','nodeArchiveSha256':expected,'files':files},indent=2)+'\n')
payload=out/'payload.tar.gz'
with tarfile.open(payload,'w:gz',compresslevel=6) as t:
 for p in sorted(stage.iterdir()):t.add(p,arcname=p.name)
sha=hashlib.sha256(payload.read_bytes()).hexdigest()
header=(b/'delivery/host-header.sh').read_text().replace('@PAYLOAD_SHA256@',sha).encode()
package=out/'homestream-upgrade-lxc111.run'
with package.open('wb') as dst:
 dst.write(header)
 with payload.open('rb') as src:shutil.copyfileobj(src,dst)
package.chmod(0o700)
(out/(package.name+'.sha256')).write_text(hashlib.sha256(package.read_bytes()).hexdigest()+'  '+package.name+'\n')
print(package, package.stat().st_size, 'bytes')
