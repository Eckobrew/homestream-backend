#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
mode="${1:---inspect}"
if [[ $# -gt 0 ]]; then shift; fi
case "$mode" in
 --help) echo 'HomeStream Docker LXC 111: --verify | --inspect [--container NAME] | --upgrade [--container NAME] [--data-dir CONTAINER_PATH] | --rollback RECEIPT_ID'; exit 0 ;;
 --verify|--inspect|--upgrade|--rollback) ;;
 *) echo 'Unknown option. Use --help.' >&2; exit 2 ;;
esac
work="$(mktemp -d /tmp/homestream-docker-package.XXXXXXXX)"
trap 'rm -rf -- "$work"' EXIT
line="$(awk '/^__HOMESTREAM_PAYLOAD_BELOW__$/ {print NR + 1; exit}' "$0")"
tail -n +"$line" "$0" > "$work/payload.tar.gz"
printf '%s  %s\n' '@PAYLOAD_SHA256@' "$work/payload.tar.gz" | sha256sum --check --status || { echo 'Package checksum failed.' >&2; exit 1; }
if [[ "$mode" == --verify ]]; then echo 'Embedded payload checksum verified.'; exit 0; fi
[[ $(id -u) -eq 0 ]] && command -v pct >/dev/null || { echo 'Run as root in the Proxmox node shell.' >&2; exit 1; }
exec 9>/run/lock/homestream-docker-lxc111.lock
flock -n 9 || { echo 'Another installer is running.' >&2; exit 1; }
[[ $(pct status 111) == 'status: running' ]] || { echo 'LXC 111 must be running.' >&2; exit 1; }
[[ $(pct exec 111 -- uname -m) == x86_64 ]] || { echo 'This bundle requires an x86_64 LXC with glibc >=2.28.' >&2; exit 1; }
pct exec 111 -- test -S /var/run/docker.sock || { echo 'Docker must be running inside LXC 111.' >&2; exit 1; }
if [[ "$mode" == --rollback ]]; then
 id="${1:-}"
 [[ "$id" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+$ ]] || { echo 'Specify the receipt ID printed during upgrade.' >&2; exit 2; }
 pct exec 111 -- bash "/root/homestream-docker-upgrades/$id/rollback.sh"
 exit
fi
# Limit accepted arguments; no shell evaluation is used for user/container settings.
forward=()
while [[ $# -gt 0 ]]; do
 case "$1" in
  --container|--data-dir) [[ $# -ge 2 && -n "$2" ]] || exit 2; forward+=("$1" "$2"); shift 2 ;;
  *) echo 'Unknown argument.' >&2; exit 2 ;;
 esac
done
temporary="$(pct exec 111 -- mktemp -d /root/homestream-docker-payload.XXXXXXXX)"
[[ "$temporary" =~ ^/root/homestream-docker-payload\.[a-zA-Z0-9]+$ ]] || exit 1
# Retain this payload after upgrade: rollback uses its bundled runtime and script.
cleanup() { rm -rf -- "$work"; if [[ "$mode" == --inspect ]]; then pct exec 111 -- rm -rf -- "$temporary" >/dev/null 2>&1 || true; fi; }
trap cleanup EXIT
pct push 111 "$work/payload.tar.gz" "$temporary/payload.tar.gz" --perms 0600
pct exec 111 -- tar -xzf "$temporary/payload.tar.gz" -C "$temporary"
pct exec 111 -- chmod 755 "$temporary/runtime/bin/node"
if [[ "$mode" == --upgrade ]]; then
 id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
 install -d -m 700 "/root/homestream-docker-upgrades/111/$id"
 pct config 111 > "/root/homestream-docker-upgrades/111/$id/container.conf"
fi
pct exec 111 -- "$temporary/runtime/bin/node" "$temporary/tools/docker/upgrade.cjs" "$mode" "${forward[@]}"
exit 0
__HOMESTREAM_PAYLOAD_BELOW__
