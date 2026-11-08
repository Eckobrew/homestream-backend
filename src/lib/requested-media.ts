import type { MediaItem, RequestedItem } from '@/types';
import type { QBittorrentRawTorrent } from './qbittorrent';
const words=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
export function videoQueue(videos:MediaItem[],downloads:QBittorrentRawTorrent[]):RequestedItem[] {
 const groups=new Map<string,QBittorrentRawTorrent[]>();const unmatched:QBittorrentRawTorrent[]=[];
 for(const d of downloads){const name=' '+words(d.name)+' ';const matches=videos.filter(v=>words(v.title).length>=3 && name.includes(' '+words(v.title)+' ') && (!v.year || v.type!=='Movie' || !/\b(?:19|20)\d{2}\b/.test(words(d.name)) || name.includes(' '+v.year+' ')));
  if(matches.length===1)groups.set(matches[0].id,[...(groups.get(matches[0].id)||[]),d]);else unmatched.push(d);
 }
 const result:RequestedItem[]=videos.map(media=>{const list=groups.get(media.id)||[];const size=list.reduce((n,d)=>n+(d.total_size||0),0);const progress=list.length?size?list.reduce((n,d)=>n+d.progress*(d.total_size||0),0)/size*100:list.reduce((n,d)=>n+d.progress,0)/list.length*100:media.status==='available'?100:undefined;
 return {id:media.id,title:media.title,kind:media.type==='Movie'?'movie':'tv',source:'seerr',posterUrl:media.posterUrl,releaseDate:media.releaseDate,requestedAt:media.requestedAt,status:media.requestStatus==='declined'?'declined':media.status==='available'?'available':list.length?(progress===100?'importing':'downloading'):media.requestStatus||media.status,progress:progress===undefined?undefined:Math.max(0,Math.min(100,progress)),downloadSpeed:list.length?list.reduce((n,d)=>n+(d.dlspeed||0),0):undefined,etaSeconds:list.length?Math.max(...list.map(d=>d.eta||0)):undefined,media};});
 for(const d of unmatched)result.push({id:'download-'+d.hash,title:d.name,kind:/s\d{1,2}e\d{1,2}|season/i.test(d.name)?'tv':'movie',source:'qbittorrent',status:d.state,progress:Math.max(0,Math.min(100,d.progress*100)),downloadSpeed:d.dlspeed,etaSeconds:d.eta});
 return result;
}
