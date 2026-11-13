import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as TJS from 'typescript-json-schema';
import openapiTS, { astToString } from 'openapi-typescript';
import { openapi } from '../src/openapi';

const program = TJS.getProgramFromFiles([resolve('src/public-api.ts')], { strictNullChecks: true, skipLibCheck: true, esModuleInterop: true, moduleResolution: 2 }, process.cwd());
const generator = TJS.buildGenerator(program, { required: true, ignoreErrors: false, ref: true });
if (!generator) throw new Error('Could not generate public API models');
const names = ['ApiError','HomeResponse','LibraryResponse','MediaResponse','ProfilesResponse','PlaybackResponse','PublicConfig','Capabilities','MediaItem','UserProfile','RequestMediaPayload','SubtitleTrack','MusicAlbum','MusicTrack','MusicResponse','MusicAlbumResponse','BookItem','BookRequestItem','BookProgress','BooksResponse','BookSearchResponse','BookDetailResponse','BookQueueItem','BookQueueResponse','RequestedItem','RequestedResponse','IntegrationSummary','IntegrationsResponse','YouTubeSearchResult','YouTubeSearchResponse','YouTubeStreamResponse','YouTubeSubscription','YouTubeSubscriptionsResponse','YouTubeDownloadItem','YouTubeQueueResponse','YouTubeArchiveItem','YouTubeArchiveResponse'];
const schemas: Record<string, unknown> = {};
const fixRefs = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll('#/definitions/', '#/components/schemas/'));
for (const name of names) {
  const schema = generator.getSchemaForSymbol(name);
  Object.assign(schemas, fixRefs(schema.definitions || {}));
  const { definitions, $schema, ...own } = schema;
  schemas[name] = fixRefs(own);
}
const result: any = { ...openapi, components: { schemas, securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'homeflix_session' }, bearer: { type: 'http', scheme: 'bearer' } } } };
await mkdir('contract', { recursive: true });
await writeFile('contract/openapi.json', JSON.stringify(result,null,2)+'\n');
await writeFile('contract/paths.d.ts', astToString(await openapiTS(result)));
const source = await readFile('src/types/index.ts','utf8');
await writeFile('contract/models.ts', '// Generated from backend models. Do not edit.\n'+source.replace(/export interface ServerConfig \{[\s\S]*?\n\}/, ''));
console.info('Generated versioned public contract');
