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

See [the deployment and migration guide](docs/split-migration.md). The reference Compose stack uses separate images and an Nginx gateway. Build locally before a first deployment; remote images are not published by this workspace change.

See [the follow-up improvement plan](docs/improvement-plan.md) for prioritized work beyond the split. Existing audit documents are retained as historical context; source and tests describe current behavior.

The two local checkouts retain monolith history on `split-backend` / `split-web` branches. Their `monolith` remote is for provenance; add a new `origin` for each destination repository before publishing. No changes have been pushed upstream.

See [the 1.1 upgrade and feature guide](docs/follow-up-release.md) before starting this version against existing JSON state.
