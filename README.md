# HomeStream backend

Independent TypeScript/Node.js API extracted from [Eckobrew/HomeStream](https://github.com/Eckobrew/HomeStream), revision `7505a9b06ce44770f7ddb86904633e478b6988e1`.

Requires Node.js 22.21+, FFmpeg/ffprobe for local download conversion, and the sibling `homestream-web` repository for the browser UI. Jellyfin, Seerr and qBittorrent remain external services.

```bash
npm ci
cp .env.example .env
# Edit .env with your integration settings; npm start loads it if present.
npm run build
npm start
```

The backend listens on **3001**. The reference gateway exposes the complete application on **3000**. Fastify adapters accept Fetch requests and stream Fetch responses; services contain no Next.js imports. Both web and native clients call the same application services. Request identity, Jellyfin credentials and parental policy are scoped to each request.

- `/api/v1/*`: canonical web API.
- Existing `/api/*` and `/api/mobile/v1/*`: retained compatibility interfaces.
- `/api/v1/music/playlists` & `/api/mobile/v1/music/playlists`: per-profile playlist management (`GET`, `POST`).
- `/api/v1/music/playlists/import` & `/api/mobile/v1/music/playlists/import`: zero-developer-key Spotify playlist/profile importer and Exportify CSV/ZIP importer with automated MP3 downloading via Soulseek (`slskd`).
- `/api/v1/music/playlists/import-exportify`: dedicated Exportify endpoint accepting single CSV files, multiple CSV files, or "Export All" `.zip` archives.
- `/openapi.json`: generated public contract.
- `/health/live` and `/health/ready`: independent service checks.

Only this service receives integration credentials, `DATA_DIR`, download mounts or GPU access. One backend process owns the SQLite database. Do not run multiple replicas against that directory.

## Validation

```bash
npm run build
npm test
npm run test:mobile
npm run test:playback
npm run test:torrent
npm run contract:generate
npm run contract:pack
```

Torrent tests create synthetic media with FFmpeg and a fake qBittorrent API; no household server is used. The mobile suite exercises fake Jellyfin authentication, parent policies, playback, progress and byte ranges.

See [validation results and limits](docs/split-validation.md).

## Contract releases

`contract/` is the versioned `@eckobrew/homestream-api` package, containing OpenAPI, generated public models, generated path types and a browser-safe Fetch client. `ServerConfig` and integration credentials are excluded. Regenerate after changing public models or routes, review compatibility, and bump the package and OpenAPI versions together. `npm run contract:pack` creates the distributable tarball. The web repository checks in a release snapshot, so it builds without this checkout or registry access. Update it with `node scripts/sync-contract.mjs /path/to/unpacked/api-package` in the web repository.

OpenAPI covers all web and native operations. The same request schemas validate runtime inputs. Generated Kotlin/OkHttp bindings are available under `contract/kotlin`; CI compiles them.

## Deployment and migration

See [the deployment and migration guide](docs/split-migration.md). The reference Compose stack uses separate images and an Nginx gateway. Use published images or build locally; see Docker image publishing below.

See [the follow-up improvement plan](docs/improvement-plan.md) for prioritized work beyond the split. Existing audit documents are retained as historical context; source and tests describe current behavior.

The independent repositories retain provenance from the original monolith revision above.

See [the 1.1 upgrade and feature guide](docs/follow-up-release.md) before starting this version against existing JSON state.

## Docker image publishing

Successful `main` CI runs publish Linux amd64 images to `ghcr.io/eckobrew/homestream-backend` with `edge` and full `sha-<commit>` tags. Main publication waits for verification (and enabled browser integration checks in the web repository). Pull requests do not receive registry write access or publish images.

Pushing a `vX.Y.Z` tag publishes the corresponding version; stable version tags also update `latest`, while prereleases do not. Each publishing workflow starts the built image as UID 1001 and checks readiness before pushing that exact image. Authentication uses the workflow's short-lived `GITHUB_TOKEN`, with `packages: write` scoped to publishing; no personal token secret is required.

Use a commit tag or image digest for controlled deployments. `edge` tracks tested main and is not an automatic production redeployment. Pair tested backend/web revisions before upgrading. Newly created GHCR packages default to private; package visibility must be public to permit anonymous pulls.

## HomeStream 1.2: music, YouTube, and all-media requests

Discover and Requested cover movies, TV and music. Native Music integration provides catalog search via MusicBrainz, peer-to-peer album acquisition via Soulseek (`slskd`), imported-track playback, artwork proxying and music download states; Seerr and qBittorrent continue to provide video requests and progress. Set `SLSKD_URL` and `SLSKD_API_KEY` on the backend, or configure the connection in Admin integrations. No service credential is delivered to the browser or native player.

Music streams, YouTube video streams, and artwork are proxied through HomeStream with authentication and byte-range support. YouTube videos stream via `/api/mobile/v1/youtube/stream-video?videoId=...` with full caching and seeking support. Music is unavailable in Kids mode until explicit-content policy can be verified. Admin integration editing requires the existing local/admin web policy or an actual signed mobile administrator session, not a household pairing token.

See [the Android implementation handoff](HANDOFF.md) for API 1.2.0 models, native routes, Admin authorization, tab behavior and tests. Existing port-3000 LAN pairing remains enabled by the live gateway's explicit policy.
