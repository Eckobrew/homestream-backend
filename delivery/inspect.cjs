'use strict';
// Read-only discovery. --private output is written only to a root-private receipt.
const fs=require('node:fs');const path=require('node:path');const cp=require('node:child_process');const {parseEnv}=require('node:util');
function run(program,args){try{return cp.execFileSync(program,args,{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{return '';}}
function property(unit,name){return run('systemctl',['show',unit,`--property=${name}`,'--value']);}
function shellWords(value){const out=[];let word='',quote='',escaped=false;for(const char of value){if(escaped){word+=char;escaped=false;}else if(char==='\\'&&quote!=="'"){escaped=true;}else if(quote){if(char===quote)quote='';else word+=char;}else if(char==='"'||char==="'")quote=char;else if(/\s/.test(char)){if(word){out.push(word);word='';}}else word+=char;}if(quote||escaped)throw Error('Unsupported systemd environment quoting');if(word)out.push(word);return out;}
const states=['config.json','profiles.json','devices.json','parental-controls.json','homestream.sqlite'];
function discover(){
 const split=['homestream-backend.service','homestream-web.service'].filter(unit=>property(unit,'LoadState')==='loaded');
 if(split.length)throw Error('An existing split-service installation was found. This package upgrades the original single-service installation only.');
 const units=['homestream.service','homeflix.service'].filter(unit=>property(unit,'LoadState')==='loaded');
 const active=units.filter(unit=>property(unit,'ActiveState')==='active');
 if(active.length!==1)throw Error('Expected exactly one active homestream.service or homeflix.service; no service has been changed.');
 const service=active[0];const root=property(service,'WorkingDirectory');
 if(!root||!path.isAbsolute(root)||!fs.existsSync(path.join(root,'package.json')))throw Error('Cannot identify the native application working directory.');
 const entry=property(service,'ExecStart');if(/docker|podman/i.test(entry)||!/(node|next|npm)/i.test(entry))throw Error('This is not a supported native Node.js installation.');
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
 if(!/home(stream|flix)/i.test(pkg.name||''))throw Error('Application package identity does not match HomeStream/HomeFlix.');
 const env={};const envFiles=[];
 for(const name of ['.env','.env.production','.env.local','.env.production.local']){const file=path.join(root,name);if(fs.existsSync(file)){Object.assign(env,parseEnv(fs.readFileSync(file,'utf8')));envFiles.push(file);}}
 for(const assignment of shellWords(property(service,'Environment'))){const index=assignment.indexOf('=');if(index>0)env[assignment.slice(0,index)]=assignment.slice(index+1);}
 for(const match of property(service,'EnvironmentFiles').matchAll(/([^\s]+) \(ignore_errors=(?:yes|no)\)/g)){const file=match[1];if(fs.existsSync(file)){Object.assign(env,parseEnv(fs.readFileSync(file,'utf8')));envFiles.push(file);}}
 const candidates=[env.DATA_DIR,path.join(root,'data'),'/tmp/homeflix-data','/tmp/homestream-data'].filter(Boolean).map(value=>path.resolve(root,value));
 const populated=[...new Set(candidates)].filter(directory=>states.some(name=>fs.existsSync(path.join(directory,name))));
 let dataDir=env.DATA_DIR?path.resolve(root,env.DATA_DIR):populated[0]||path.join(root,'data');
 if(!env.DATA_DIR&&populated.length>1)throw Error('Several state directories contain data; resolve DATA_DIR in the old service before upgrading.');
 if(env.DATA_DIR&&!fs.existsSync(dataDir))throw Error('The configured DATA_DIR does not exist; refusing to create an empty replacement.');
 if(fs.existsSync(dataDir))dataDir=fs.realpathSync(dataDir);
 const releaseParent='/opt/homestream-split';
 if(dataDir==='/'||releaseParent===dataDir||releaseParent.startsWith(dataDir+'/')||fs.existsSync(path.join(dataDir,'node_modules')))throw Error('DATA_DIR is not a dedicated application-state directory.');
 if(fs.existsSync(dataDir)){for(const name of fs.readdirSync(dataDir)){if(fs.lstatSync(path.join(dataDir,name)).isSymbolicLink())throw Error('State contains symlinks; manual migration is required.');}}
 const config=fs.existsSync(path.join(dataDir,'config.json'))?JSON.parse(fs.readFileSync(path.join(dataDir,'config.json'),'utf8')):{};
 const port=Number(env.PORT||/(?:-p|--port)\s+(\d+)/.exec(entry)?.[1]||3000);
 if(!Number.isInteger(port)||port<1||port>65535||[3001,3002].includes(port))throw Error('The existing public port conflicts with the new internal ports.');
 const keep=new Set(['APP_NAME','JELLYFIN_URL','JELLYFIN_API_KEY','JELLYFIN_USER_ID','SEERR_URL','SEERR_API_KEY','QBITTORRENT_URL','QBITTORRENT_USERNAME','QBITTORRENT_PASSWORD','QBITTORRENT_DOWNLOADS_PATH','DOWNLOADS_PATH','NEXT_PUBLIC_APP_URL','NEXT_PUBLIC_APP_NAME','NEXT_PUBLIC_JELLYFIN_URL','NEXT_PUBLIC_SEERR_URL','NEXT_PUBLIC_QBITTORRENT_URL']);
 const settings=Object.fromEntries(Object.entries(env).filter(([key])=>keep.has(key)||key.startsWith('HOMESTREAM_')));
 return {service,root,dataDir,port,settings,environmentFiles:[...new Set(envFiles)],wasEnabled:property(service,'UnitFileState').startsWith('enabled'),oldUser:property(service,'User')||'root',nginxWasInstalled:Boolean(run('sh',['-c','command -v nginx'])),nginxWasActive:run('systemctl',['is-active','nginx'])==='active',nginxWasEnabled:property('nginx.service','UnitFileState').startsWith('enabled'),loopbackOnly:['127.0.0.1','::1','localhost'].includes(env.HOST||env.HOSTNAME||''),stateFiles:states.filter(name=>fs.existsSync(path.join(dataDir,name))),appName:config.appName||env.APP_NAME||env.NEXT_PUBLIC_APP_NAME||'HomeStream',downloadsPath:config.downloadsPath||env.DOWNLOADS_PATH||'/downloads',qbitConfigured:Boolean(config.qbittorrentUrl||env.QBITTORRENT_URL),upstreamProxies:(env.HOMESTREAM_TRUSTED_PROXIES||'').split(',').map(value=>value.trim()).filter(Boolean),legacyTrustProxy:env.HOMESTREAM_TRUST_PROXY==='true'};
}
try{const plan=discover();if(process.argv.includes('--private'))process.stdout.write(JSON.stringify(plan));else console.info(JSON.stringify({container:111,service:plan.service,applicationDirectory:plan.root,dataDirectory:plan.dataDir,publicPort:plan.port,oldServiceUser:plan.oldUser,applicationName:plan.appName,stateFiles:plan.stateFiles,upstreamProxyCount:plan.upstreamProxies.length,legacyProxyFlag:plan.legacyTrustProxy,architecture:process.arch,inspectionRuntime:process.version},null,2));}catch(error){console.error(error.message);process.exitCode=1;}
