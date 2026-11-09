import Ajv from 'ajv';
import { HttpRequest, HttpResponse } from './http';
export type Schema = Record<string, unknown>;
export type Operation = { path: string; method: string; query: Record<string, Schema>; requiredQuery?: string[]; body?: Schema; response: Schema; binary?: boolean; public?: boolean; responseModel?: string };
const text = { type: 'string', maxLength: 8192 };
const id = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9_-]+$' };
const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const natural = { type: 'string', pattern: '^\\d+$', maxLength: 16 };
const flag = { type: 'string', enum: ['true','false'] };
const boolean = { type: 'boolean' };
const object = (properties: Record<string, Schema> = {}, required: string[] = []): Schema => ({ type: 'object', properties, required, additionalProperties: true });
const list = (items: Schema = object()): Schema => ({ type: 'array', items });
const success = object({ success: boolean, message: text });
const profile = object({ id, name: text, isKids: boolean, kidsRating: { type:'string',enum:['U','PG','12','15','18'] } });
const media = object({ id, title: text, type: { type:'string',enum:['Movie','Series','Episode'] } });
const profilesBody = object({ action: { type:'string',enum:['create','import','delete','select','update'] }, profileId:id, name:{type:'string',minLength:1,maxLength:64}, userIds:list(id), jellyfinUserIds:list(id), jellyfinUserId:id, paletteIndex:integer, avatarId:text, mode:{type:'string',enum:['existing','new']}, password:text, isKids:boolean, kidsDateOfBirth:text, parentPin:{type:'string',pattern:'^\\d{4,8}$'} });
const progress = object({ itemId:id, userId:id, positionTicks:integer, isPaused:boolean, isStopped:boolean, isStarted:boolean },['itemId','positionTicks']);
const request = object({ mediaType:{type:'string',enum:['movie','tv']},mediaId:{...integer,minimum:1}, seasons:{anyOf:[{type:'string',const:'all'},list(integer)]},is4k:boolean,profileId:integer,serverId:integer },['mediaType','mediaId']);
const login = object({ username:{type:'string',minLength:1,maxLength:200},password:text,action:{type:'string',enum:['login','logout']} });
const configFields = Object.fromEntries(['appName','jellyfinUrl','jellyfinApiKey','jellyfinUserId','seerrUrl','seerrApiKey','qbittorrentUrl','qbittorrentUsername','qbittorrentPassword','downloadsPath','radarrUrl','radarrApiKey','sonarrUrl','sonarrApiKey','tmdbApiKey','url','apiKey','userId','username','password','parentPin'].map(key => [key,text]));
const operations: Operation[] = [];
function add(path: string, method: string, response: Schema, query: Record<string,Schema> = {}, body?: Schema, extra: Partial<Operation> = {}) {
  operations.push({ path,method,response,query:{userId:id,...query},body,...extra });
}
add('auth','GET',object({requiresAuth:boolean,isAuthenticated:boolean,isLocalOrTailscale:boolean,canManageIntegrations:boolean,users:list(profile)}),{action:{type:'string',enum:['users']}},undefined,{public:true});
add('auth','POST',success,{},login,{public:true});
add('config','GET',object(),{},undefined,{responseModel:'PublicConfig'});
add('config','POST',object({success:boolean,config:object(),error:text}),{action:{type:'string',enum:['save','test-jellyfin','test-seerr','test-qbittorrent','test-radarr','test-sonarr','test-tmdb']}},object({...configFields,action:text}));
add('home','GET',object(),{},undefined,{responseModel:'HomeResponse'});
add('library/{type}','GET',object(),{search:text,letter:{type:'string',maxLength:1}},undefined,{responseModel:'LibraryResponse'});
add('categories/{type}','GET',object({type:text,sections:list()}));
add('media/{id}','GET',object(),{type:{type:'string',enum:['movie','tv']}},undefined,{responseModel:'MediaResponse'});
add('media/{id}/recommendations','GET',object({success:boolean,source:text,recommendations:list(media)}),{tmdbId:natural,type:text});
add('profiles','GET',object({profiles:list(profile),activeProfileId:text,needsSetup:boolean}),{includeAvailable:flag},undefined,{responseModel:'ProfilesResponse'});
add('profiles','POST',object({success:boolean,profiles:list(profile),profile}),{},profilesBody);
add('search','GET',object({results:list(media),isDemoMode:boolean}),{q:text});
add('downloads','GET',object({items:list()}));
const playbackQuery = { itemId:id, startTimeTicks:natural, forceTranscode:flag, canPlayHevc:flag, receiver:{type:'string',enum:['browser','cast','native-tv']}, videoCodecs:text,audioCodecs:text,videoCapabilities:text,maxWidth:natural,maxHeight:natural };
add('playback','GET',object(),playbackQuery,undefined,{requiredQuery:['itemId'],responseModel:'PlaybackResponse'});
add('playback/progress','POST',success,{},progress);
add('request','GET',object({profiles:list(),defaultProfileId:{type:'integer'}}),{type:{type:'string',enum:['movie','tv']}});
add('request','POST',success,{},request);
add('preview-stream','GET',object(),{itemId:id,ticks:natural},undefined,{requiredQuery:['itemId'],binary:true});
add('subtitles','GET',object({subtitles:list()}),{itemId:id,mediaSourceId:id,index:natural},undefined,{requiredQuery:['itemId']});
add('trailer','GET',object({success:boolean,trailer:{anyOf:[object(),{type:'null'}]}}),{itemId:id,tmdbId:natural,type:{type:'string',enum:['movie','tv']}});
add('stream/download','GET',object(),{hash:id,path:text,fileIndex:natural,season:natural,episode:natural,start:{type:'string',pattern:'^\\d+(\\.\\d+)?$'},transcode:{type:'string',enum:['0','1']},native:{type:'string',enum:['0','1']},source:{type:'string',enum:['0','1']},probe:{type:'string',enum:['0','1']},growing:{type:'string',enum:['0','1']}},undefined,{binary:true});
add('stream/torrent','GET',object(),{tmdbId:natural,type:text,season:natural,episode:natural,title:text,magnet:text,forceTranscode:flag,canPlayHevc:flag,receiver:text},undefined,{binary:true});
add('webhook/arr','GET',object({status:text}));
add('webhook/arr','POST',success,{},object({eventType:text,downloadId:text,torrentHash:text,event_type:text}));
add('catalog-links','GET',object({items:list(media)}));
add('music','GET',object(),{q:{type:'string',maxLength:200},offset:natural},undefined,{responseModel:'MusicResponse'});
add('music/album','GET',object(),{albumId:id},undefined,{requiredQuery:['albumId'],responseModel:'MusicAlbumResponse'});
add('music/artwork','GET',object(),{albumId:id},undefined,{requiredQuery:['albumId'],binary:true});
add('music/stream','GET',object(),{trackId:id},undefined,{requiredQuery:['trackId'],binary:true});
add('music/request','POST',success,{},object({musicbrainzId:id},['musicbrainzId']));
add('requested','GET',object(),{},undefined,{responseModel:'RequestedResponse'});
add('integrations','GET',object(),{},undefined,{responseModel:'IntegrationsResponse'});
add('integrations','POST',object(),{},object({integration:{type:'string',enum:['jellyfin','seerr','qbittorrent','droppedneedle','radarr','sonarr','tmdb']},action:{type:'string',enum:['save','test']},url:text,secret:text,username:text,downloadsPath:text,parentPin:text},['integration','action']));
export const webOperations = operations;
const shared = ['integrations','requested','music','music/album','music/artwork','music/stream','music/request','home','library/{type}','categories/{type}','media/{id}','media/{id}/recommendations','search','downloads','playback','request','subtitles','trailer','stream/download','stream/torrent'];
export const mobileOperations: Operation[] = operations.filter(operation => shared.includes(operation.path)).map(operation => ({...operation}));
function native(path:string,method:string,response:Schema,query:Record<string,Schema>={},body?:Schema,extra:Partial<Operation>={}) { mobileOperations.push({path,method,response,query:{userId:id,...query},body,...extra}); }
native('discovery','GET',object({apiVersion:integer,appName:text,cast:boolean,pairing:text,localPairing:boolean,jellyfinLogin:boolean}),{},undefined,{public:true});
native('capabilities','GET',object(),{},undefined,{responseModel:'Capabilities'});
native('auth/users','GET',object({users:list(profile)}),{},undefined,{public:true});
native('auth/login','POST',object({user:profile,token:text}),{},object({username:{type:'string',minLength:1,maxLength:200},password:text},['username','password']),{public:true});
native('auth/pair','POST',object({token:text,externalUrl:text,serverName:text}),{},object({deviceId:{type:'string',minLength:1,maxLength:200},deviceName:{type:'string',maxLength:200}},['deviceId']),{public:true});
native('profiles','GET',object({profiles:list(profile),canManage:boolean,avatars:list(text),parentPinConfigured:boolean,activeProfileId:text}));
native('profiles','POST',object({success:boolean,profile,passwordMode:text}),{},profilesBody);
native('profiles/select','POST',object({profile,revision:text}),{},object({profileId:id,parentPin:{type:'string',pattern:'^\\d{4,8}$'}},['profileId']));
for (const path of ['profiles/status','session/status']) native(path,'GET',object({profile:{anyOf:[profile,{type:'null'}]},revision:text,parentPinConfigured:boolean}));
for (const method of ['GET','POST']) native('profiles/users',method,object({users:list(profile)}),{},method === 'POST' ? object({parentPin:{type:'string',pattern:'^\\d{4,8}$'}}) : undefined);
native('continue-watching','GET',object({items:list(media)}));
native('episodes','GET',object({items:list()}),{itemId:id},undefined,{requiredQuery:['itemId']});
native('watched','POST',success,{},object({itemId:id,played:boolean,userId:id},['itemId','played']));
native('progress','POST',success,{},progress);
native('media/{id}/collection','GET',object({collection:{anyOf:[object({name:text,parts:list(media)}),{type:'null'}]}}));
native('image','GET',object(),{itemId:text,url:text,type:text,tag:text,maxWidth:natural,maxHeight:natural},undefined,{binary:true,public:true});
for (const method of ['GET','HEAD']) native('parental-resource',method,object(),{ticket:text},undefined,{binary:true,public:true,requiredQuery:['ticket']});
mobileOperations.push({path:'{path}',method:'OPTIONS',query:{},response:object(),public:true});
export function operationFor(path: string, method: string) {
  const native = path.startsWith('/api/mobile/v1/');
  const route = path.replace(/^\/api\/(?:mobile\/v1\/|v1\/)?/,'');
  return (native ? mobileOperations : webOperations).find(operation => operation.method === (method === 'HEAD' && !route.startsWith('parental-resource') ? 'GET' : method) && new RegExp('^'+operation.path.replace(/\{[^}]+\}/g,'[^/]+')+'$').test(route));
}
const validator = new Ajv({strict:false,allErrors:true});
const compiled = new Map<Schema, ReturnType<Ajv['compile']>>();
function check(schema:Schema,value:unknown) { if (!compiled.has(schema)) compiled.set(schema,validator.compile(schema)); return compiled.get(schema)!(value); }
const querySchemas = new Map<Operation,Schema>();
export async function validateApiRequest(request: HttpRequest): Promise<HttpResponse | undefined> {
  const operation = operationFor(request.nextUrl.pathname,request.method);
  if (!operation) return;
  if (!querySchemas.has(operation)) querySchemas.set(operation,object(operation.query,operation.requiredQuery));
  const missing = operation.requiredQuery?.find(name => !request.nextUrl.searchParams.has(name));
  if (missing) return HttpResponse.json({error:`${missing} is required`},{status:400});
  const query = Object.fromEntries([...new Set(request.nextUrl.searchParams.keys())].map(name => [name,request.nextUrl.searchParams.get(name)]));
  if (!check(querySchemas.get(operation)!,query)) return HttpResponse.json({error:'Invalid query parameters'},{status:400});
  if (operation.body) {
    const body = await request.clone().json().catch(() => null);
    if (!check(operation.body,body)) return HttpResponse.json({error:'Invalid request body'},{status:400});
  }
}
