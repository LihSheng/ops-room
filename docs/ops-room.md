# Ops Room

Ops Room is the OpenAB control surface for GitHub-driven work. It owns the webhook server, issue poller, task routing, GitHub App auth, and coding-task PR workflow.

## Current Startup

For local development, run from the package directory:

```bash
cd ops-room
npm run bootstrap
npm start
```

Detached start without a wrapper script:

```bash
nohup npm start >> ../data/ops-room/logs/server.log 2>&1 &
```

`npm start` uses Node `--env-file=../.env`, so the repo-level `.env` is loaded directly by Node. `OPENAB_WEBHOOK_SECRET` is required; the server refuses to start if it is missing.

On the VPS, the preferred production-style startup is the host systemd service:

```bash
sudo systemctl status openab-ops-room.service --no-pager
sudo systemctl restart openab-ops-room.service
sudo journalctl -u openab-ops-room.service -f
```

The service runs from `/home/ubuntu/openab-multi-agent/ops-room`, loads `../.env`, and listens on `OPENAB_WEBHOOK_PORT=7381`.

Local verification:

```bash
curl http://127.0.0.1:7381/
curl http://127.0.0.1:7381/api/openab/instances
```

## Source Layout

```text
ops-room/
├── src/
│   ├── lib/
│   │   ├── config.mjs
│   │   ├── github-app.mjs
│   │   ├── github-ops.mjs
│   │   ├── issue-poller.mjs
│   │   └── task-routing.mjs
│   ├── app/           → dashboard UI (index.html, app.js, styles.css)
│   ├── routes/        → route handlers (health, agents, tasks, logs, openab-instances, static-app)
│   ├── services/      → core services (agent-registry, openab-instances, runtime-paths, task-store, logs)
│   └── server/
│       ├── webhook.mjs
│       ├── poller.mjs
│       ├── claim.mjs
│       └── github-app-token.mjs
├── scripts/
├── package.json
└── README.md
```

## Responsibilities

- `src/server/webhook.mjs`
  Runs the HTTP server, starts the in-process poll loop, receives `/webhook` payloads, and owns the coding/chat task workflows.
- `src/server/poller.mjs`
  Standalone poller entrypoint that reuses the same shared poll loop for label-based issue claiming.
- `src/server/claim.mjs`
  CLI for listing or claiming queued tasks manually.
- `src/lib/config.mjs`
  Shared agent IDs, aliases, label colors, and GitHub App env key mapping.
- `src/lib/task-routing.mjs`
  Shared metadata-comment parsing and chat/code task classification.
- `src/lib/github-app.mjs`
  Shared GitHub App token loading helper.
- `src/lib/github-ops.mjs`
  Shared GitHub comment, label, and `gh api` helpers.
- `src/lib/issue-poller.mjs`
  Shared poll loop used by both `webhook.mjs` and `poller.mjs`.

## Runtime Data

Runtime state is stored outside the source tree:

```text
data/ops-room/
├── logs/
├── state/
└── tasks/
```

Coding task workspaces are created under `data/workspaces/`.

## OpenAB Instances Dashboard

A read-only dashboard that shows which OpenAB instances are configured and their runtime status.

The current UI uses a card layout instead of a table. Each agent card shows:

- agent display name and ID
- Docker container name
- status and health badges
- backend type and service mode
- GitHub polling state
- restart count
- config path and data directory
- quick buttons for logs and tasks

### API Endpoint

```
GET /api/openab/instances
```

Returns configured OpenAB instances with Docker container status when available.

### UI Dashboard

The dashboard is available at the root path `/` once the webhook server is running.

```
GET /  → index.html, app.js, styles.css
```

### Behavior

- Docker status is best-effort. If Docker CLI is unavailable, instance status shows `unknown`.
- Docker socket (`/var/run/docker.sock`) is not required for host-run mode. Ops Room calls `docker inspect` via the host Docker CLI.
- Docker socket may be needed when Ops Room runs inside a container.
- In-memory 5-second cache prevents constant Docker CLI calls on refresh.
- No restart, reload, or config-edit controls are included in this version.
- The UI avoids unsafe HTML injection for instance data by rendering dynamic values as text content.

### Public Access

Public access should go through Cloudflare Zero Trust, not by exposing port `7381` directly.

Use the existing tunnel:

```text
Tunnel: hermes-dashboard
Public hostname: ops-room.lihsheng.space
Service: http://localhost:7381
```

Important Cloudflare distinction:

- The Cloudflare Access application controls who can log in.
- The Tunnel Public Hostname controls where traffic is routed after login.
- Both are required.

If `https://ops-room.lihsheng.space/` redirects to Cloudflare Access but shows `404` or `not found` after login, check the tunnel public hostname mapping first. The tunnel is remote-managed, so local `~/.cloudflared/config.yml` changes may not take effect until the same route exists in the Cloudflare Zero Trust dashboard.

### Verification

```bash
npm run smoke:instances
```

Start with:
```bash
OPENAB_WEBHOOK_SECRET=test OPENAB_WEBHOOK_PORT=17381 node src/server/webhook.mjs
```

Then check:
```bash
curl http://localhost:17381/
curl http://localhost:17381/api/openab/instances
```

## Recent Cleanup

- Removed shell launchers from `ops-room`; startup is now handled directly by `npm start`.
- Moved duplicated config, task parsing, GitHub App auth, label ops, and poll-loop logic into `src/lib/`.
- Made `OPENAB_WEBHOOK_SECRET` mandatory at startup.
- Switched coding-task Git author configuration from global Git config to per-workspace repo config.
