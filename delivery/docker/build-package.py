#!/usr/bin/env python3
import pathlib,shutil,hashlib,json,tarfile
root=pathlib.Path('/workspace');out=root/'homestream-delivery';stage=out/'staging';source=root/'homestream-backend/delivery/docker'
assert (stage/'backend/dist/server.js').is_file() and (stage/'web/server.js').is_file()
shutil.copytree(source,stage/'tools/docker',dirs_exist_ok=True,ignore=shutil.ignore_patterns('build-package.py','host-header.sh','test-upgrade.cjs'))
(stage/'.dockerignore').write_text('payload.tar.gz\n.git\n*.run\n')
manifest={'version':'1.1.0','node':'22.23.4','architecture':'linux-x64','layout':'original-monolith-to-docker-split','files':{str(p.relative_to(stage)):hashlib.sha256(p.read_bytes()).hexdigest() for p in stage.rglob('*') if p.is_file() and p.name!='manifest.json'}}
(stage/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
payload=out/'docker-payload.tar.gz'
with tarfile.open(payload,'w:gz',compresslevel=6) as t:
 for p in sorted(stage.iterdir()):t.add(p,arcname=p.name)
sha=hashlib.sha256(payload.read_bytes()).hexdigest();header=(source/'host-header.sh').read_text().replace('@PAYLOAD_SHA256@',sha).encode();package=out/'homestream-docker-upgrade-lxc111.run'
with package.open('wb') as f:
 f.write(header)
 with payload.open('rb') as src:shutil.copyfileobj(src,f)
package.chmod(0o700);(out/(package.name+'.sha256')).write_text(hashlib.sha256(package.read_bytes()).hexdigest()+'  '+package.name+'\n');print(package,package.stat().st_size,'bytes')
