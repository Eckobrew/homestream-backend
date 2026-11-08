#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
release="$1"
receipt="$2"
node="$release/runtime/bin/node"
[[ $(id -u) -eq 0 ]] || { echo 'Run through the Proxmox wrapper as root.' >&2; exit 1; }
[[ "$release" == /opt/homestream-split/releases/* && "$receipt" == /root/homestream-upgrades/* ]] || exit 1
[[ -x "$node" && -d "$release/backend/dist" && -d "$release/web/.next" ]] || { echo 'Incomplete release payload.' >&2; exit 1; }
exec 9>/run/lock/homestream-split-upgrade.lock
flock -n 9 || { echo 'Another HomeStream upgrade is running.' >&2; exit 1; }
install -d -m 700 "$receipt"
cutover=0
policy_created=0
cleanup_policy() {
  if [[ "$policy_created" == 1 ]]; then
    if [[ $(cat /usr/sbin/policy-rc.d 2>/dev/null) == $'#!/bin/sh\n# homestream-upgrade-temporary\nexit 101' ]]; then rm -f /usr/sbin/policy-rc.d; fi
    policy_created=0
  fi
}
failed() {
  trap - ERR INT TERM
  cleanup_policy
  if [[ "$cutover" == 1 && -f "$receipt/rollback.sh" ]]; then
    echo 'Upgrade health checks failed; restoring the previous service.' >&2
    bash "$receipt/rollback.sh" || echo "Rollback needs attention. Run bash $receipt/rollback.sh inside this container." >&2
  else
    echo 'Upgrade stopped before service cutover. The previous application was not replaced.' >&2
  fi
  echo "Private details and backups: $receipt" >&2
  exit 1
}
trap failed ERR INT TERM
"$node" "$release/tools/inspect.cjs" --private > "$receipt/plan.json"
field() { "$node" -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=p[process.argv[2]];process.stdout.write(String(v));' "$receipt/plan.json" "$1"; }
service="$(field service)"
old_root="$(field root)"
old_data="$(field dataDir)"
public_port="$(field port)"
nginx_was_active="$(field nginxWasActive)"
nginx_was_enabled="$(field nginxWasEnabled)"
old_was_enabled="$(field wasEnabled)"
[[ "$service" == homestream.service || "$service" == homeflix.service ]] || exit 1
[[ ! -e /etc/nginx/conf.d/homestream-split.conf ]] || { echo 'An existing split gateway configuration needs manual review.' >&2; exit 1; }
for port in 3001 3002; do
  if ss -H -lnt "sport = :$port" | read -r _; then echo "Internal port $port is occupied; no cutover performed." >&2; exit 1; fi
done
available_kb="$(df -Pk /opt | awk 'NR==2 {print $4}')"
data_kb=0
if [[ -d "$old_data" ]]; then data_kb="$(du -sk "$old_data" | awk '{print $1}')"; fi
[[ "$available_kb" -ge $((data_kb * 3 + 524288)) ]] || { echo 'At least 512 MiB plus three times the state-directory size must remain free.' >&2; exit 1; }
"$node" "$release/tools/configure.cjs" "$receipt/plan.json" "$release" "$receipt"
for command in curl ffmpeg nginx runuser; do
  if ! command -v "$command" >/dev/null; then needs_packages=1; fi
done
if [[ ${needs_packages:-0} == 1 ]]; then
  echo 'Installing missing runtime packages inside LXC 111; package-manager output is kept in the private receipt.'
  if [[ ! -e /usr/sbin/policy-rc.d ]]; then
    printf '#!/bin/sh\n# homestream-upgrade-temporary\nexit 101\n' > /usr/sbin/policy-rc.d
    chmod 755 /usr/sbin/policy-rc.d
    policy_created=1
  fi
  DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=60 update > "$receipt/packages.log" 2>&1
  DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=60 install -y nginx ffmpeg curl util-linux >> "$receipt/packages.log" 2>&1
  cleanup_policy
  # A newly installed nginx must not open its default port-80 site.
  if [[ $(field nginxWasInstalled) == false ]]; then
    if [[ -L /etc/nginx/sites-enabled/default ]]; then rm /etc/nginx/sites-enabled/default; fi
  fi
fi
if ! id homestream >/dev/null 2>&1; then useradd --system --home /var/lib/homestream --create-home homestream; fi
[[ $(id -u homestream) -ne 0 ]] || { echo 'The homestream account must not be root.' >&2; exit 1; }
# Only the new release and copied state are changed; original code/data stay untouched.
find "$release" -type d -exec chmod 755 {} +
find "$release" -type f -exec chmod 644 {} +
chmod 755 "$node"
if [[ $(field qbitConfigured) == true ]]; then
  downloads="$(field downloadsPath)"
  if ! runuser -u homestream -- test -r "$downloads" || ! runuser -u homestream -- test -x "$downloads"; then
    echo 'The homestream account cannot read/traverse the configured downloads directory. Grant it access and rerun; the old service is still running.' >&2
    exit 1
  fi
fi
cat > "$receipt/rollback.sh" <<ROLLBACK
#!/usr/bin/env bash
set -euo pipefail
systemctl stop homestream-backend.service homestream-web.service || true
systemctl disable homestream-backend.service homestream-web.service >/dev/null 2>&1 || true
rm -f /etc/nginx/conf.d/homestream-split.conf
rm -f /etc/systemd/system/homestream-backend.service /etc/systemd/system/homestream-web.service
systemctl daemon-reload
if [[ '$nginx_was_active' == true ]]; then nginx -t && systemctl reload nginx; else systemctl stop nginx || true; fi
if [[ '$nginx_was_enabled' == true ]]; then systemctl enable nginx >/dev/null 2>&1; else systemctl disable nginx >/dev/null 2>&1 || true; fi
if [[ '$old_was_enabled' == true ]]; then systemctl enable '$service' >/dev/null 2>&1; fi
systemctl start '$service'
echo 'Previous application service restored. Original code, environment and state were retained.'
ROLLBACK
chmod 700 "$receipt/rollback.sh"
systemctl cat "$service" > "$receipt/old-service.unit"
"$node" -e 'const fs=require("fs"),cp=require("child_process"),p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));fs.mkdirSync(process.argv[2],{mode:0o700});p.environmentFiles.forEach((file,i)=>fs.copyFileSync(file,`${process.argv[2]}/${i}.env`));' "$receipt/plan.json" "$receipt/environment-backup"
echo 'Staging is complete. Stopping the old writer briefly for the consistent state backup and migration.'
cutover=1
systemctl stop "$service"
install -d -m 750 -o homestream -g homestream "$release/data"
if [[ -d "$old_data" ]]; then
  tar -C "$old_data" -cpf "$receipt/state-before.tar" .
  tar -C "$release/data" -xpf "$receipt/state-before.tar" --no-same-owner
fi
chown -R homestream:homestream "$release/data"
if [[ -f "$release/data/homestream.sqlite" ]]; then
  echo 'An existing SQLite database was copied; its integrity will be checked before startup.'
elif [[ -f "$release/data/config.json" || -f "$release/data/profiles.json" || -f "$release/data/devices.json" || -f "$release/data/parental-controls.json" ]]; then
  runuser -u homestream -- "$node" "$release/backend/dist/import-state.js" "$release/data" > "$receipt/migration.log" 2>&1
  "$node" "$release/tools/verify-state.cjs" "$old_data" "$release/data" >> "$receipt/migration.log" 2>&1
else
  echo 'The old installation has no state files; its environment configuration is preserved.'
fi
for app in backend web; do
  if [[ "$app" == backend ]]; then port=3001; entry="$release/backend/dist/server.js"; else port=3002; entry="$release/web/server.js"; fi
  cat > "/etc/systemd/system/homestream-$app.service" <<UNIT
[Unit]
Description=HomeStream $app (split release)
After=network.target
[Service]
User=homestream
Group=homestream
WorkingDirectory=$release/$app
Environment=NODE_ENV=production
Environment=PORT=$port
Environment=HOST=127.0.0.1
Environment=HOSTNAME=127.0.0.1
Environment=DATA_DIR=$release/data
EnvironmentFile=$receipt/$app.env
ExecStart=$node $entry
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
TimeoutStopSec=30
[Install]
WantedBy=multi-user.target
UNIT
  chmod 644 "/etc/systemd/system/homestream-$app.service"
done
install -m 644 "$receipt/nginx.conf" /etc/nginx/conf.d/homestream-split.conf
nginx -t > "$receipt/nginx-check.log" 2>&1
systemctl daemon-reload
systemctl enable --now homestream-backend.service homestream-web.service > "$receipt/start.log" 2>&1
curl --fail --silent --show-error --retry 15 --retry-connrefused --retry-delay 1 --retry-max-time 45 --max-time 5 http://127.0.0.1:3001/health/ready > "$receipt/backend-health.json"
curl --fail --silent --show-error --retry 15 --retry-connrefused --retry-delay 1 --retry-max-time 45 --max-time 5 http://127.0.0.1:3002/health > "$receipt/web-health.json"
systemctl enable nginx >> "$receipt/start.log" 2>&1
if systemctl is-active --quiet nginx; then systemctl reload nginx; else systemctl start nginx; fi
curl --fail --silent --show-error --max-time 10 "http://127.0.0.1:$public_port/health" > "$receipt/gateway-health.json"
curl --fail --silent --show-error --max-time 10 "http://127.0.0.1:$public_port/api/mobile/v1/discovery" > "$receipt/discovery.json"
"$node" -e 'const fs=require("fs"),p=process.argv[1],health=JSON.parse(fs.readFileSync(p+"/gateway-health.json","utf8")),d=JSON.parse(fs.readFileSync(p+"/discovery.json","utf8"));if(health.service!=="homestream-web"||d.apiVersion!==1||d.localPairing!==false)throw Error("Gateway health or pairing policy check failed");' "$receipt"
systemctl disable "$service" >> "$receipt/start.log" 2>&1
printf '%s\n' "$release" > /var/lib/homestream-current-release
printf 'success\n' > "$receipt/status"
trap - ERR INT TERM
printf '\nUpgrade complete. Public port retained: %s\nBackup and rollback receipt: %s\n' "$public_port" "$receipt"
printf 'Rollback inside this LXC: bash %s/rollback.sh\n' "$receipt"
