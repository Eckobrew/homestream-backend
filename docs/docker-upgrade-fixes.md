# Docker upgrade fixes after the LXC 111 prerelease

The original `docker-split-upgrade-v1.1.0-rc.1` asset is historical and remains unchanged. Do not reuse it as a corrected installer. The source fixes below must be included when building the next package.

- Backend payload files are copied with UID/GID 1001 ownership. Private files from package assembly previously could not be read by the non-root process.
- Debian sources use HTTPS. Package assembly supplies the build machine's public CA bundle for HTTPS bootstrap; certificate validation stays enabled. Production credentials must never be included in that bundle.
- The generated nginx config explicitly receives mode 0644 after rewrite: creating it at mode 0600 and then using `writeFileSync` with a mode does not change an existing inode's permissions. Receipt directories stay private.
- Gateway, backend and web receive distinct explicit addresses on their new private network. Automatic backend allocation previously consumed the gateway's planned address.

`node delivery/docker/test-upgrade.cjs` runs after `npm run build` and uses temporary fixtures rather than a hard-coded cloud path. It verifies migration, retained media settings and published ports, distinct network addresses, nginx config readability, successful manual rollback, and automatic rollback after stop/create/readiness failures. It never talks to the real Docker daemon. CI also builds and starts the production image as UID 1001.

The running LXC deployment already contains these fixes. Its migrated database and retained rollback payload are separate from repository checkouts; changing source does not redeploy or move live state. Do not redeploy the original Compose definition against that installation. Preserve the live receipt, rollback runtime, secrets and media mappings for future controlled updates.
