import { HttpRequest, HttpResponse } from '@/http';
import { getServerConfig, saveServerConfig } from '@/lib/config';
import { JellyfinClient } from '@/lib/jellyfin';
import { SeerrClient } from '@/lib/seerr';
import { QBittorrentClient } from '@/lib/qbittorrent';
import { DroppedNeedleClient } from '@/lib/droppedneedle';
import { RadarrClient } from '@/lib/radarr';
import { SonarrClient } from '@/lib/sonarr';
import { TmdbClient } from '@/lib/tmdb';
import { SlskdClient } from '@/lib/slskd';
import { withParentalControls } from '@/lib/parental-controls';
const fields={jellyfin:['jellyfinUrl','jellyfinApiKey'],seerr:['seerrUrl','seerrApiKey'],qbittorrent:['qbittorrentUrl','qbittorrentPassword'],slskd:['slskdUrl','slskdApiKey'],droppedneedle:['droppedneedleUrl','droppedneedleToken'],radarr:['radarrUrl','radarrApiKey'],sonarr:['sonarrUrl','sonarrApiKey'],tmdb:['','tmdbApiKey']} as const;
async function get(_r:HttpRequest) {
  const c=getServerConfig();return HttpResponse.json({integrations:Object.entries(fields).map(([id,[urlField,keyField]])=>{
    const isTmdb = id === 'tmdb';
    const url = isTmdb ? 'https://api.themoviedb.org/3' : (c as any)[urlField] || '';
    const configured = isTmdb ? Boolean(c.tmdbApiKey) : Boolean((c as any)[urlField] && (id==='qbittorrent' || (c as any)[keyField]));
    const credentialSet = Boolean((c as any)[keyField]);
    const name = id==='slskd'?'slskd (Soulseek Music)':id==='droppedneedle'?'DroppedNeedle':id==='qbittorrent'?'qBittorrent':id==='seerr'?'Seerr':id==='radarr'?'Radarr':id==='sonarr'?'Sonarr':id==='tmdb'?'TMDB':'Jellyfin';
    return { id, name, url, configured, credentialSet, ...(id==='qbittorrent'?{username:c.qbittorrentUsername||''}:{}) };
  }),downloadsPath:c.downloadsPath||'/downloads'});
}
async function post(r:HttpRequest) {
 const body=await r.json().catch(()=>null);if(!body || !Object.hasOwn(fields,body.integration) || !['save','test'].includes(body.action))return HttpResponse.json({error:'Choose a supported integration and action'},{status:400});
 const id=body.integration as keyof typeof fields;const [urlField,secretField]=fields[id];
 const c=getServerConfig();const url=typeof body.url==='string'?body.url.trim().replace(/\/+$/,''):(c as any)[urlField]||'';
 if(url && id !== 'tmdb') {try {const u=new URL(url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error();}catch{return HttpResponse.json({error:'Enter an HTTP(S) server URL without embedded credentials, query or fragment'},{status:400});}}
 if(body.secret!==undefined && (typeof body.secret!=='string' || body.secret.length>8192 || /[\r\n\0]/.test(body.secret)))return HttpResponse.json({error:'Invalid credential'},{status:400});
 const secret=body.secret || (c as any)[secretField] || '';const username=typeof body.username==='string'?body.username:c.qbittorrentUsername||'';
 if(body.action==='test' && !url && id !== 'tmdb')return HttpResponse.json({error:'Enter a server URL before testing'},{status:400});
 if(body.action==='test') {try {
  let result: any;
  if (id === 'jellyfin') result = await new JellyfinClient(url, secret).testConnection();
  else if (id === 'seerr') result = await new SeerrClient(url, secret).testConnection();
  else if (id === 'tmdb') result = await new TmdbClient(secret).testConnection();
  else if (id === 'qbittorrent') result = await new QBittorrentClient(url, username, secret).testConnection();
  else if (id === 'radarr') result = await new RadarrClient(url, secret).testConnection();
  else if (id === 'sonarr') result = await new SonarrClient(url, secret).testConnection();
  else if (id === 'slskd') result = await new SlskdClient(url, secret).testConnection();
  else {
    try {
      result = await new DroppedNeedleClient(url, secret).testConnection();
    } catch {
      result = await new SlskdClient(url, secret).testConnection();
    }
  }
  return HttpResponse.json({success:result.success,...('version' in result && result.version?{version:result.version}:{})});
 }catch{return HttpResponse.json({success:false,error:'Connection failed. Check the URL, credential and upstream service.'},{status:502});}}
 const patch:Record<string,string>={};if(urlField)patch[urlField]=url;if(body.secret)patch[secretField]=body.secret;if(id==='qbittorrent')patch.qbittorrentUsername=username;
 if(body.downloadsPath!==undefined) {if(typeof body.downloadsPath!=='string'||!body.downloadsPath.startsWith('/')||/[\r\n\0]/.test(body.downloadsPath))return HttpResponse.json({error:'Downloads path must be an absolute path inside the backend container'},{status:400});patch.downloadsPath=body.downloadsPath;}
 saveServerConfig(patch);return HttpResponse.json({success:true});
}
export const GET=withParentalControls(get);
export const POST=withParentalControls(post);
