# Android handoff: HomeStream 1.2 music, YouTube, Discover, Requested and Admin

Updated 9 November 2026. This file is the implementation handoff for clients interacting with the HomeStream backend. DroppedNeedle has been completely replaced with native HomeStream Music integration powered by Soulseek (`slskd`), MusicBrainz, and local SQLite request tracking.

## Goal and current backend

Discover and Requested cover movies, TV, and music. Discover finds and requests content; Requested tracks requested content, download/import states, progress, and release dates. Native Admin integrations configure Jellyfin, Seerr, qBittorrent, and slskd.

Backend: https://github.com/Eckobrew/homestream-backend . Web reference: https://github.com/Eckobrew/homestream-web . The public contract is **1.2.0**, API major path remains **v1** and existing 1.1 routes remain supported. Generated definitions: `contract/openapi.json`, `contract/models.ts`, `contract/paths.d.ts`. Kotlin/OkHttp bindings: `contract/kotlin/src/main/kotlin/uk/eckonet/homestream/api/`. API client calls are blocking: use Dispatchers.IO and close every binary okhttp Response.

Implementation locations: `src/services/music/handler.ts`, `src/lib/slskd.ts`, `src/services/requested/handler.ts`, `src/lib/requested-media.ts`, `src/services/integrations/handler.ts`, `src/services/mobile/v1/[...path]/handler.ts`, `src/api-schema.ts`, `src/public-api.ts`.

## Authentication and pairing

Use the saved HomeStream server URL and existing `Authorization: Bearer <paired-device token or signed mobile session>` on native API requests, artwork and audio requests. Never embed Jellyfin/Seerr/qBittorrent/slskd service credentials in the app. Never log bearer headers, credentials, stream URLs with tickets, or auth response bodies. Handle 401 by sign-in/re-pair; do not retry indefinitely.

LAN scanning/pairing must continue on **port 3000**, without requiring manual input. The live gateway allows automatic pairing only for direct LAN-IP requests from the home LAN, with no incoming forwarding headers, excluding configured upstream reverse proxies. Do not send X-Forwarded-For, Forwarded, X-Real-IP or X-HomeStream-Local-Pairing from Android. The server owns identity and pairing admission. Check `GET /api/mobile/v1/discovery` and `localPairing`; POST `/api/mobile/v1/auth/pair` with the existing deviceId/deviceName shape. After pairing keep the returned public externalUrl for normal remote access. Public-hostname pairing stays blocked. There is no published backend port 3001.

Remote Jellyfin login remains `POST /api/mobile/v1/auth/login` with `{username,password}`. New signed mobile sessions include a server-verified admin claim derived from Jellyfin's Policy.IsAdministrator; clients cannot set this claim. An older session may require a fresh sign-in to obtain admin privileges. `GET /api/mobile/v1/capabilities` returns optional `canManageIntegrations`; it is false for ordinary paired devices/household tokens and ordinary signed users. Do not treat editable profile.isAdministrator or LAN connectivity as native admin proof.

## Discover: all media

Keep movie/TV discovery and movie/TV request dialog using existing native `home`, `search`, `categories/{type}`, `media/{id}`, `request` endpoints. `home.requestSections` provides existing video discovery rows. The legacy category name `requests` and singular movie/TV `/request` API are deliberately retained; renaming UI navigation does not rename these APIs. The web accepts legacy `?tab=requests` links as Discover.

Add All media / Movies / TV / Music filters. For music:

- `GET /api/mobile/v1/music` -> `{configured, albums: MusicAlbum[], total}`: imported music library. Optional `offset` for library pagination; each page is up to 200 albums. Continue until loaded count reaches total.
- `GET /api/mobile/v1/music?q=<artist or album>` -> catalog album search via MusicBrainz (up to 30 results; refine query for more). Do not search on every keystroke: debounce and cancel obsolete calls.
- `GET /api/mobile/v1/music/album?albumId=<opaque id>` -> `{album: MusicAlbum, tracks: MusicTrack[]}`. Empty tracks means not imported/playable yet; show request state instead of pretending playback is available.
- `POST /api/mobile/v1/music/request` body `{musicbrainzId:"release-group UUID"}` -> `{success,message,status}`. This requests an **album** and automatically dispatches downloads to Soulseek (`slskd`). Track playback is supported; individual-track acquisition is not a separate HomeStream operation in this version. Respect pending/approval/error states and refresh Requested.

MusicAlbum: id, title, artist, optional year/releaseDate/coverUrl/trackCount, inLibrary and requested booleans. MusicTrack: opaque id, title, artist, album, trackNumber, discNumber, optional durationSeconds, streamUrl. Keep MusicAlbum/MusicTrack separate from the old video MediaItem type, whose type enum still contains only Movie/Series/Episode.

HomeStream's native Soulseek connection uses configured `slskd` credentials: explicit requests dispatch downloads without delivering service credentials to the client.

## Music and YouTube streaming

- `GET` or `HEAD /api/mobile/v1/music/stream?trackId=<opaque track id>`.
- Attach the HomeStream Authorization bearer header to the actual audio data source, including subsequent seek/range requests. Use Media3/ExoPlayer with an authenticated OkHttpDataSource/HttpDataSource.
- Streams are proxied from the fixed configured upstream, with client cancellation, Content-Type, Content-Length, Accept-Ranges, Content-Range, and HTTP 200/206/416 preserved. Support seeking; handle missing files and 502/503 as recoverable playback errors.
- `GET /api/mobile/v1/youtube/stream-video?videoId=<id>` proxies and streams YouTube audio/video with range requests and caching enabled.
- Use returned streamUrl/coverUrl. Native responses use `/api/mobile/v1/music/...` and `/api/mobile/v1/youtube/...`; web responses use `/api/v1/music/...`. Resolve relative URLs against the saved server origin.
- `GET /api/mobile/v1/music/artwork?albumId=...` is authenticated. Add the same bearer header to Coil/Glide requests.
- Provide persistent queue, play/pause, next/previous, track duration/seek controls and foreground audio service/media notification. Handle audio focus, headphone removal, cancellation, closing the player, profile changes and activity recreation. Starting video must stop music, and vice versa. Keep music playback alive across navigation, not across a forbidden Kids profile switch.

## Requested: unified queue

`GET /api/mobile/v1/requested` -> `{items: RequestedItem[], warnings: string[], updatedAt}`. Poll about every 10 seconds only while the screen is visible, prevent overlapping polls, cancel on exit, and refresh after successful movie/TV/music requests. One failing integration produces warnings while other services remain visible. Do not replace an unavailable service with fake/demo downloads.

RequestedItem: id, title, kind (`movie`/`tv`/`music`), source (`seerr`/`qbittorrent`/`slskd`), status; optional artist, posterUrl, releaseDate, requestedAt, progress, downloadSpeed, etaSeconds, media. `media` is an existing video MediaItem where available; use it to open the video detail/request flow. Progress is **0–100**, unlike raw qBittorrent's 0–1. Never confuse download progress with watched/playback progress. Missing/null/unknown progress is unknown, not 0 or 100.

Provide All media / Movies / TV / Music filters, a visible status label, determinate bar only for known progress, optional speed and reasonable ETA, and release date. The queue includes the latest up to 100 requests/history records per upstream and current downloads, scoped by connected account visibility.

## Admin integrations

Native endpoints: `GET /api/mobile/v1/integrations`, `POST /api/mobile/v1/integrations`. Require a **signed mobile administrator session** from Jellyfin login. Household/paired-device tokens and non-admin sessions receive 403 even on the LAN. Show Admin only when capabilities.canManageIntegrations is true; still handle server 403. Web uses `/api/v1/integrations` with its normal local/admin authorization policy.

GET -> `{integrations:[{id,name,url,configured,credentialSet,username?}], downloadsPath}`. IDs: jellyfin, seerr, qbittorrent, slskd. No stored API key/password/token is returned. POST:

```json
{"integration":"slskd","action":"save","url":"http://slskd-server:5030","secret":"new api key or blank to preserve"}
```

`action` is save or test. Test uses unsaved inputs without persisting them. Optional username for qBittorrent, downloadsPath for its backend-container mount, parentPin if configured. Blank secret preserves the existing credential. Clearing URL disconnects the integration. Mask secret fields, disable autofill/logging of submitted values, clear secrets from form state after save, and never place them in a URL. Configured parent/Kids policies still apply. HTTP(S) URLs may contain a deployment path but no embedded username/password, query or fragment.

## Safety and compatibility

Music has no verified content-rating source in this integration; Kids profiles are denied music and Admin endpoints server-side. Requested filters video content under existing parent policy and omits music/downloads for Kids. Do not bypass these restrictions in the UI or by selecting an adult profile locally. Preserve existing signed sessions, device credentials, Jellyfin profile IDs and release URL behavior. No Android code should change server media ownership or mount paths.

## Tests and acceptance for the Android AI

1. Existing port-3000 LAN scanning/pairing succeeds; public pairing and forged-forwarding-header attempts fail.
2. Old video routes, resume/progress/subtitles/casting remain functional.
3. Discover offers movies/TV/music; requesting one album is an explicit user action; repeated taps cannot launch duplicate requests.
4. Requested renders mixed fixture entries, unknown progress/date, year-only/month-only dates, future releases, paused/stalled/download/import/completed states, empty state and partial service failure.
5. Music library pagination, debounced search, album tracks, authenticated artwork and actual 206 range playback/seek work. Authorization survives media retries and seeks but is never sent to third-party hosts.
6. Queue survives screen navigation; switching track/profile, closing, starting video, loss of focus and activity recreation stop or transfer resources correctly.
7. Native Admin denies ordinary paired/user tokens, permits actual signed admin login, preserves blank saved credentials and never displays the stored secret.
8. Kids music/stream/admin requests remain 403; retries cannot evade server policy.
9. Use fake upstream fixtures for acquisition tests. Do not download arbitrary real albums while testing. Real-device decoding, background playback, audio focus and Android Auto/Cast remain Android-side acceptance checks.

Backend fixture coverage: `tests/music-integrations.test.ts`, `tests/requested-media.test.ts`, existing identity/parental/mobile tests. Web browser tests under `e2e/` cover the navigation, progress, Admin and music queue. Run backend build/tests/contract checks and compile generated Kotlin; then run Android unit/instrumented/player tests. See repository git history and CI for the final verified revision; this handoff is maintained with the implementation.
