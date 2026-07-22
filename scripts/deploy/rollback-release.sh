#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

install_root=${OPS_ROOM_INSTALL_ROOT:-/opt/ops-room}
service=${OPS_ROOM_SERVICE:-openab-ops-room.service}
health_url=${OPS_ROOM_HEALTH_URL:-http://127.0.0.1:7381/api/health}
systemctl_bin=${OPS_ROOM_SYSTEMCTL_BIN:-systemctl}
curl_bin=${OPS_ROOM_CURL_BIN:-curl}
node_bin=${OPS_ROOM_NODE_BIN:-/opt/ops-room/bin/node}

[[ $install_root = /* && $install_root != / ]] || { echo "unsafe OPS_ROOM_INSTALL_ROOT" >&2; exit 64; }
[[ -L "$install_root/current" && -L "$install_root/previous" ]] || { echo "current/previous release link missing" >&2; exit 66; }
[[ -x $node_bin ]] || { echo "Node runtime missing or not executable: $node_bin" >&2; exit 69; }
"$node_bin" -e 'if (Number(process.versions.node.split(".")[0]) < 20) process.exit(1)' || {
  echo "Ops Room requires Node.js 20 or newer" >&2
  exit 69
}

exec 9>"$install_root/locks/deploy.lock"
flock -n 9 || { echo "another deployment owns the lock" >&2; exit 75; }

current_target=$(readlink "$install_root/current")
previous_target=$(readlink "$install_root/previous")
previous_revision=$(basename -- "$previous_target")

rm -f -- "$install_root/current.new" "$install_root/previous.new"
ln -s -- "$previous_target" "$install_root/current.new"
mv -Tf -- "$install_root/current.new" "$install_root/current"
ln -s -- "$current_target" "$install_root/previous.new"
mv -Tf -- "$install_root/previous.new" "$install_root/previous"

$systemctl_bin restart "$service"
for _attempt in $(seq 1 30); do
  if response=$($curl_bin --fail --silent --show-error --connect-timeout 2 --max-time 5 "$health_url" 2>/dev/null) &&
    HEALTH_JSON="$response" EXPECTED_REVISION="$previous_revision" "$node_bin" -e '
      const value = JSON.parse(process.env.HEALTH_JSON);
      if (value.ready !== true || value.revision !== process.env.EXPECTED_REVISION) process.exit(1);
    '
  then
    echo "rolled back to $previous_revision"
    exit 0
  fi
  sleep 1
done

echo "rollback target failed health verification" >&2
exit 2
