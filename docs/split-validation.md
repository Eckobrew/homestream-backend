# Split validation

Baseline: original HomeStream revision `7505a9b06ce44770f7ddb86904633e478b6988e1`.

## Passed

- Independent backend TypeScript check and production bundle.
- Independent Next.js production build, web TypeScript check and browser-capability checks.
- Backend HTTP adapters, socket/proxy identity, authorization, direct pairing, canonical/legacy route parity, atomic state writes, concurrent profile edits, PIN/profile lock ordering and log-redaction tests.
- Ten public API response fixtures captured from the original running monolith match the extracted API.
- Existing mobile integration suite, adapted to start the standalone backend: authentication, protected routes, upstream credential scope, episode ordering, watched state, playback negotiation, history, parental filtering, signed resource tickets, byte ranges and path confinement.
- Real-socket synthetic torrent tests: verified-piece gating, concurrent FFmpeg conversion, valid MP4 output, duration probing and child cleanup on disconnect.
- Generated contract consistency, shared web/backend contract snapshot equality and distributable API package creation.
- Three Chromium checks against the standalone web runtime, backend and local gateway: first-run rendering, browsing/deep links, and login failure reporting. Browsing mocks configured profile/setup state and uses the real backend demo catalog.
- Backend and web Docker image builds. Temporary validation images were removed after testing to recover disk space.
- Compose configuration parsing, Nginx configuration validation in the actual unprivileged image, and LXC shell syntax checks.

## Limits

The complete Compose stack could not be started together: this environment's VFS Docker driver exhausted the available disk while creating runtime layers. Temporary containers and build layers were removed. The browser suite used its local HTTP gateway rather than the Nginx deployment.

Real Jellyfin/Seerr/qBittorrent installations, hardware acceleration, Cast receivers and Android/TV devices were not available. Their migration acceptance checks remain in the deployment guide. LXC scripts were syntax-checked, not installed on a Proxmox guest.

The initial split covered core JSON models; the 1.1 follow-up below completes the operation/query schemas. No performance benchmark, remote GitHub publication, registry release or production cutover was performed.

## Follow-up release 1.1 verification

After the workspace recovered, both repositories passed production builds, TypeScript checks and their ESLint 10 baselines. All 13 backend tests passed, including SQLite migration, private backup permissions, concurrent state edits, conversion limits/timeouts, failure handling and API compatibility. The mobile/parental-control integration suite and real-socket torrent/FFmpeg checks also passed on Node.js 22.23.4, matching the production major version. Node 22 reports its built-in SQLite API as experimental.

The complete 1.1 contract now covers 58 web/native operations, superseding the initial partial-schema limitation above. Contract generation, compatibility checks, an intentionally breaking-contract regression and package creation passed. Generated Kotlin/OkHttp bindings compiled for Java 8 bytecode using JDK 21. Mixed JSON unions are represented by JsonElement; stream calls leave response-body ownership with the caller.

Five browser journeys cover resume/pause/seeking/subtitles/episode changes and timer cleanup, unavailable playback, browsing/deep links, login errors, and actual first-run form submission with recovery from a bad server address. They use local test services/media rather than household infrastructure. The final recovered-workspace rerun passed all five journeys.

Real Cast/Android TV hardware, GPU acceleration and target-LXC capacity measurements remain deployment acceptance checks. No production data migration, publication or deployment has been performed.
