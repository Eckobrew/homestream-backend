# Deploying the two-service split

## Topology

One public address serves Nginx on port 3000. `/api/*` goes to the backend on 3001; other paths go to Next.js on 3002. Existing Android URLs, device tokens, signed sessions, profile mappings and webhook paths remain valid when the hostname, signing secrets and data files are retained.

The backend is the only owner of `config.json`, `profiles.json`, `devices.json` and `parental-controls.json`. Preserve the entire data directory, not just profiles. Version 1.1 imports these legacy files into SQLite using an explicit migration. See [the upgrade guide](follow-up-release.md) before starting it.

## Docker

Place the checkouts next to each other:

```
parent/
  homestream-backend/
  homestream-web/
```

Copy `.env.example` to `.env` in the backend checkout and retain your existing integration settings and signing secrets. Set `HOMESTREAM_EXTERNAL_URL` to the public URL. Do not put these secrets in the web repository. Compose 2.24+ is required.

From `homestream-backend`:

```bash
export HOMESTREAM_DATA_PATH=/absolute/path/to/existing/data
export HOMESTREAM_DOWNLOADS_PATH=/absolute/path/to/downloads
docker compose -f deploy/compose.yml build
docker compose -f deploy/compose.yml up -d
```

The data directory must be writable by UID/GID 1001. The downloads mount is read-only. Add `-f deploy/compose.gpu.yml` and the host render/video group IDs to enable `/dev/dri` where available. Adjust the fixed Compose subnet and trusted proxy address together if they overlap your network.

The default image tags are paired `1.1.0` versions. Use the image release workflow and publish both repositories before using remote images; local builds work without publication. Override `HOMESTREAM_BACKEND_IMAGE` and `HOMESTREAM_WEB_IMAGE` together for a tested release pair. Docker build public branding arguments can be supplied with `--build-arg NEXT_PUBLIC_APP_NAME=... --build-arg NEXT_PUBLIC_APP_URL=...` when building the web image directly.

## Proxy identity and pairing

`HOMESTREAM_TRUSTED_PROXIES` accepts explicit IPs or CIDRs. Only configure actual reverse proxies; never trust an entire LAN or all addresses. The deprecated `HOMESTREAM_TRUST_PROXY=true` setting is deliberately ignored because it trusted client-controlled headers.

Nginx overwrites forwarded identity with its socket client. When placing another proxy in front of Nginx, configure Nginx `set_real_ip_from <exact-proxy-address>` and `real_ip_header X-Forwarded-For` (plus `real_ip_recursive on` for a known chain). Confirm the actual external client reaches backend identity checks. Do not expose the stack behind a TCP proxy that hides public clients as private peers.

Proxied requests cannot automatically pair a household device. Existing paired devices keep working on the public address. For **new** automatic local pairing, optionally bind the backend port to a LAN-only host address:

```bash
export HOMESTREAM_PAIRING_BIND=192.168.1.20
docker compose -f deploy/compose.yml up -d
```

Connect the new client directly to `http://192.168.1.20:3001` for pairing; the backend returns `HOMESTREAM_EXTERNAL_URL` for subsequent remote access. Restrict 3001 to the trusted LAN with your host firewall. Android versions that scan only port 3000 will need manual server entry or a discovery update for this direct pairing address. Remote Jellyfin login remains available through port 3000. Never weaken proxy identity checks to recover automatic pairing through the gateway.

## LXC

The scripts operate **inside an existing Debian LXC**; they do not create or alter a Proxmox host. Install Node.js 22+, copy both checkouts to `/opt/homestream-backend` and `/opt/homestream-web`, then run `scripts/install-lxc.sh` as root. It installs Nginx/FFmpeg and separate systemd services; npm builds run as `homestream`. Backend configuration belongs in `/etc/homestream/backend.env`, data in `/var/lib/homestream`. Preserve existing secrets and copy existing data before cutover.

By default both application services bind to loopback. New direct pairing can use an SSH tunnel to backend port 3001, or an explicitly configured LAN binding and firewall. Do not forward that port publicly.

After checking out tested revisions in both repositories, `scripts/update-lxc.sh` builds staged copies of both repositories, then swaps runtime artifacts and restarts them. It refuses dirty working trees and does not pull/reset code. A failed restart or health check restores the previous artifacts. Back up data before updates; retained runtime artifacts do not replace a data backup.

## Cutover and rollback

1. Back up the old deployment configuration, image/revision, secrets and complete data directory. Record current Android/public URLs.
2. Build both applications and run the backend, mobile, torrent and UI checks. Verify representative Jellyfin/Seerr requests against your actual stack.
3. Stop the old writer before starting the extracted backend against its data. Reuse the public address and secrets. Deploy gateway, backend and web together.
4. Verify login, paired Android access, parent PIN and Kids policies, requests, playback, seeking, subtitles and progress. Check `/health/ready` internally and `/health` through the gateway.
5. Validate Cast and hardware decoding on actual receiver hardware. Receivers must still reach Jellyfin or issued HomeStream resource URLs.
6. On failure, stop the new backend, restore the saved configuration/image and data backup, and start the old deployment. Never run both writers simultaneously.

The Docker prerelease was deployed and validated in LXC 111 on 8 November 2026 with local fixes; see [Docker upgrade fixes](docker-upgrade-fixes.md). Main image publication is now automated; deployments remain deliberate.

## Optional Android pairing through the gateway

For clients restricted to discovery/pairing on port 3000, the backend can opt in with `HOMESTREAM_ALLOW_PROXY_PAIRING=true`. Only an explicitly trusted gateway socket can assert `X-HomeStream-Local-Pairing: 1`, with exactly one valid forwarded client address; that client must still be a local address. Default deployments reject proxied pairing.

The gateway MUST overwrite this header on every API request. Set it to `1` only for direct connections from the verified home LAN to the LAN IP host, with no incoming forwarding headers, excluding every upstream reverse-proxy socket. Keep it empty for public hostnames, upstream proxies and all other requests. Use the original socket (`$realip_remote_addr`), not the client address rewritten by nginx realip, for this decision. Do not enable the backend option with an unconfigured gateway or trust broad network ranges as proxies.
