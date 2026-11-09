# HomeStream mobile API v1

Set `HOMESTREAM_MOBILE_TOKEN` to a random secret of at least 32 characters
(`openssl rand -hex 32`), restart HomeStream, and enter the same token and server
URL in the Android app. All `/api/mobile/v1/*` endpoints require
`Authorization: Bearer <token>`. They fail closed with 503 when unconfigured and
401 for an invalid token. Serve the API over HTTPS outside a trusted LAN.

The token grants household access to existing HomeStream media and profiles,
including requests. Profiles select watch history, not user authorization. This
API does not change the web frontend's authentication or expose server setup.
Rotate the token and re-pair devices to revoke access. Do not share it publicly.

| Method | Path after `/api/mobile/v1/` | Response / input |
| --- | --- | --- |
| GET | capabilities | apiVersion, appName, cast |
| GET | profiles | profiles: UserProfile[] |
| GET | home?userId=… | Existing hero, sections, requestSections, isDemoMode |
| GET | library/movies or library/tv?userId=…&search=… | items: MediaItem[] |
| GET | media/:id?userId=… | item: MediaItem (including seasons/episodes) |
| GET | playback?itemId=…&userId=…&forceTranscode=true | streamUrl, isTranscoding, durationSeconds |
| GET | subtitles?itemId=… | subtitles: SubtitleTrack[] |
| POST | progress | {itemId, userId, positionTicks, isPaused, isStopped} |
| POST | request | Existing RequestMediaPayload (mediaType, mediaId, seasons) |
| GET | music?q=…&offset=… | configured: boolean, albums: MusicAlbum[], total: number |
| GET | music/album?albumId=… | album: MusicAlbum, tracks: MusicTrack[] |
| POST | music/request | {musicbrainzId: string} -> album request & slskd download dispatch |
| GET | music/stream?trackId=… | Authenticated audio byte-range streaming proxy |
| GET | music/artwork?albumId=… | Authenticated cover art proxy |
| GET | youtube/recommendations | hero: MediaItem, sections: RowSection[] |
| GET | youtube/stream-video?videoId=… | Authenticated YouTube video/audio streaming proxy with range seeking |

Types are defined in `src/types/index.ts`. Ticks are 100 nanoseconds. Responses
are `no-store`. Error responses contain `error`. HomeStream may explicitly return
demo data if Jellyfin is absent or unavailable; the native client labels this.
Library search uses the existing library endpoint so it searches actual Jellyfin
items rather than returning Seerr discovery results alone.

## Stream networking and Chromecast

Playback reuses HomeStream's Jellyfin negotiation (H.264/AAC fallback), including
its signed/credential-bearing Jellyfin URLs. These are sensitive and must not be
logged or shared. The phone/TV and Chromecast must reach the configured Jellyfin
URL, not just HomeStream. Container-only hostnames and localhost will not work.
Use a receiver-accessible LAN name or HTTPS address and configure Jellyfin CORS
for Google Cast receivers. HTTPS must have a trusted certificate; Chromecast
cannot use the app's pairing header or phone-only VPN connection. The default
Google Cast media receiver is used, so no custom receiver registration is needed.
Cast requests force compatible HLS transcoding. Test with your actual codecs and
Jellyfin transcoding configuration before rollout.

## Local validation

`npm run test:mobile` starts an isolated development server with temporary data
and test credentials, verifies disabled/invalid auth, demo feed and details,
profiles/libraries, playback/progress input validation and unavailable routes,
and shuts the server down. A fake Jellyfin upstream also verifies H.264/AAC
negotiation and profile-linked progress/stop requests. No real Jellyfin or Seerr
server is required.
`npm run build` type-checks and builds the complete existing frontend.
The repository's general `npm run lint` currently reports pre-existing errors
outside this API; the new route is separately linted in the Mobile API workflow.
