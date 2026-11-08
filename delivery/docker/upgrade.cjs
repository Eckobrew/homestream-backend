'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),http=require('node:http'),crypto=require('node:crypto');
const args=process.argv.slice(2),mode=args.shift()||'--inspect',payload=path.resolve(__dirname,'../..');
const option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const docker=['--host=unix:///var/run/docker.sock'];let apiVersion='';
function d(...a){return cp.execFileSync('docker',[...docker,...a],{encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:64*1024*1024}).trim();}
function inspect(name){return JSON.parse(d('inspect',name))[0];}
function save(file,value){fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});}
function envOf(list){return Object.fromEntries((list||[]).map(v=>{const i=v.indexOf('=');return [v.slice(0,i),v.slice(i+1)];}));}
function api(route,body){return new Promise((resolve,reject)=>{const req=http.request({socketPath:'/var/run/docker.sock',path:'/v'+apiVersion+route,method:'POST',headers:{'Content-Type':'application/json'}},r=>{let text='';r.on('data',c=>text+=c);r.on('end',()=>r.statusCode<300?resolve(text?JSON.parse(text):{}):reject(Error('Docker create failed; see private request and log.')));});req.on('error',reject);req.end(JSON.stringify(body));});}
function logged(receipt,label,program,a){const fd=fs.openSync(path.join(receipt,label+'.log'),'a',0o600);try{cp.execFileSync(program,a,{stdio:['ignore',fd,fd]});}finally{fs.closeSync(fd);}}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function healthy(name,route,port){for(let i=0;i<45;i++){try{d('exec',name,'node','-e',`fetch('http://127.0.0.1:${port}${route}').then(async r=>{if(!r.ok)process.exit(1);console.log(await r.text())}).catch(()=>process.exit(1))`);return;}catch{}await wait(1000);}throw Error('Service health check failed: '+name);}
async function rollback(receipt){const r=JSON.parse(fs.readFileSync(path.join(receipt,'rollback.json'),'utf8'));
 for(const name of r.newNames){let container;try{container=inspect(name);}catch{continue;}if(container.Id!==r.oldId)d('rm','-f',container.Id);}
 const old=inspect(r.oldId);
 if(old.Name!=='/'+r.oldName)d('rename',r.oldId,r.oldName);
 for(const [network,endpoint]of Object.entries(r.networks)){if(!inspect(r.oldId).NetworkSettings.Networks[network]){
  const a=['network','connect'];for(const alias of endpoint.Aliases||[])if(alias!==r.oldId&&alias!==r.oldId.slice(0,12))a.push('--alias',alias);
  if(endpoint.IPAMConfig?.IPv4Address)a.push('--ip',endpoint.IPAMConfig.IPv4Address);
  if(endpoint.IPAMConfig?.IPv6Address)a.push('--ip6',endpoint.IPAMConfig.IPv6Address);
  d(...a,network,r.oldId);
 }}
 d('update','--restart',r.restart,r.oldId);d('start',r.oldId);
 fs.writeFileSync(path.join(receipt,'status'),'rolled-back\n');console.log('Original Docker container restored with its original state.');
}
async function main(){
 if(process.getuid()!==0)throw Error('Run as root inside the LXC, or use the Proxmox wrapper.');
 if(mode==='--rollback'){const receipt=option('--receipt');if(!receipt||!/^\/root\/homestream-docker-upgrades\/[0-9TZ-]+$/.test(receipt))throw Error('Invalid rollback receipt');await rollback(receipt);return;}
 if(!['--inspect','--upgrade'].includes(mode))throw Error('Use --inspect, --upgrade or --rollback.');
 d('info','--format','{{.Architecture}}');apiVersion=d('version','--format','{{.Server.APIVersion}}');if(!/^1\.\d+$/.test(apiVersion))throw Error('Cannot identify Docker Engine API version.');
 let name=option('--container');
 if(!name){const candidates=d('ps','--format','{{.Names}}').split('\n').filter(n=>/home(stream|flix)/i.test(n)&&!/(web|gateway|nginx)/i.test(n));if(candidates.length!==1){console.log('Running containers (names/images/ports only):');console.log(d('ps','--format','{{.Names}}\t{{.Image}}\t{{.Ports}}'));throw Error('Choose one application container with --container NAME.');}name=candidates[0];}
 const old=inspect(name);name=old.Name.slice(1);
 if(!old.State.Running)throw Error('The selected container must be running.');
 if(old.HostConfig.AutoRemove)throw Error('AutoRemove containers cannot be retained for rollback.');
 if(!['bridge','default'].includes(old.HostConfig.NetworkMode)&&!Object.keys(old.NetworkSettings.Networks).includes(old.HostConfig.NetworkMode))throw Error('Host/container networking requires manual migration.');
 if(!old.Config.Image||old.Config.Labels?.['homestream.upgrade.receipt'])throw Error('This container was already created by this installer.');
 const env=envOf(old.Config.Env);
 const details=JSON.parse(d('exec',old.Id,'node','-e',`const fs=require('fs'),p=require('path'),root=process.cwd();const pkg=JSON.parse(fs.readFileSync(p.join(root,'package.json'),'utf8'));const dirs=[process.env.DATA_DIR,p.join(root,'data'),'/tmp/homeflix-data','/tmp/homestream-data'].filter(Boolean).map(x=>p.resolve(root,x));const populated=[...new Set(dirs)].filter(x=>['config.json','profiles.json','devices.json','parental-controls.json','homestream.sqlite'].some(f=>fs.existsSync(p.join(x,f))));const dot={};for(const n of ['.env','.env.production','.env.local','.env.production.local'])if(fs.existsSync(p.join(root,n)))dot[n]=fs.readFileSync(p.join(root,n),'utf8');console.log(JSON.stringify({root,pkg,populated,dot,explicit:process.env.DATA_DIR?p.resolve(root,process.env.DATA_DIR):null}));`));
 if(!/home(stream|flix)/i.test(details.pkg.name||''))throw Error('Container package identity does not match HomeStream/HomeFlix.');
 const layout=option('--layout')||(details.pkg.dependencies?.next?'monolith':'backend');
 if(layout!=='monolith')throw Error('This package upgrades the original all-in-one container only.');
 const settings={};for(const text of Object.values(details.dot))Object.assign(settings,require('node:util').parseEnv(text));Object.assign(settings,env);
 const dataDir=option('--data-dir')||details.explicit||(settings.DATA_DIR?path.resolve(details.root,settings.DATA_DIR):null)||(details.populated.length===1?details.populated[0]:null);
 if(!dataDir||!path.isAbsolute(dataDir)||dataDir==='/')throw Error('State directory is missing or ambiguous. Specify --data-dir with the absolute path INSIDE the old container.');
 if(Object.keys(old.HostConfig.Tmpfs||{}).some(p=>dataDir===p||dataDir.startsWith(p+'/'))||old.Mounts.some(m=>m.Type==='tmpfs'&&(dataDir===m.Destination||dataDir.startsWith(m.Destination+'/'))))throw Error('State is held in tmpfs and would disappear on stop. Move it to persistent storage first.');
 if(details.populated.length>1&&!option('--data-dir')&&!details.explicit)throw Error('Multiple state directories found; select --data-dir explicitly.');
 const bindings=old.HostConfig.PortBindings||{};
 if(layout==='monolith'&&(Object.keys(bindings).length!==1||!Object.keys(bindings)[0].endsWith('/tcp')||!bindings[Object.keys(bindings)[0]]?.length))throw Error('All-in-one migration requires exactly one published TCP container port.');
 if(!dataDir.startsWith(details.root+'/data')&&!details.populated.includes(dataDir)&&!details.explicit&&!option('--data-dir'))throw Error('State location requires explicit selection.');
 if(old.Mounts.some(m=>dataDir.startsWith(m.Destination+'/')))throw Error('State is nested in a broader volume mount; explicit migration review is required.');
 if(old.Mounts.some(m=>(m.Destination==='/app'||m.Destination===details.root)||('/app/data'.startsWith(m.Destination+'/')&&m.Destination!==dataDir)))throw Error('An application-code mount needs manual review.');
 console.log(JSON.stringify({container:name,image:old.Config.Image,layout,dataDirectory:dataDir,publishedPorts:bindings,mounts:old.Mounts.map(m=>({type:m.Type,destination:m.Destination})),composeService:old.Config.Labels?.['com.docker.compose.service']||null},null,2));
 if(mode==='--inspect')return;
 if(d('ps','--format','{{.Image}}').split('\n').some(image=>/watchtower/i.test(image)))throw Error('Pause the running Watchtower updater before migrating; it could replace the retained rollback container.');
 if(old.HostConfig.RestartPolicy.Name==='always'&&old.Config.Labels?.['com.docker.swarm.service.id'])throw Error('Swarm services require a stack migration.');
 if(old.Config.Labels?.['com.centurylinklabs.watchtower.enable']==='true')throw Error('Disable automatic Watchtower updates for this container before migration.');
 const id=new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d+Z$/,'Z')+'-'+process.pid;
 const receipt='/root/homestream-docker-upgrades/'+id;fs.mkdirSync(receipt,{recursive:true,mode:0o700});save(receipt+'/original-inspect.json',old);
 const free=fs.statfsSync(receipt);if(free.bavail*free.bsize<2*1024**3)throw Error('At least 2 GiB free is required in the LXC before building Docker images.');
 const sizeKb=Number(d('exec',old.Id,'du','-sk',dataDir).split(/\s/)[0]);if(!Number.isFinite(sizeKb)||free.bavail*free.bsize<sizeKb*4096+1024**3)throw Error('Insufficient space for three state copies plus build headroom.');
 const tag='homestream-local-'+id.toLowerCase(),network=tag,names=layout==='monolith'?[name,tag+'-backend',tag+'-web']:[name];
 const restart=old.HostConfig.RestartPolicy.Name==='on-failure'?'on-failure'+(old.HostConfig.RestartPolicy.MaximumRetryCount?':'+old.HostConfig.RestartPolicy.MaximumRetryCount:''):old.HostConfig.RestartPolicy.Name||'no';
 save(receipt+'/rollback.json',{oldId:old.Id,oldName:name,restart,networks:old.NetworkSettings.Networks,newNames:names});
 fs.writeFileSync(receipt+'/rollback.sh',`#!/bin/sh\nexec '${process.execPath}' '${__filename}' --rollback --receipt '${receipt}'\n`,{mode:0o700});
 console.log('Receipt: '+receipt+'\nBuilding Docker images from bundled production files; the original container stays running.');
 logged(receipt,'build-backend','docker',[...docker,'build','-f',payload+'/tools/docker/Dockerfile.backend','-t',tag+'-backend',payload]);
 if(layout==='monolith')logged(receipt,'build-web','docker',[...docker,'build','-f',payload+'/tools/docker/Dockerfile.web','-t',tag+'-web',payload]);
 if(layout==='monolith')logged(receipt,'pull-gateway','docker',[...docker,'pull','nginxinc/nginx-unprivileged:1.28-alpine']);
 const state=receipt+'/data';fs.mkdirSync(state,{mode:0o700});
 let cutover=false;
 try{
  // Disable the old restart policy before stopping; never delete the original container or volumes.
  cutover=true;d('update','--restart','no',old.Id);d('stop','--time','30',old.Id);
  d('cp',old.Id+':'+dataDir+'/.',state);
  for(const entry of fs.readdirSync(state)){if(fs.lstatSync(path.join(state,entry)).isSymbolicLink())throw Error('Symlinked application state requires manual review.');}
  logged(receipt,'state-backup','tar',['-C',state,'-cpf',receipt+'/state-before.tar','.']);
  const legacy=receipt+'/legacy';fs.mkdirSync(legacy,{mode:0o700});logged(receipt,'legacy-copy','tar',['-C',legacy,'-xpf',receipt+'/state-before.tar']);
  const config=fs.existsSync(state+'/config.json')?JSON.parse(fs.readFileSync(state+'/config.json','utf8')):{};
  const oldNetworks=old.NetworkSettings.Networks;
  d('rename',old.Id,name+'-before-'+id.toLowerCase());
  for(const net of Object.keys(oldNetworks))d('network','disconnect',net,old.Id);
  let gatewayIp='';
  if(layout==='monolith'){
   d('network','create',network);const n=inspect(network);const subnet=n.IPAM.Config.find(c=>c.Subnet?.includes('.'))?.Subnet;if(!subnet)throw Error('Cannot determine private network IPv4 subnet');const oct=subnet.split('/')[0].split('.').map(Number);let address=oct.reduce((v,x)=>v*256+x,0)+2;gatewayIp=[24,16,8,0].map(s=>Math.floor(address/2**s)%256).join('.');
  }
  const upstream=(settings.HOMESTREAM_TRUSTED_PROXIES||'').split(',').map(x=>x.trim()).filter(Boolean);
  if(layout==='monolith'){
   const plan={settings,upstreamProxies:upstream,legacyTrustProxy:settings.HOMESTREAM_TRUST_PROXY==='true',loopbackOnly:false,port:8080,appName:config.appName||settings.APP_NAME||'HomeStream'};save(receipt+'/plan.json',plan);
   logged(receipt,'configure',process.execPath,[payload+'/tools/configure.cjs',receipt+'/plan.json',receipt,receipt]);
   let conf=fs.readFileSync(receipt+'/nginx.conf','utf8').replaceAll('http://127.0.0.1:3001','http://backend:3001').replaceAll('http://127.0.0.1:3002','http://web:3002');fs.writeFileSync(receipt+'/nginx.conf',conf,{mode:0o644});
  }
  const nextEnv={...settings,NODE_ENV:'production',HOST:'0.0.0.0',DATA_DIR:'/app/data',PORT:layout==='monolith'?'3001':settings.PORT||'3001'};
  if(layout==='monolith'){nextEnv.HOMESTREAM_TRUSTED_PROXIES=gatewayIp;nextEnv.HOMESTREAM_INTERNAL_URL='http://127.0.0.1:3001';delete nextEnv.HOMESTREAM_TRUST_PROXY;}
  if(!nextEnv.HOMESTREAM_SESSION_SECRET&&!(nextEnv.HOMESTREAM_MOBILE_TOKEN||'').length)nextEnv.HOMESTREAM_SESSION_SECRET=crypto.randomBytes(32).toString('hex');
  const environment=Object.entries(nextEnv).map(([k,v])=>k+'='+v);
  fs.writeFileSync(receipt+'/runtime.env',environment.join('\n')+'\n',{mode:0o600});
  // Import as root into the COPY, then hand only the copied state to uid 1001.
  if(!fs.existsSync(state+'/homestream.sqlite')&&['config.json','profiles.json','devices.json','parental-controls.json'].some(f=>fs.existsSync(state+'/'+f)))logged(receipt,'migration','docker',[...docker,'run','--rm','--user','0','-v',state+':/app/data',tag+'-backend','node','dist/import-state.js','/app/data']);
  else if(fs.existsSync(state+'/homestream.sqlite'))logged(receipt,'sqlite-integrity',process.execPath,['-e',`const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1],{readOnly:true});if(d.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('State corruption');d.close()`,state+'/homestream.sqlite']);
  if(['config.json','profiles.json','devices.json','parental-controls.json'].some(f=>fs.existsSync(legacy+'/'+f))&&!fs.existsSync(legacy+'/homestream.sqlite'))logged(receipt,'verify-migration',process.execPath,[payload+'/tools/verify-state.cjs',legacy,state]);
  logged(receipt,'state-permissions','docker',[...docker,'run','--rm','--user','0','-v',state+':/app/data',tag+'-backend','chown','-R','1001:1001','/app/data']);
  const host=structuredClone(old.HostConfig);delete host.ContainerIDFile;host.AutoRemove=false;host.RestartPolicy={Name:'unless-stopped'};
  // Retain read-only media mounts/devices/resources; remove only the old state mount and code overrides.
  host.Binds=[];host.Mounts=old.Mounts.filter(m=>m.Destination!==dataDir&&m.Type!=='tmpfs').map(m=>{
   if(!['bind','volume'].includes(m.Type))throw Error('Unsupported mount type: '+m.Type);
   return {Type:m.Type,Source:m.Type==='volume'?m.Name:m.Source,Target:m.Destination,ReadOnly:!m.RW,...(m.Type==='bind'&&m.Propagation?{BindOptions:{Propagation:m.Propagation}}:{})};
  });
  host.Binds.push(state+':/app/data');host.Tmpfs=Object.fromEntries(Object.entries(host.Tmpfs||{}).filter(([target])=>target!==dataDir));
  const endpoints={};for(const [net,e]of Object.entries(oldNetworks))endpoints[net]={Aliases:layout==='backend'?e.Aliases:[],...(e.IPAMConfig?{IPAMConfig:e.IPAMConfig}:{})};
  const image=inspect(tag+'-backend');
  const request={Image:tag+'-backend',Env:environment,WorkingDir:'/app',User:'1001:1001',Cmd:image.Config.Cmd,Entrypoint:image.Config.Entrypoint,Healthcheck:image.Config.Healthcheck,Labels:{...Object.fromEntries(Object.entries(old.Config.Labels||{}).filter(([key])=>!key.startsWith('com.docker.compose.'))),'homestream.upgrade.receipt':receipt},HostConfig:host,NetworkingConfig:{EndpointsConfig:endpoints}};
  if(layout==='monolith'){
   host.NetworkMode=network;host.PortBindings={};delete host.PublishAllPorts;request.NetworkingConfig.EndpointsConfig={[network]:{Aliases:['backend']}};
   // Attach old networks for Jellyfin/Seerr/qBittorrent DNS, using fresh addresses for the backend.
   for(const net of Object.keys(oldNetworks))request.NetworkingConfig.EndpointsConfig[net]={};
  }
  save(receipt+'/backend-create.json',request);await api('/containers/create?name='+encodeURIComponent(layout==='backend'?name:tag+'-backend'),request);
  d('start',layout==='backend'?name:tag+'-backend');await healthy(layout==='backend'?name:tag+'-backend','/health/ready',Number(nextEnv.PORT));
  if(config.qbittorrentUrl||nextEnv.QBITTORRENT_URL||nextEnv.NEXT_PUBLIC_QBITTORRENT_URL)d('exec',tag+'-backend','node','-e',`require('fs').accessSync(process.argv[1],require('fs').constants.R_OK|require('fs').constants.X_OK)`,config.downloadsPath||nextEnv.DOWNLOADS_PATH||'/downloads');
  if(layout==='monolith'){
   d('run','-d','--name',tag+'-web','--restart','unless-stopped','--network',network,'--network-alias','web','-e','HOMESTREAM_BACKEND_URL=http://backend:3001','-e','APP_NAME='+(config.appName||nextEnv.APP_NAME||'HomeStream'),tag+'-web');await healthy(tag+'-web','/health',3002);
   const gateway={Image:'nginxinc/nginx-unprivileged:1.28-alpine',HostConfig:{RestartPolicy:{Name:'unless-stopped'},Binds:[receipt+'/nginx.conf:/etc/nginx/conf.d/default.conf:ro'],PortBindings:{'8080/tcp':bindings[Object.keys(bindings)[0]]},NetworkMode:network},NetworkingConfig:{EndpointsConfig:{[network]:{IPAMConfig:{IPv4Address:gatewayIp}}}},ExposedPorts:{'8080/tcp':{}},Labels:{'homestream.upgrade.receipt':receipt}};
   // Preserve the original container's network aliases and explicit IPs on the public gateway.
   for(const [net,e]of Object.entries(oldNetworks))gateway.NetworkingConfig.EndpointsConfig[net]={Aliases:e.Aliases,...(e.IPAMConfig?{IPAMConfig:e.IPAMConfig}:{})};
   save(receipt+'/gateway-create.json',gateway);await api('/containers/create?name='+encodeURIComponent(name),gateway);d('start',name);
   const response=d('exec',name,'wget','-qO-','http://127.0.0.1:8080/health');if(JSON.parse(response).service!=='homestream-web')throw Error('Gateway web health failed');
   const discovery=JSON.parse(d('exec',name,'wget','-qO-','http://127.0.0.1:8080/api/mobile/v1/discovery'));if(discovery.apiVersion!==1||discovery.localPairing!==false)throw Error('Gateway API or pairing policy failed');
  }
  save(receipt+'/containers.json',{gateway:name,backend:tag+'-backend',web:tag+'-web',network,backendImage:tag+'-backend',webImage:tag+'-web',stateDirectory:state});
  fs.writeFileSync(receipt+'/status','success\n');console.log('Docker upgrade complete. Original published ports retained.\nRollback: bash '+receipt+'/rollback.sh');
  if(old.Config.Labels?.['com.docker.compose.project'])console.log('Compose-managed installation: do not run the old Compose definition until its image, environment and copied-state mount have been updated. See '+receipt+'/backend-create.json (private).');
 }catch(error){if(cutover){console.error('Cutover failed; restoring the original container.');await rollback(receipt);}throw error;}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
