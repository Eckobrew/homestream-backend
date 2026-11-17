# Native Media Engine & Transcoding

## Library Scanning & TMDB Matching

- `startNativeLibraryMonitor()` polls enabled libraries every 30 seconds against their `scanIntervalMinutes` (default `60` minutes) and scans on startup.
- Movies (`/movies`) and TV series (`/tv`) are matched against TMDB for titles, overviews, artwork, certifications/ratings (`rating`), and per-episode titles (`fetchTmdbSeasonEpisodes`).
- Disk reconciliation removes stale `native_media_files` entries when files disappear while preserving `native_watch_history`.

## VA-API CQP Transcoding

- Uses `/dev/dri/renderD128` (`h264_vaapi`) with `-rc_mode CQP -qp 21` (producing 8-bit `High` `yuv420p` HLS segments) and falls back cleanly to software `libx264` when VA-API is unavailable.
- Bitmap subtitles (`hdmv_pgs_subtitle`, `dvd_subtitle`) are burned in via `overlay` when selected; text subtitles are served as WebVTT.
- Active transcode sessions are kept alive by `touchNativeTranscodeSessionByItem()` on `/api/playback/progress` heartbeats with a 5-minute minimum reaper idle timeout.

## Trickplay Thumbnails

- `generateTrickplayForFile()` extracts keyframes (`-skip_frame nokey`) into a single `sprite.jpg` + `trickplay.vtt` per file under `/app/data/artwork/trickplay/<fileId>/`.
- Triggered automatically for new files when `enableTrickplay` is enabled, or on demand via `POST /api/native/library` (`{ "action": "generateTrickplay", "fileId": "..." }`).
