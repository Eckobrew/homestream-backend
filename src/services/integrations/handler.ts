import { HttpRequest, HttpResponse } from '@/http';
import { getServerConfig, saveServerConfig } from '@/lib/config';
import { JellyfinClient } from '@/lib/jellyfin';
import { SeerrClient } from '@/lib/seerr';
import { QBittorrentClient } from '@/lib/qbittorrent';
import { DroppedNeedleClient } from '@/lib/droppedneedle';
import { withParentalControls } from '@/lib/parental-controls';
const fields={jellyfin:['jellyfinUrl','jellyfinApiKey'],seerr:['seerrUrl','seerrApiKey'],qbittorrent:['qbittorrentUrl','qbittorrentPassword'],droppedneedle:['droppedneedleUrl','droppedneedleToken']} as const;
async function get(_r:HttpRequest) {
  const c=getServerConfig();return HttpResponse.json({integrations:Object.entries(fields).map(([id,[url,key]])=>({id,name:id==='droppedneedle'?'DroppedNeedle':id==='qbittorrent'?'qBittorrent':id==='seerr'?'Seerr':'Jellyfin',url:c[url]||'',configured:Boolean(c[url] && (id==='qbittorrent' || c[key])),credentialSet:Boolean(c[key]),...(id==='qbittorrent'?{username:c.qbittorrentUsername||''}:{})})),downloadsPath:c.downloadsPath||'/downloads'});
}
async function post(r:HttpRequest) {
 const body=await r.json().catch(()=>null);if(!body || !Object.hasOwn(fields,body.integration) || !['save','test'].includes(body.action))return HttpResponse.json({error:'Choose a supported integration and action'},{status:400});
 const id=body.integration as keyof typeof fields;const [urlField,secretField]=fields[id];
 const c=getServerConfig();const url=typeof body.url==='string'?body.url.trim().replace(/\/+$/,''):c[urlField]||'';
 if(url) {try {const u=new URL(url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error();}catch{return HttpResponse.json({error:'Enter an HTTP(S) server URL without embedded credentials, query or fragment'},{status:400});}}
 if(body.secret!==undefined && (typeof body.secret!=='string' || body.secret.length>8192 || /[\r\n\0]/.test(body.secret)))return HttpResponse.json({error:'Invalid credential'},{status:400});
 const secret=body.secret || c[secretField] || '';const username=typeof body.username==='string'?body.username:c.qbittorrentUsername||'';
 if(body.action==='test' && !url)return HttpResponse.json({error:'Enter a server URL before testing'},{status:400});
 if(body.action==='test') {try {
  const result=id==='jellyfin'?await new JellyfinClient(url,secret).testConnection():id==='seerr'?await new SeerrClient(url,secret).testConnection():id==='qbittorrent'?await new QBittorrentClient(url,username,secret).testConnection():await new DroppedNeedleClient(url,secret).testConnection();
  return HttpResponse.json({success:result.success,...('version' in result && result.version?{version:result.version}:{})});
 }catch{return HttpResponse.json({success:false,error:'Connection failed. Check the URL, credential and upstream service.'},{status:502});}}
 const patch:Record<string,string>={[urlField]:url};if(body.secret)patch[secretField]=body.secret;if(id==='qbittorrent')patch.qbittorrentUsername=username;
 if(body.downloadsPath!==undefined) {if(typeof body.downloadsPath!=='string'||!body.downloadsPath.startsWith('/')||/[\r\n\0]/.test(body.downloadsPath))return HttpResponse.json({error:'Downloads path must be an absolute path inside the backend container'},{status:400});patch.downloadsPath=body.downloadsPath;}
 saveServerConfig(patch);return HttpResponse.json({success:true});
}
export const GET=withParentalControls(get);
export const POST=withParentalControls(post);
