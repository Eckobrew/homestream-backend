#!/usr/bin/env bash
# Run inside an existing Debian LXC after copying/cloning both repositories.
set -euo pipefail
backend_dir="$(cd "$(dirname "$0")/.." && pwd)"
web_dir="${HOMESTREAM_WEB_DIR:-$(dirname "$backend_dir")/homestream-web}"
if [[ $(id -u) -ne 0 ]]; then echo 'Run this installer as root inside the LXC.' >&2; exit 1; fi
command -v node >/dev/null
[[ $(node -p 'Number(process.versions.node.split(".")[0])') -ge 22 ]] || { echo 'Node.js 22 or newer is required.' >&2; exit 1; }
[[ -f "$web_dir/package.json" ]] || { echo 'The sibling homestream-web checkout is required.' >&2; exit 1; }
apt-get update
apt-get install -y nginx ffmpeg curl
id homestream >/dev/null 2>&1 || useradd --system --home /var/lib/homestream --create-home homestream
install -d -m 750 -o homestream -g homestream /var/lib/homestream
install -d -m 750 /etc/homestream
if [[ ! -f /etc/homestream/backend.env ]]; then
  secret="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  printf 'HOMESTREAM_SESSION_SECRET=%s\nHOMESTREAM_TRUSTED_PROXIES=127.0.0.1,::1\n' "$secret" > /etc/homestream/backend.env
  chmod 600 /etc/homestream/backend.env
fi
# Build as the service account, never run npm lifecycle scripts as root.
chown -R homestream:homestream "$backend_dir" "$web_dir"
runuser -u homestream -- bash -c 'cd "$1" && npm ci && npm run build' -- "$backend_dir"
runuser -u homestream -- bash -c 'cd "$1" && npm ci && npm run build' -- "$web_dir"
for service in backend web; do
  if [[ "$service" == backend ]]; then
    working="$backend_dir"; port=3001; start="$(command -v node) $backend_dir/dist/server.js"; envfile='EnvironmentFile=/etc/homestream/backend.env'
  else
    working="$web_dir"; port=3002; start="$(command -v node) $web_dir/.next/standalone/server.js"; envfile=''
  fi
  cat > "/etc/systemd/system/homestream-$service.service" <<UNIT
[Unit]
Description=HomeStream $service
After=network.target
[Service]
User=homestream
Group=homestream
WorkingDirectory=$working
Environment=NODE_ENV=production
Environment=PORT=$port
Environment=HOST=127.0.0.1
Environment=HOSTNAME=127.0.0.1
Environment=DATA_DIR=/var/lib/homestream
Environment=HOMESTREAM_BACKEND_URL=http://127.0.0.1:3001
$envfile
ExecStart=$start
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
UNIT
done
sed -e 's/listen 8080;/listen 3000;/' -e 's/backend:3001/127.0.0.1:3001/g' -e 's/web:3002/127.0.0.1:3002/g' "$backend_dir/deploy/nginx.conf" > /etc/nginx/sites-available/homestream
ln -sfn /etc/nginx/sites-available/homestream /etc/nginx/sites-enabled/homestream
nginx -t
systemctl daemon-reload
systemctl enable --now homestream-backend homestream-web nginx
systemctl reload nginx
printf 'Installed. Configure /etc/homestream/backend.env and restart homestream-backend. Public port: 3000.\n'
