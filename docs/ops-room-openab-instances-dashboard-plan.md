# Ops Room OpenAB Instances Dashboard Implementation Plan

> **Status: completed/historical.** Current authority: [`../ARCHITECTURE.md`](../ARCHITECTURE.md). Current behavior: [`ops-room.md`](ops-room.md).

## Goal

Add a read-only Ops Room dashboard that shows which OpenAB instances are configured and which ones are currently running.

The dashboard should answer:

- Which OpenAB agents exist?
- Which Docker containers are running for those agents?
- Which backend does each agent use?
- Which config file and data directory belongs to each instance?
- Is the instance running, exited, restarting, or unknown?
- Where can an operator inspect logs and tasks?

This work should support the control-plane direction:

```text
OpenAB = runtime engine
Ops Room = controller / admin console / workflow manager
```

Do not add restart, reload, or config-edit buttons in the first version. This first release must be read-only.

## Current Repo Context

Repository:

```text
/home/ubuntu/openab-multi-agent
```

Important files:

```text
docker-compose.yml
ops-room/src/server/http.mjs
ops-room/src/routes/agents.mjs
ops-room/src/routes/health.mjs
ops-room/src/routes/logs.mjs
ops-room/src/services/agent-registry.mjs
ops-room/src/services/runtime-paths.mjs
ops-room/src/services/logs.mjs
ops-room/src/services/task-store.mjs
```

Current useful endpoints:

```text
GET /api/health
GET /api/agents
GET /api/tasks
GET /api/tasks/:id
GET /api/logs
```

Current known OpenAB services from `docker-compose.yml`:

```text
gemini              -> container: openab-gemini
opencode-professor  -> container: openab-opencode-professor
opencode-1          -> container: openab-opencode-1
opencode-2          -> container: openab-opencode-2
ops-room            -> container: openab-ops-room
```

Current agent mapping:

```text
professor -> opencode-professor -> openab-opencode-professor
berlin    -> opencode-1         -> openab-opencode-1
tokyo     -> opencode-2         -> openab-opencode-2
gemini    -> gemini             -> openab-gemini
```

## Non-Goals For First Version

Do not implement these yet:

- Restart buttons
- Reload config buttons
- Config editing
- Docker Compose write operations
- Shell command execution from the UI
- Viewing secrets or raw `.env`
- Replacing OpenAB runtime behavior

The first version is visibility only.

## Safety Requirements

Follow these rules:

- Never expose secrets from `.env`, config files, Docker env vars, or logs.
- Do not return raw Docker inspect output to the frontend.
- Return only a normalized allowlisted subset of Docker data.
- If Docker is not available, return instance config with `runtime.status = "unknown"` instead of failing the whole API.
- Do not mount `/var/run/docker.sock` unless the deployment decision is explicit.
- If Docker socket access is added later, document the security impact clearly.

## Design Decision: How To Read Docker Status

There are two acceptable deployment modes.

### Mode A: Host-Run Ops Room

If Ops Room runs on the host, it can call:

```bash
docker ps
docker inspect
```

This is simple for local development.

### Mode B: Container-Run Ops Room

If Ops Room runs inside Docker, it cannot inspect sibling containers unless the Docker socket is mounted:

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock:ro
```

Important:

- Docker socket access is sensitive.
- Even read-only socket mounts can expose powerful host/container metadata.
- Do not add restart/reload controls until auth and audit logging are in place.

For the first implementation, support Docker status if Docker CLI is available. If not available, degrade gracefully.

## Target API

Add:

```text
GET /api/openab/instances
```

The response should look like:

```json
{
  "instances": [
    {
      "agent": "professor",
      "display_name": "Professor",
      "service": "opencode-professor",
      "container_name": "openab-opencode-professor",
      "backend": "opencode",
      "image": "ghcr.io/openabdev/openab-opencode:latest",
      "config_path": "config/agents/opencode-professor.toml",
      "data_dir": "data/agents/opencode-professor",
      "github_polling_enabled": true,
      "runtime": {
        "status": "running",
        "state": "running",
        "started_at": "2026-06-29T00:00:00Z",
        "finished_at": null,
        "restart_count": 0,
        "health": "none"
      },
      "links": {
        "logs": "/api/logs?agent=professor",
        "tasks": "/api/tasks"
      }
    }
  ],
  "docker": {
    "available": true,
    "error": null
  }
}
```

If Docker is not available:

```json
{
  "instances": [
    {
      "agent": "professor",
      "runtime": {
        "status": "unknown",
        "state": "unknown",
        "health": "unknown"
      }
    }
  ],
  "docker": {
    "available": false,
    "error": "docker command not available"
  }
}
```

## Implementation Milestones

Implement these in order. Stop and verify after each milestone.

## Milestone 1: Add Static Instance Metadata

### Objective

Create a service that returns the known OpenAB instances from repo configuration, without Docker runtime status yet.

### Files To Create

```text
ops-room/src/services/openab-instances.mjs
ops-room/src/routes/openab-instances.mjs
```

### Service Requirements

In `openab-instances.mjs`, define a small explicit mapping first.

Use this mapping:

```js
const OPENAB_INSTANCE_MAP = [
  {
    agent: 'professor',
    displayName: 'Professor',
    service: 'opencode-professor',
    containerName: 'openab-opencode-professor',
    backend: 'opencode',
    image: 'ghcr.io/openabdev/openab-opencode:latest',
    configPath: 'config/agents/opencode-professor.toml',
    dataDir: 'data/agents/opencode-professor',
  },
  {
    agent: 'berlin',
    displayName: 'Berlin',
    service: 'opencode-1',
    containerName: 'openab-opencode-1',
    backend: 'opencode',
    image: 'ghcr.io/openabdev/openab-opencode:latest',
    configPath: 'config/agents/opencode-1.toml',
    dataDir: 'data/agents/opencode-1',
  },
  {
    agent: 'tokyo',
    displayName: 'Tokyo',
    service: 'opencode-2',
    containerName: 'openab-opencode-2',
    backend: 'opencode',
    image: 'ghcr.io/openabdev/openab-opencode:latest',
    configPath: 'config/agents/opencode-2.toml',
    dataDir: 'data/agents/opencode-2',
  },
  {
    agent: 'gemini',
    displayName: 'Gemini',
    service: 'gemini',
    containerName: 'openab-gemini',
    backend: 'gemini',
    image: 'ghcr.io/openabdev/openab-gemini:latest',
    configPath: 'config/agents/gemini.toml',
    dataDir: 'data/agents/gemini',
  },
];
```

Do not include `ops-room` in the agent list. This dashboard is about OpenAB runtime instances, not Ops Room itself.

Return fields using snake_case in JSON:

```text
display_name
container_name
config_path
data_dir
github_polling_enabled
```

Use `POLL_AGENTS` from `ops-room/src/lib/config.mjs` to set `github_polling_enabled`.

### Route Requirements

In `routes/openab-instances.mjs`, export:

```js
export async function handleOpenABInstances() {
  return getOpenABInstances();
}
```

### Wire Route

In `ops-room/src/server/http.mjs`, add:

```text
GET /api/openab/instances
```

Return JSON with:

```json
{
  "instances": [],
  "docker": {
    "available": false,
    "error": null
  }
}
```

For Milestone 1, Docker can be hardcoded as unavailable or omitted by the service.

### Verification

Run:

```bash
cd /home/ubuntu/openab-multi-agent/ops-room
find src -name '*.mjs' -print0 | xargs -0 -n1 node --check
OPENAB_WEBHOOK_SECRET=test OPENAB_WEBHOOK_PORT=17381 node src/server/webhook.mjs
```

In another terminal:

```bash
curl -fsS http://localhost:17381/api/openab/instances
```

Expected:

- Four instances returned.
- No secrets returned.
- `github_polling_enabled` is true for `professor`, `berlin`, and `tokyo`.
- `github_polling_enabled` is false for `gemini`.

## Milestone 2: Add Docker Runtime Inspection

### Objective

Augment each instance with live Docker container status when Docker is available.

### Add To Service

In `openab-instances.mjs`, add a helper:

```js
async function getDockerStatusByContainerName(containerNames) {}
```

Use `execFile` or `execFileSync`, not shell string interpolation.

Preferred command:

```bash
docker inspect <container-name-1> <container-name-2> ...
```

Important:

- Do not use `execSync("docker inspect " + names.join(" "))`.
- Use `execFileSync('docker', ['inspect', ...containerNames], ...)`.
- This avoids shell injection problems.

Parse only these fields:

```text
Name
Config.Image
State.Status
State.Running
State.StartedAt
State.FinishedAt
State.Restarting
State.OOMKilled
State.Dead
State.ExitCode
State.Health.Status if present
RestartCount
```

Normalize runtime data:

```json
{
  "status": "running",
  "state": "running",
  "started_at": "...",
  "finished_at": null,
  "restart_count": 0,
  "health": "healthy",
  "exit_code": 0,
  "oom_killed": false
}
```

If a container is missing:

```json
{
  "status": "missing",
  "state": "missing",
  "health": "unknown"
}
```

If Docker is unavailable:

```json
{
  "status": "unknown",
  "state": "unknown",
  "health": "unknown"
}
```

### Docker Availability Behavior

Return:

```json
"docker": {
  "available": true,
  "error": null
}
```

or:

```json
"docker": {
  "available": false,
  "error": "docker command not available or permission denied"
}
```

Do not throw a 500 just because Docker is unavailable.

### Performance Notes

- Inspect all known containers in one Docker call.
- Do not call `docker inspect` once per instance.
- Add a short in-memory cache, such as 5 seconds.
- Dashboard refreshes should not trigger constant Docker CLI calls.

Suggested cache:

```js
let cachedDockerStatus = null;
let cachedDockerStatusAt = 0;
const DOCKER_STATUS_CACHE_MS = 5000;
```

### Verification

Run on the host:

```bash
docker ps --format '{{.Names}}'
```

Then run:

```bash
curl -fsS http://localhost:17381/api/openab/instances
```

Expected:

- Containers that exist show real runtime state.
- Missing containers show `missing`, not an exception.
- If Docker is unavailable, endpoint still returns all configured instances.

## Milestone 3: Add Basic Dashboard UI

### Objective

Create a simple read-only browser dashboard.

### Files To Create

```text
ops-room/src/app/index.html
ops-room/src/app/styles.css
ops-room/src/app/app.js
ops-room/src/routes/static-app.mjs
```

If an app folder already exists, reuse it.

### Route Requirements

In `server/http.mjs`, add:

```text
GET /
GET /app.js
GET /styles.css
```

Keep this simple. Do not add a frontend framework yet.

### UI Requirements

The first page should show:

- Page title: `Ops Room`
- Section: `OpenAB Instances`
- A table or dense card list with one row per instance.

Fields to show:

```text
Agent
Backend
Container
Runtime status
Health
Config path
Data directory
GitHub polling
Links
```

Links:

```text
Logs -> /api/logs?agent=<agent>
Tasks -> /api/tasks
Health -> /api/health
```

Status badge rules:

```text
running  -> green
healthy  -> green
exited   -> red
missing  -> gray
unknown  -> gray
restarting -> yellow
unhealthy -> red
```

### UI Safety Requirements

- Use `textContent`, not `innerHTML`, for dynamic values.
- Do not render raw logs on the dashboard.
- Do not display secrets or environment variables.
- Do not add restart or reload buttons.

### UI Design Direction

This is an operations dashboard. Keep it:

- Dense
- Readable
- Desktop-friendly
- Low decoration
- Table-first or compact panel-first

Avoid:

- Marketing hero sections
- Big decorative cards
- Large illustrations
- Chat-like UI

### Frontend Behavior

In `app.js`:

- Fetch `/api/openab/instances`.
- Fetch `/api/health`.
- Render loading state.
- Render error state if fetch fails.
- Auto-refresh every 10 seconds.
- Preserve manual refresh button.

Do not create a dependency on React/Vite for the first version.

### Verification

Start Ops Room:

```bash
cd /home/ubuntu/openab-multi-agent/ops-room
OPENAB_WEBHOOK_SECRET=test OPENAB_WEBHOOK_PORT=17381 node src/server/webhook.mjs
```

Open:

```text
http://localhost:17381/
```

Check:

- Page loads.
- Four OpenAB instances are visible.
- Status updates after refresh.
- Browser console has no obvious errors.
- No secrets are visible.

## Milestone 4: Add Tests Or Smoke Checks

### Objective

Make the feature easy to verify without manually clicking everything.

### Add Script If Appropriate

If no test framework exists, add a small script:

```text
ops-room/scripts/smoke-openab-instances.mjs
```

The script should:

- Call `http://localhost:<port>/api/openab/instances`.
- Confirm response has `instances`.
- Confirm at least four configured instances.
- Confirm each instance has `agent`, `container_name`, `backend`, and `runtime`.
- Confirm no obvious secret words are present in JSON values.

Do not add heavy dependencies.

### Optional Package Script

Add to `ops-room/package.json`:

```json
"smoke:instances": "node scripts/smoke-openab-instances.mjs"
```

### Verification

Run:

```bash
npm run smoke:instances
```

## Milestone 5: Documentation Update

### Objective

Document how the dashboard works and its current limits.

### Update

Edit:

```text
docs/ops-room.md
ops-room/README.md
```

Add a section:

```text
OpenAB Instances Dashboard
```

Mention:

- Endpoint: `GET /api/openab/instances`
- UI: `GET /`
- Docker status is best effort.
- Docker socket is not required for local host-run mode.
- Docker socket may be needed when Ops Room runs in a container.
- No restart/reload controls are included yet.

### Verification

Read the docs and confirm they match the implemented behavior.

## Exact Implementation Order For The Agent

Follow this order:

1. Create `services/openab-instances.mjs` with static instance metadata only.
2. Create `routes/openab-instances.mjs`.
3. Wire `GET /api/openab/instances` in `server/http.mjs`.
4. Run syntax checks.
5. Smoke test the endpoint.
6. Add Docker inspect support using `execFileSync`.
7. Add 5-second Docker status cache.
8. Smoke test with Docker available and unavailable if possible.
9. Create static dashboard files.
10. Serve `/`, `/app.js`, and `/styles.css`.
11. Manually inspect UI in browser.
12. Add optional smoke script.
13. Update docs.
14. Run final checks.

## Final Verification Checklist

Before marking done, verify:

- `git status` only shows intended files.
- `node --check` passes for every changed `.mjs` file.
- `GET /api/openab/instances` returns four configured OpenAB instances.
- Endpoint still works if Docker command fails.
- Dashboard loads at `/`.
- Dashboard shows running/missing/unknown status clearly.
- No secrets are visible in API responses or UI.
- Existing endpoints still work:

```text
GET /api/health
GET /api/agents
GET /api/tasks
GET /api/logs?limit=5
POST /webhook
```

Do not merge or deploy until these pass.

## Future Work After First Version

Only after this read-only dashboard is stable:

- Add authenticated restart controls.
- Add reload controls if OpenAB supports safe reload.
- Add audit logging for operator actions.
- Add per-agent log viewer.
- Add config validation panel.
- Add UI filters for running/exited/missing instances.

