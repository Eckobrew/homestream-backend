import { HttpRequest, HttpResponse } from '@/http';
import { invalidateRequested } from '@/lib/request-cache';
import { DroppedNeedleClient, safeMusicId } from '@/lib/droppedneedle';
import { withParentalControls } from '@/lib/parental-controls';
async function get(request:HttpRequest) {
  const native=request.nextUrl.pathname.startsWith('/api/mobile/v1/');
  const json=(value:unknown)=>HttpResponse.json(native?JSON.parse(JSON.stringify(value,(key,v)=>['streamUrl','coverUrl'].includes(key)&&typeof v==='string'&&v.startsWith('/api/v1/music/')?v.replace('/api/v1/','/api/mobile/v1/'):v)):value);
  const client=new DroppedNeedleClient(undefined,undefined,request.signal);const route=request.nextUrl.pathname.replace(/^\/api\/(?:mobile\/v1\/|v1\/)?/,'');
  if(!client.isConfigured()) return route==='music' ? HttpResponse.json({configured:false,albums:[],total:0}) : HttpResponse.json({error:'Configure DroppedNeedle in Admin integrations.'},{status:503});
  try {
    if(route==='music') return json(await client.albums(request.nextUrl.searchParams.get('q')?.trim() || '',Math.min(100000,Number(request.nextUrl.searchParams.get('offset'))||0)));
    if(route==='music/album') {const id=request.nextUrl.searchParams.get('albumId')||'';if(!safeMusicId(id))return HttpResponse.json({error:'Invalid album ID'},{status:400});return json(await client.album(id));}
    if(route==='music/artwork') {const id=request.nextUrl.searchParams.get('albumId')||'';if(!safeMusicId(id))return new HttpResponse(null,{status:400});const response=await client.artwork(id,request.signal);if(!response?.ok || !response.headers.get('content-type')?.startsWith('image/')) {await response?.body?.cancel();return new HttpResponse(null,{status:404});}return new HttpResponse(response.body,{headers:{'Content-Type':response.headers.get('content-type')!,'Cache-Control':'private,max-age=3600'}});}
    if(route==='music/stream') {
      const id=request.nextUrl.searchParams.get('trackId')||'';if(!safeMusicId(id))return HttpResponse.json({error:'Invalid track ID'},{status:400});
      const headers=new Headers();for(const name of ['range','if-range']) {const value=request.headers.get(name);if(value)headers.set(name,value);}
      const response=await client.response('/stream/local/'+encodeURIComponent(id),{headers,method:request.method==='HEAD'?'HEAD':'GET',signal:request.signal});
      if(![200,206,416].includes(response.status)) {await response.body?.cancel();return HttpResponse.json({error:'Music stream unavailable'},{status:response.status===404?404:502});}
      const output=new Headers({'Cache-Control':'private,no-store'});for(const name of ['content-type','content-length','content-range','accept-ranges']) {const v=response.headers.get(name);if(v)output.set(name,v);}
      return new HttpResponse(response.body,{status:response.status,headers:output});
    }
    return HttpResponse.json({error:'Not found'},{status:404});
  } catch {return HttpResponse.json({error:'DroppedNeedle is temporarily unavailable. Check its connection in Admin.'},{status:502});}
}
async function post(request:HttpRequest) {
  const body=await request.json().catch(()=>null);if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body?.musicbrainzId || '')) return HttpResponse.json({error:'A valid MusicBrainz album ID is required'},{status:400});
  try {const result=await new DroppedNeedleClient().requestAlbum(body.musicbrainzId);invalidateRequested();return HttpResponse.json({success:result.success!==false,message:result.message || 'Album requested',status:result.status || 'pending'});}
  catch {return HttpResponse.json({error:'The music request could not be submitted. Check DroppedNeedle in Admin.'},{status:502});}
}
export const GET=withParentalControls(get);
export const HEAD=GET;
export const POST=withParentalControls(post);
