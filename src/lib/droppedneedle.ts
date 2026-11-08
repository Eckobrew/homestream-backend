import { fetch, registerDependency } from '@/upstream';
import { getServerConfig } from './config';
import type { MusicAlbum, MusicTrack, RequestedItem } from '@/types';

type Row = Record<string, any>;
const metadata=new Map<string,{album:MusicAlbum;until:number}>();
const text = (v: unknown) => typeof v === 'string' ? v : '';
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
export const safeMusicId = (id: string) => /^[a-zA-Z0-9_-]{1,128}$/.test(id);
export function musicAlbum(row: Row): MusicAlbum {
  return { id: text(row.musicbrainz_id), title: text(row.title || row.name || row.album_title), artist: text(row.artist_name || row.artist),
    year: number(row.year), releaseDate: text(row.release_date || row.first_release_date) || (row.year ? String(row.year) : undefined),
    // Artwork is fetched through our authenticated fixed-origin proxy, never by exposing the upstream token.
    coverUrl: safeMusicId(text(row.musicbrainz_id)) ? '/api/v1/music/artwork?albumId='+encodeURIComponent(row.musicbrainz_id) : undefined,
    inLibrary: row.in_library === true, requested: row.requested === true, trackCount: number(row.track_count || row.total_tracks) };
}
export class DroppedNeedleClient {
  private url: string;
  private token: string;
  constructor(url?: string, token?: string, private readonly signal?:AbortSignal) { const c=getServerConfig();this.url=(url ?? c.droppedneedleUrl ?? '').replace(/\/+$/,'');this.token=token || c.droppedneedleToken || '';registerDependency('droppedneedle',this.url); }
  isConfigured() { return Boolean(this.url && this.token); }
  async response(route: string, init: RequestInit = {}) {
    if (!this.isConfigured()) throw new Error('DroppedNeedle is not configured');
    const headers=new Headers(init.headers);headers.set('Authorization','Bearer '+this.token);
    if(init.body) headers.set('Content-Type','application/json');
    return fetch(this.url+'/api/v1'+route,{...init,headers,redirect:'error',signal:init.signal || this.signal || AbortSignal.timeout(20000)});
  }
  async json(route: string, init?: RequestInit): Promise<Row> {
    const response=await this.response(route,init);
    if(!response.ok) { await response.body?.cancel();throw new Error(response.status===401 || response.status===403 ? 'DroppedNeedle authorization failed' : 'DroppedNeedle request failed'); }
    return response.json();
  }
  async testConnection() { await this.json('/local/albums?limit=1');return {success:true}; }
  async albums(query='', offset=0) {
    if(query) { const d=await this.json('/search?'+new URLSearchParams({q:query,limit_albums:'30',limit_artists:'0',buckets:'albums'}));return {configured:true,albums:(d.albums || []).map(musicAlbum),total:(d.albums || []).length}; }
    const d=await this.json('/local/albums?limit=200&offset='+offset+'&sort_by=date_added&sort_order=desc');const albums:MusicAlbum[]=(d.items || []).map((a:Row)=>musicAlbum({...a,in_library:true}));
    for(const album of albums)metadata.set(this.url+'|'+album.id,{album,until:Date.now()+600000});
    while(metadata.size>1000)metadata.delete(metadata.keys().next().value!);
    return {configured:true,albums,total:Number(d.total)||0};
  }

  async album(id: string) {
    const local=await this.json('/local/albums/match/'+encodeURIComponent(id));
    let album: MusicAlbum;
    if(local.found) {
      // Local metadata does not depend on an external catalogue being online.
      const entry=metadata.get(this.url+'|'+id);
      if(entry && entry.until>Date.now())album=entry.album;
      else {const page=await this.albums();album=page.albums.find((a:MusicAlbum)=>a.id===id) || musicAlbum({musicbrainz_id:id,name:'Music album',in_library:true});}
    } else album=musicAlbum(await this.json('/albums/'+encodeURIComponent(id)));
    const tracks:MusicTrack[]=(local.tracks || []).map((t:Row)=>({id:text(t.track_file_id),title:text(t.title),artist:album.artist,album:album.title,trackNumber:number(t.track_number)||0,discNumber:number(t.disc_number)||1,durationSeconds:number(t.duration_seconds),streamUrl:'/api/v1/music/stream?trackId='+encodeURIComponent(t.track_file_id)}));
    return {album,tracks};
  }
  async requestAlbum(id: string) { return this.json('/requests/new',{method:'POST',body:JSON.stringify({musicbrainz_id:id})}); }
  async artwork(id: string, signal?: AbortSignal) {
    return this.response('/covers/release-group/'+encodeURIComponent(id)+'?size=250',{signal});
  }

  async requested(): Promise<RequestedItem[]> {
    const [active,history,downloads]=await Promise.all([this.json('/requests/active'),this.json('/requests/history?page_size=100'),this.json('/downloads?page_size=100')]);
    const rows=new Map<string,Row>();
    for(const a of [...(history.items || []),...(active.items || [])]) rows.set(text(a.musicbrainz_id),a);
    for(const task of downloads.items || []) {
      const id=text(task.release_group_mbid);if(!id)continue;
      const previous=rows.get(id);
      // Keep the most recent task; list_downloads is newest-first.
      if(!previous?.task) rows.set(id,{...previous,musicbrainz_id:id,album_title:task.album_title || previous?.album_title,artist_name:task.artist_name || previous?.artist_name,year:task.year || previous?.year,status:task.status,task,requested_at:previous?.requested_at || task.created_at});
    }
    return [...rows.values()].map(a=>({id:'music-'+a.musicbrainz_id,title:text(a.track_title || a.album_title),artist:text(a.artist_name),kind:'music',source:'droppedneedle',status:text(a.status)||'requested',requestedAt:text(a.requested_at),releaseDate:text(a.release_date || a.first_release_date) || (a.year ? String(a.year):undefined),posterUrl:musicAlbum(a).coverUrl,progress:number(a.task?.progress_percent ?? a.progress)}));
  }
}
