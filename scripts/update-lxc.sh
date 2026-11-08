#!/usr/bin/env bash
# Update checked-out revisions using staged builds and health-checked artifact swaps.
set -euo pipefail
backend_dir="$(cd "$(dirname "$0")/.." && pwd)"
web_dir="${HOMESTREAM_WEB_DIR:-$(dirname "$backend_dir")/homestream-web}"
[[ $(id -u) -eq 0 ]] || { echo 'Run inside the LXC as root.' >&2; exit 1; }
for checkout in "$backend_dir" "$web_dir"; do
  [[ -z $(git -C "$checkout" status --porcelain) ]] || { echo "Working tree has changes: $checkout" >&2; exit 1; }
done
staging="$(mktemp -d /opt/homestream-update-XXXXXXXX)"
mkdir -p "$staging/backend" "$staging/web" "$staging/previous-backend" "$staging/previous-web"
stopped=0
rollback() {
  trap - ERR
  if [[ "$stopped" == 1 ]]; then
    systemctl stop homestream-backend homestream-web || true
    for app in backend web; do
      target="$backend_dir"; artifact=dist
      [[ "$app" == backend ]] || { target="$web_dir"; artifact=.next; }
      for item in "$artifact" node_modules; do
        if [[ -d "$staging/previous-$app/$item" ]]; then
          rm -rf -- "$target/$item"
          mv "$staging/previous-$app/$item" "$target/$item"
        fi
      done
    done
    systemctl start homestream-backend homestream-web || true
  fi
  echo "Update failed; previous artifacts restored where swapped. Inspect $staging." >&2
  exit 1
}
trap rollback ERR
for app in backend web; do
  checkout="$backend_dir"
  [[ "$app" == backend ]] || checkout="$web_dir"
  tar -C "$checkout" --exclude=.git --exclude=node_modules --exclude=.next --exclude=dist --exclude=data --exclude='.env*' --exclude='*.tgz' -cf - . | tar -C "$staging/$app" -xf -
  chown -R homestream:homestream "$staging/$app"
  # mktemp creates a root-only parent; permit the service account to traverse it.
  chmod 755 "$staging"
  runuser -u homestream -- bash -c 'cd "$1" && npm ci && npm run build' -- "$staging/$app"
done
systemctl stop homestream-backend homestream-web
stopped=1
for app in backend web; do
  target="$backend_dir"; artifact=dist
  [[ "$app" == backend ]] || { target="$web_dir"; artifact=.next; }
  for item in "$artifact" node_modules; do
    [[ ! -d "$target/$item" ]] || mv "$target/$item" "$staging/previous-$app/$item"
    mv "$staging/$app/$item" "$target/$item"
  done
done
systemctl start homestream-backend homestream-web
curl --fail --silent --show-error --retry 10 --retry-connrefused --retry-delay 1 http://127.0.0.1:3001/health/ready
curl --fail --silent --show-error --retry 10 --retry-connrefused --retry-delay 1 http://127.0.0.1:3002/health
trap - ERR
rm -rf -- "$staging/backend" "$staging/web"
printf '\nUpdated. Previous runtime artifacts retained in %s.\n' "$staging"
