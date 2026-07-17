#!/bin/sh
set -e

# GitHub App token refresh for agents.
# Generates an installation token, writes it to ~/.config/gh/hosts.yml
# so `gh` CLI picks it up on every invocation, and refreshes it every 50 min.

REFRESH_INTERVAL=3000  # 50 minutes (tokens live 1 hr)

write_gh_hosts() {
  token="$1"
  mkdir -p "$HOME/.config/gh"
  cat > "$HOME/.config/gh/hosts.yml" <<EOF
github.com:
    git_protocol: https
    oauth_token: ${token}
    user: ${GITHUB_APP_BOT_USER:-bot}
EOF
  chmod 600 "$HOME/.config/gh/hosts.yml"
}

refresh_token() {
  if [ -z "${GITHUB_APP_ID}" ] || [ -z "${GITHUB_APP_INSTALLATION_ID}" ] || [ -z "${GITHUB_APP_KEY_PATH}" ]; then
    echo "ERROR: GitHub App not configured (GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_KEY_PATH)"
    echo "Falling back to GH_TOKEN env var if set."
    return 1
  fi
  result=$(node /scripts/github-app-token.js 2>/dev/null) || return 1
  token=$(echo "$result" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).token))")
  expires=$(echo "$result" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).expires_at))")
  write_gh_hosts "$token"
  echo "GitHub token refreshed — expires ${expires}"
}

# Initial token fetch
if [ -n "$GITHUB_APP_ID" ]; then
  refresh_token || true
  # Background refresh loop
  (
    while true; do
      sleep "$REFRESH_INTERVAL"
      refresh_token 2>/dev/null || true
    done
  ) &
fi

# Execute the agent
exec "$@"
