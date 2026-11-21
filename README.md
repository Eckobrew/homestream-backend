# HomeStream Backend

Node.js 22 backend for HomeStream, providing the Native Media Engine, FFmpeg VA-API CQP transcoder, SQLite state store, integration clients, and versioned REST/OpenAPI/Kotlin API contract.

Part of the [HomeStream](https://github.com/Eckobrew/homestream) platform.

## Key Capabilities

- **Native Media Engine** (`src/lib/native-media.ts`): Scans `/movies` and `/tv`, reconciles disk removals, matches TMDB metadata/certifications/episode titles, detects multi-version files, and generates keyframe-only Trickplay VTT sprite sheets (`-skip_frame nokey`).
- **FFmpeg HLS Transcoding** (`src/lib/native-transcode.ts`): Hardware-accelerated `h264_vaapi` encoding in CQP mode (`-rc_mode CQP -qp 21`) with software fallback, PGS/VobSub bitmap subtitle burn-in, and active playback keepalive via `/api/playback/progress`.
- **Integrations**:
  - **TMDB** for metadata, episode names, and age ratings.
  - **Radarr & Sonarr** with live `/api/v3/qualityprofile` selection.
  - **slskd (Soulseek)** with configurable audio quality (`mp3-320`, `flac`, `any-lossless`, `mp3-any`) and Spotify/Exportify playlist import.
  - **qBittorrent**, **Bookshelf**, **YouTube (`yt-dlp`)**.
- **Security & Profiles**: Signed session cookies, LAN/proxy-aware auth (`withParentalControls`), Kids profile restrictions, and SyncPlay room membership checks.

## Documentation

- [Native Media Engine & Transcoding](docs/native-engine.md)
- [API & Contract Generation](docs/api-contract.md)
- [Custom Cast Receiver](docs/custom-cast-receiver.md)

## Development

```bash
npm ci
npm run lint
npm run build
npm test
```

## Contract Sync

```bash
npm run contract:generate
npm run contract:kotlin
npm run contract:check
npm run contract:test
```
