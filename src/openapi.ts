import { webOperations, mobileOperations, type Operation } from './api-schema';
const error = { type: 'object', properties: { error: {type:'string'},pinRequired:{type:'boolean'} }, required:['error'], additionalProperties:true };
function describe(operation: Operation, native: boolean) {
  const content = operation.binary ? { 'application/octet-stream': {schema:{type:'string',format:'binary'}} } : { 'application/json': {schema:operation.responseModel ? {$ref:`#/components/schemas/${operation.responseModel}`} : operation.response} };
  const headers = { 'X-Request-Id':{description:'Request correlation identifier',schema:{type:'string'}}, 'X-HomeStream-Profile':{schema:{type:'string'}}, 'X-HomeStream-Policy':{schema:{type:'string'}}, 'X-HomeStream-Kids':{schema:{type:'string'}} };
  const responses: Record<string,unknown> = { [operation.method === 'OPTIONS' ? '204' : '200']:{description:'Success',content,headers} };
  for (const [status, description] of Object.entries({400:'Invalid input',401:'Authentication required',403:'Policy denied or parent PIN required',404:'Resource not found',429:'Rate limit reached',500:'Internal failure',502:'Upstream rejected request',503:'Service unavailable or conversion capacity reached'})) responses[status] = {description,content:{'application/json':{schema:error}},headers:{...headers,...(['429','503'].includes(status) ? {'Retry-After':{schema:{type:'string'}}} : {})}};
  if (operation.path === 'subtitles') (responses['200'] as {content:Record<string,unknown>}).content['text/vtt'] = {schema:{type:'string'}};
  if (operation.path === 'music/stream' || operation.path === 'stream/download' || operation.path === 'parental-resource') {
    responses['206'] = {description:'Partial content',content,headers:{...headers,'Content-Range':{schema:{type:'string'}},'Accept-Ranges':{schema:{type:'string'}},'Content-Length':{schema:{type:'string'}}}};
    responses['416'] = {description:'Invalid byte range',headers:{'Content-Range':{schema:{type:'string'}}}};
    responses['425'] = {description:'Torrent pieces are not available yet',content:{'application/json':{schema:error}}};
  }
  if (operation.path === 'preview-stream') for (const status of ['302','307']) responses[status] = {description:'Negotiated stream redirect',headers:{Location:{schema:{type:'string'}}}};
  return {
    operationId:`${native ? 'mobile' : 'web'}_${operation.method.toLowerCase()}_${operation.path.replace(/[^a-zA-Z0-9]+/g,'_')}`,
    description: operation.public ? 'Public endpoint. Pairing additionally requires a direct private-network connection.' : native ? 'Bearer household token, paired device credential, or signed mobile session. Profile policy is enforced on the server.' : 'Signed web session, authorized setup/webhook bearer credential, or trusted local access. Remote sessions are bound to their Jellyfin account.',
    security: operation.public ? [] : native ? [{bearer:[]}] : [{session:[]},{bearer:[]},{}],
    parameters:[
      ...[...operation.path.matchAll(/\{([^}]+)\}/g)].map(match => ({name:match[1],in:'path',required:true,schema:{type:'string',minLength:1}})),
      ...Object.entries(operation.query).map(([name,schema]) => ({name,in:'query',required:operation.requiredQuery?.includes(name)||false,schema})),
      ...(operation.binary ? [{name:'Range',in:'header',required:false,schema:{type:'string'}}] : []),
    ],
    ...(operation.body ? {requestBody:{required:true,content:{'application/json':{schema:operation.body}}}} : {}), responses,
  };
}
const paths: Record<string,Record<string,unknown>> = {};
for (const [native, operations] of [[false,webOperations],[true,mobileOperations]] as const) for (const operation of operations) {
  const path = `${native ? '/api/mobile/v1/' : '/api/v1/'}${operation.path}`;
  (paths[path] ||= {})[operation.method.toLowerCase()] = describe(operation,native);
}
export const openapi = { openapi:'3.1.0',info:{title:'HomeStream API',version:'1.2.0'},servers:[{url:'/'}],paths };
