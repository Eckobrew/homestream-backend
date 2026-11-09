import { HttpRequest, HttpResponse } from '@/http';
import { SeerrClient } from '@/lib/seerr';
import { QBittorrentClient } from '@/lib/qbittorrent';
import { DroppedNeedleClient } from '@/lib/droppedneedle';
import { withParentalControls, filterKidsJson } from '@/lib/parental-controls';
import { requestParentalProfile } from '@/lib/parental-runtime';
import { isKids } from '@/lib/parental-store';
import type { RequestedItem, MediaItem } from '@/types';
import { getServerConfig } from '@/lib/config';
import { requestRevision } from '@/lib/request-cache';
import { videoQueue } from '@/lib/requested-media';
import { getNativeUserRequests } from '@/lib/user-requests';
import { getRequestedMusicItems } from '@/lib/music';
import type { QBittorrentRawTorrent } from '@/lib/qbittorrent';
let cache:{key:string;until:number;promise:Promise<{videos:MediaItem[];music:RequestedItem[];downloads:QBittorrentRawTorrent[];warnings:string[];updatedAt:string}>}|undefined;
async function get(_request:HttpRequest) {
  const profile=requestParentalProfile();const kids=isKids(profile);const config=getServerConfig();
  const key=JSON.stringify([config.seerrUrl,config.seerrApiKey,config.tmdbApiKey,config.qbittorrentUrl,config.qbittorrentPassword,config.qbittorrentUsername,config.droppedneedleUrl,config.droppedneedleToken,kids,requestRevision()]);
  if(!cache || cache.key!==key || cache.until<Date.now()) cache={key,until:Date.now()+10000,promise:(async()=>{
    const warnings:string[]=[];const seerr=new SeerrClient(),music=new DroppedNeedleClient(),qb=new QBittorrentClient();
    const safe=async<T>(label:string,action:()=>Promise<T>,fallback:T)=>{try{return await action();}catch{warnings.push(label+' is unavailable. Showing other services.');return fallback;}};
    const [seerrVideos,nativeVideos,musicItems,downloads]=await Promise.all([
      seerr.isConfigured()?safe('Seerr',()=>seerr.getRequestQueue(),[]):Promise.resolve([]),
      safe('HomeStream Requests',()=>getNativeUserRequests(),[]),
      !kids ? Promise.resolve(getRequestedMusicItems()) : Promise.resolve([]),
      !kids && qb.isConfigured()?safe('qBittorrent',()=>qb.getDownloadingTorrents(),[]):Promise.resolve([])
    ]);
    const seen=new Set<string>();
    const videos:MediaItem[]=[];
    for(const v of [...nativeVideos,...seerrVideos]) {
      const k=v.tmdbId?`${v.type}:${v.tmdbId}`:v.title.toLowerCase();
      if(!seen.has(k)) { seen.add(k); videos.push(v); }
    }
    return {videos,music:musicItems,downloads,warnings,updatedAt:new Date().toISOString()};
  })()};
  const data=await cache.promise;const videos:MediaItem[]=kids && profile ? await filterKidsJson(data.videos,profile) as MediaItem[]:data.videos;
  const items=videoQueue(videos,data.downloads);
  items.push(...data.music.map(item=>({...item})));if(_request.nextUrl.pathname.startsWith('/api/mobile/v1/'))for(const item of items)if(item.posterUrl?.startsWith('/api/v1/music/'))item.posterUrl=item.posterUrl.replace('/api/v1/','/api/mobile/v1/');return HttpResponse.json({items,warnings:data.warnings,updatedAt:data.updatedAt});
}
export const GET=withParentalControls(get);
