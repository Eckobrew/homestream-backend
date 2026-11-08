#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
mode="${1:---inspect}"
case "$mode" in
  --help) echo 'HomeStream LXC 111: --verify | --inspect (default) | --upgrade | --rollback RECEIPT_ID'; exit 0 ;;
  --verify|--inspect|--upgrade|--rollback) ;;
  *) echo 'Unknown option. Use --help.' >&2; exit 2 ;;
esac
work="$(mktemp -d /tmp/homestream-package.XXXXXXXX)"
trap 'rm -rf -- "$work"' EXIT
line="$(awk '/^__HOMESTREAM_PAYLOAD_BELOW__$/ {print NR + 1; exit}' "$0")"
tail -n +"$line" "$0" > "$work/payload.tar.gz"
printf '%s  %s\n' '@PAYLOAD_SHA256@' "$work/payload.tar.gz" | sha256sum --check --status || { echo 'Package checksum failed.' >&2; exit 1; }
if [[ "$mode" == --verify ]]; then echo 'Embedded payload checksum verified.'; exit 0; fi
[[ $(id -u) -eq 0 ]] && command -v pct >/dev/null || { echo 'Run this package as root in the Proxmox node shell.' >&2; exit 1; }
[[ $(pct status 111) == 'status: running' ]] || { echo 'LXC 111 must be running.' >&2; exit 1; }
[[ $(pct exec 111 -- uname -m) == x86_64 ]] || { echo 'This package requires an x86_64 container.' >&2; exit 1; }
pct exec 111 -- test -f /etc/debian_version || { echo 'This installer supports Debian/Ubuntu containers.' >&2; exit 1; }
if [[ "$mode" == --rollback ]]; then
  id="${2:-}"
  [[ "$id" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+$ ]] || { echo 'Specify the receipt ID printed during upgrade.' >&2; exit 2; }
  pct exec 111 -- bash "/root/homestream-upgrades/$id/rollback.sh"
  exit
fi
tar -xzf "$work/payload.tar.gz" -C "$work"
if [[ "$mode" == --inspect ]]; then
  temporary="$(pct exec 111 -- mktemp -d /tmp/homestream-inspect.XXXXXXXX)"
  [[ "$temporary" =~ ^/tmp/homestream-inspect\.[a-zA-Z0-9]+$ ]] || exit 1
  cleanup_inspect() { pct exec 111 -- rm -rf -- "$temporary" >/dev/null 2>&1 || true; rm -rf -- "$work"; }
  trap cleanup_inspect EXIT
  pct push 111 "$work/runtime/bin/node" "$temporary/node" --perms 0700
  pct push 111 "$work/tools/inspect.cjs" "$temporary/inspect.cjs" --perms 0600
  pct exec 111 -- "$temporary/node" "$temporary/inspect.cjs"
  echo 'Inspection complete. To install: bash /root/homestream-upgrade-lxc111.run --upgrade'
  exit
fi
id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
host_receipt="/root/homestream-upgrades/111/$id"
receipt="/root/homestream-upgrades/$id"
release="/opt/homestream-split/releases/$id"
install -d -m 700 "$host_receipt"
pct config 111 > "$host_receipt/container.conf"
echo "Upgrade receipt: $id"
pct exec 111 -- install -d -m 700 "$receipt"
pct push 111 "$work/payload.tar.gz" "$receipt/payload.tar.gz" --perms 0600
pct exec 111 -- install -d -m 755 "$release"
pct exec 111 -- tar -xzf "$receipt/payload.tar.gz" -C "$release"
pct exec 111 -- bash "$release/tools/upgrade-guest.sh" "$release" "$receipt"
printf '\nRollback from the Proxmox shell:\nbash /root/homestream-upgrade-lxc111.run --rollback %s\n' "$id"
echo 'Container addresses:'
pct exec 111 -- hostname -I
exit 0
__HOMESTREAM_PAYLOAD_BELOW__
