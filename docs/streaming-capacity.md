# Video encoder capacity

Admin → Native Library → Playback / Transcoding exposes **Maximum simultaneous video encodes (1080p)**. The saved `maxConcurrentTranscodes` value is shared by native HLS, torrent/download conversions, and offline exports. Direct play and video-copy remuxes consume no encoder slots. A 4K source or a source above 30 fps consumes extra slots; a single heavy stream remains admissible when the configured limit is one. New encodes receive HTTP 503 with `Retry-After: 5` at capacity. Existing encodes are retained rather than evicted.

The hardware setting also applies to torrent/download and offline MP4 output. A working selected VAAPI encoder uses `h264_vaapi`, an explicit DRM device and NV12 upload. Hardware selection is verified by an actual encoder probe.

## LXC 111 measurement, 17 November 2026

The LXC has four CPU cores, 2 GiB RAM and an Intel i915 GPU (PCI device 1912). Tests ran inside its backend container using actual HEVC Main10 library files, H.264 VAAPI encoding, AAC stereo, HLS segments and the configured 20 Mbps ceiling. Both sources were SDR, approximately 24 fps; subtitle burn-in and HDR tone mapping were not part of the measured workload.

| Workload | Concurrent encodes | Minimum measured speed |
| --- | ---: | ---: |
| 1080p | 1 | 4.29× realtime |
| 1080p | 2 | 2.11× realtime |
| 1080p | 3 | 1.34× realtime |
| 1080p | 4 | 1.07× realtime |
| 4K | 1 | 1.39× realtime |
| 4K | 2 | 0.82× realtime |

The screening threshold was at least 1.2× realtime for every stream. Set capacity to **2**: one below the measured 1080p capacity with headroom, while a 4K encode reserves both slots. Different source complexity, frame rates, subtitles and HDR filters can change throughput. Benchmark logs and the private source selection are retained on the LXC under `/root/homestream-encode-benchmark`; source paths are not recorded in this repository.

A separate 65-second validation passed at the configured operating points: two 1080p encodes each maintained at least 2.12× realtime (915 MiB peak LXC memory), and one 4K encode maintained 1.38× (1,100 MiB). Health requests remained below 20 ms during these checks.
