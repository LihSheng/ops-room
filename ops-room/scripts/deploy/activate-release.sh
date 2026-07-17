#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

if [[ $# -lt 3 ]]; then
  echo "usage: activate-release.sh <archive.tar.gz> <archive.sha256> <40-char-sha>" >&2
  exit 64
fi

archive=$(realpath "$1")
checksum=$(realpath "$2")
revision=$3
install_root=${OPS_ROOM_INSTALL_ROOT:-/opt/ops-room}
service=${OPS_ROOM_SERVICE:-openab-ops-room.service}
health_url=${OPS_ROOM_HEALTH_URL:-http://127.0.0.1:7381/api/health}
systemctl_bin=${OPS_ROOM_SYSTEMCTL_BIN:-systemctl}
curl_bin=${OPS_ROOM_CURL_BIN:-curl}
node_bin=${OPS_ROOM_NODE_BIN:-/opt/ops-room/bin/node}
allow_legacy_migration=${OPS_ROOM_ALLOW_LEGACY_MIGRATION:-false}
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

[[ $revision =~ ^[a-f0-9]{40}$ ]] || { echo "invalid revision" >&2; exit 64; }
[[ $install_root = /* && $install_root != / ]] || { echo "unsafe OPS_ROOM_INSTALL_ROOT" >&2; exit 64; }
[[ -f $archive && -f $checksum ]] || { echo "artifact or checksum missing" >&2; exit 66; }
[[ -x $node_bin ]] || { echo "Node runtime missing or not executable: $node_bin" >&2; exit 69; }
"$node_bin" -e 'if (Number(process.versions.node.split(".")[0]) < 20) process.exit(1)' || {
  echo "Ops Room requires Node.js 20 or newer" >&2
  exit 69
}

mkdir -p "$install_root/releases" "$install_root/locks"
exec 9>"$install_root/locks/deploy.lock"
flock -n 9 || { echo "another deployment owns the lock" >&2; exit 75; }

"$node_bin" "$script_dir/verify-release.mjs" "$archive" "$revision" "$checksum" >/dev/null

release_dir="$install_root/releases/$revision"
temporary_dir="$install_root/releases/.incoming-$revision-$$"
previous_target=''
activated=false

cleanup() {
  rm -rf -- "$temporary_dir"
}
trap cleanup EXIT

health_matches() {
  local expected=$1 response
  for _attempt in $(seq 1 30); do
    if response=$($curl_bin --fail --silent --show-error --connect-timeout 2 --max-time 5 "$health_url" 2>/dev/null) &&
      HEALTH_JSON="$response" EXPECTED_REVISION="$expected" "$node_bin" -e '
        const value = JSON.parse(process.env.HEALTH_JSON);
        if (value.ready !== true || value.revision !== process.env.EXPECTED_REVISION) process.exit(1);
      '
    then
      return 0
    fi
    sleep 1
  done
  return 1
}

switch_link() {
  local name=$1 target=$2
  rm -f -- "$install_root/$name.new"
  ln -s -- "$target" "$install_root/$name.new"
  mv -Tf -- "$install_root/$name.new" "$install_root/$name"
}

mkdir "$temporary_dir"
tar -xzf "$archive" -C "$temporary_dir"
[[ -f "$temporary_dir/RELEASE.json" && -f "$temporary_dir/ops-room/src/server/webhook.mjs" ]] || {
  echo "extracted release is incomplete" >&2
  exit 65
}
if [[ -d $release_dir ]]; then
  diff -qr --no-dereference "$temporary_dir" "$release_dir" >/dev/null || {
    echo "existing release directory does not match verified artifact: $release_dir" >&2
    exit 65
  }
else
  chmod -R go-w "$temporary_dir"
  mv -- "$temporary_dir" "$release_dir"
fi

if [[ -L "$install_root/current" ]]; then
  response=$($curl_bin --fail --silent --show-error --connect-timeout 2 --max-time 5 "$health_url") || {
    echo "current service health unavailable; refusing forced restart" >&2
    exit 69
  }
  HEALTH_JSON="$response" "$node_bin" -e '
    const health = JSON.parse(process.env.HEALTH_JSON);
    const operations = health.lifecycle?.operations || [];
    if (operations.some((operation) => operation.startsWith("legacy-issue:"))) process.exit(1);
  ' || {
    echo "legacy issue work is active; deployment deferred" >&2
    exit 75
  }
  previous_target=$(readlink "$install_root/current")
  $systemctl_bin stop "$service"
elif $systemctl_bin is-active --quiet "$service"; then
  [[ $allow_legacy_migration = true ]] || {
    echo "legacy service is active; set OPS_ROOM_ALLOW_LEGACY_MIGRATION=true after verifying no active legacy work" >&2
    exit 75
  }
  $systemctl_bin stop "$service"
fi

if [[ -n $previous_target && $previous_target != "releases/$revision" ]]; then
  switch_link previous "$previous_target"
fi
switch_link current "releases/$revision"
activated=true

if $systemctl_bin start "$service" && health_matches "$revision"; then
  echo "activated $revision"
  exit 0
fi

echo "activation failed for $revision; attempting rollback" >&2
if [[ $activated = true && -n $previous_target ]]; then
  switch_link current "$previous_target"
  rollback_revision=$(basename -- "$previous_target")
  if $systemctl_bin restart "$service" && health_matches "$rollback_revision"; then
    echo "rolled back to $rollback_revision" >&2
    exit 1
  fi
fi

echo "rollback failed or no previous release exists" >&2
exit 2
