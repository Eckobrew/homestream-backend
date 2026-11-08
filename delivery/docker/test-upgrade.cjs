// Exercise successful migration and rollback against an in-memory Docker daemon.
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),vm=require('node:vm'),assert=require('node:assert/strict'),events=require('node:events');
const stage='/workspace/homestream-delivery/staging',script=stage+'/tools/docker/upgrade.cjs';
async function scenario(failAt){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'hs-docker-test-')),receipts=temp+'/receipts',data=temp+'/legacy';fs.mkdirSync(data);fs.mkdirSync(receipts);
 const token='hst_dev_'+'a'.repeat(48);for(const [name,value]of Object.entries({'config.json':{appName:'Existing Home'},'profiles.json':[{id:'keep-profile',name:'Owner'}],'devices.json':{[token]:{token,deviceId:'keep-device',client:'android'}}}))fs.writeFileSync(data+'/'+name,JSON.stringify(value));
 const original={Id:'original-id',Name:'/homestream',State:{Running:true},Config:{Image:'old:latest',Env:['PORT=3000','DATA_DIR=/app/data','JELLYFIN_API_KEY=keep-secret'],Labels:{}},HostConfig:{NetworkMode:'oldnet',PortBindings:{'3000/tcp':[{HostIp:'127.0.0.1',HostPort:'3333'}]},RestartPolicy:{Name:'unless-stopped'},Binds:['state-volume:/app/data','/media:/downloads:ro'],Mounts:[],LogConfig:{Type:'json-file'}},NetworkSettings:{Networks:{oldnet:{Aliases:['homestream'],IPAMConfig:null}}},Mounts:[{Type:'volume',Name:'state-volume',Destination:'/app/data',RW:true},{Type:'bind',Source:'/media',Destination:'/downloads',RW:false,Propagation:'rprivate'}]};
 const containers=new Map([['original-id',structuredClone(original)]]),requests=[],removed=[];let injected=false;
 const get=n=>[...containers.values()].find(x=>x.Id===n||x.Name==='/'+n);
 const fake={execFileSync(program,args,opts){
  if(program!=='docker')return cp.execFileSync(program,args,opts);
  args=args.slice(1);const [cmd,...a]=args;
  if(cmd==='version')return '1.47';if(cmd==='info')return 'x86_64';if(cmd==='ps')return 'old:latest';if(cmd==='build'||cmd==='pull')return '';
  if(cmd==='inspect'){
   const c=get(a[0]);if(c)return JSON.stringify([c]);
   if(a[0].endsWith('-backend'))return JSON.stringify([{Config:{Cmd:['node','dist/server.js'],Entrypoint:null,Healthcheck:{Test:['CMD','node','-e','process.exit(0)']}}}]);
   if(a[0].startsWith('homestream-local-'))return JSON.stringify([{IPAM:{Config:[{Subnet:'172.29.0.0/16'}]}}]);throw Error('missing container');
  }
  if(cmd==='exec'){
   const c=get(a[0]);assert(c);
   if(a[1]==='du')return '4 /app/data';
   if(a[1]==='wget')return a.at(-1).endsWith('/health')?' {"service":"homestream-web"}':'{"apiVersion":1,"localPairing":false}';
   if(a.at(-1).includes('const fs=require'))return JSON.stringify({root:'/app',pkg:{name:'homestream',dependencies:{next:'15'}},populated:['/app/data'],dot:{},explicit:'/app/data'});
   if(failAt==='health'){injected=true;throw Error('health failure');}
   return '{"status":"ready"}';
  }
  if(cmd==='update'){get(a.at(-1)).HostConfig.RestartPolicy={Name:a[1]};return '';}
  if(cmd==='stop'){
   if(failAt==='stop'&&!injected){injected=true;throw Error('simulated stop failure');}
   get(a.at(-1)).State.Running=false;return '';
  }
  if(cmd==='start'){get(a[0]).State.Running=true;return '';}
  if(cmd==='rename'){get(a[0]).Name='/'+a[1];return '';}
  if(cmd==='cp'){fs.cpSync(data,a[1],{recursive:true});return '';}
  if(cmd==='network'){
   if(a[0]==='disconnect')delete get(a[2]).NetworkSettings.Networks[a[1]];
   if(a[0]==='connect')get(a.at(-1)).NetworkSettings.Networks[a.at(-2)]={Aliases:[]};return '';
  }
  if(cmd==='rm'){const c=get(a.at(-1));if(c){removed.push(c.Id);containers.delete(c.Id);}return '';}
  if(cmd==='run'){
   if(a.includes('--rm')){
    if(a.includes('dist/import-state.js')){const mount=a[a.indexOf('-v')+1].split(':')[0];return cp.execFileSync(stage+'/runtime/bin/node',[stage+'/backend/dist/import-state.js',mount],{encoding:'utf8'});}
    return '';
   }
   const name=a[a.indexOf('--name')+1];containers.set(name,{Id:name,Name:'/'+name,State:{Running:true},NetworkSettings:{Networks:{}},HostConfig:{RestartPolicy:{Name:'unless-stopped'}}});return name;
  }
  throw Error('Unexpected docker call '+JSON.stringify(args));
 }};
 const fakeHttp={request(options,onResponse){return {on(){},end(text){const body=JSON.parse(text),name=new URL('http://local'+options.path).searchParams.get('name');requests.push({name,body});const response=new events.EventEmitter();response.statusCode=failAt==='create'?500:201;if(response.statusCode===201)containers.set(name,{Id:name,Name:'/'+name,State:{Running:false},NetworkSettings:{Networks:body.NetworkingConfig.EndpointsConfig},HostConfig:body.HostConfig});onResponse(response);queueMicrotask(()=>{response.emit('data','{}');response.emit('end');});}};}};
 let exitCode=0;const source=fs.readFileSync(script,'utf8').replace("'/root/homestream-docker-upgrades/'+id",JSON.stringify(receipts+'/')+'+id').replace('main().catch(', 'globalThis.finished=main().catch(');
 const context={require:n=>n==='node:child_process'?fake:n==='node:http'?fakeHttp:n==='node:fs'?{...fs,statfsSync:()=>({bavail:10*1024**3,bsize:1})}:require(n),__filename:script,__dirname:path.dirname(script),process:{argv:['node',script,'--upgrade','--container','homestream'],getuid:()=>0,pid:999,execPath:stage+'/runtime/bin/node',set exitCode(v){exitCode=v;}},console:{log(){},error(){}},setTimeout:(fn)=>queueMicrotask(fn),structuredClone,URL,Buffer};
 vm.createContext(context);vm.runInContext(source,context);await context.finished;
 if(failAt==='create'||failAt==='stop'||failAt==='health'){
  assert.equal(exitCode,1);assert.equal(get('original-id').Name,'/homestream');assert(get('original-id').State.Running);assert(!removed.includes('original-id'),'Original container must never be deleted');assert.equal(get('original-id').HostConfig.RestartPolicy.Name,'unless-stopped');
 }else{
  assert.equal(exitCode,0);assert(!get('original-id').State.Running);assert.equal(get('original-id').HostConfig.RestartPolicy.Name,'no');
  const backend=requests.find(r=>r.name.endsWith('-backend')).body,gateway=requests.find(r=>r.name==='homestream').body;
  assert(backend.Env.includes('JELLYFIN_API_KEY=keep-secret'));assert(backend.Env.includes('HOMESTREAM_TRUSTED_PROXIES=172.29.0.2'));
  assert(backend.HostConfig.Mounts.some(m=>m.Source==='/media'&&m.ReadOnly));assert(!backend.HostConfig.Mounts.some(m=>m.Source==='state-volume'));assert.deepEqual(gateway.HostConfig.PortBindings['8080/tcp'],original.HostConfig.PortBindings['3000/tcp']);
  assert.equal(JSON.parse(fs.readFileSync(data+'/profiles.json'))[0].id,'keep-profile');
  await context.rollback(receipts+'/'+fs.readdirSync(receipts)[0]);assert(get('original-id').State.Running);assert.equal(get('original-id').Name,'/homestream');assert(!removed.includes('original-id'));
 }
 fs.rmSync(temp,{recursive:true,force:true});console.log('PASS '+(failAt||'successful split, settings/mount/port preservation and migration'));
}
(async()=>{await scenario();await scenario('create');await scenario('stop');await scenario('health');})().catch(e=>{console.error(e);process.exitCode=1;});
