#!/usr/bin/env bash
set -Eeuo pipefail
image="${1:?Usage: test-docker.sh IMAGE}"
name="homestream-smoke-${RANDOM}-$$"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$name" --tmpfs /app/data:uid=1001,gid=1001,mode=0700 -e HOMESTREAM_SESSION_SECRET=ci-only-secret-not-for-production-123456 "$image" >/dev/null
route=/health/ready
port=3001
docker exec "$name" ffmpeg -version >/dev/null
test "$(docker exec "$name" id -u)" = 1001
for attempt in $(seq 1 45); do
  if docker exec "$name" node -e "fetch('http://127.0.0.1:$port$route').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    echo "Container startup passed: $image"
    exit 0
  fi
  sleep 1
done
docker logs "$name"
exit 1
