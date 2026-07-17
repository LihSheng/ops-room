# OpenAB Multi-Agent System

Ops Room is the control surface for configuring, launching, and monitoring OpenAB-backed agents. It stores safe config templates in Git, keeps runtime data under `data/`, and keeps private credentials under `secrets/`.

Canonical product and runtime decisions: [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Architecture

```
openab-multi-agent/
├── config/           → Safe config templates (*.example.toml)
├── data/             → Runtime data (agents, workspaces, shared memory, ops-room state)
├── ops-room/         → Harness/control surface and React dashboard
├── secrets/          → Private keys (ignored by Git)
├── docker-compose.yml
└── scripts/          → Container entrypoints
```

- **ops-room** — the control plane: receives GitHub webhooks, polls for tasks, routes to agents, and serves the dashboard
- **OpenAB** — the runtime backbone: runs agent containers (gemini, opencode-1, opencode-2, opencode-professor)
- **config/agents/** — per-agent configuration (Discord tokens, API keys, runtime env)
- **data/agents/** — agent home directories (generated runtime state)
- **data/workspaces/** — agent-generated project workspaces
- **data/ops-room/** — harness logs, task files, processed state

## Quick Start

```bash
# 1. Clone and enter the repo
git clone <repo-url>
cd openab-multi-agent

# 2. Copy env file and fill in secrets
cp .env.example .env

# 3. Create required agent configs from examples
cp config/agents/gemini.example.toml config/agents/gemini.toml
cp config/agents/opencode-1.example.toml config/agents/opencode-1.toml
cp config/agents/opencode-2.example.toml config/agents/opencode-2.toml
cp config/agents/opencode-professor.example.toml config/agents/opencode-professor.toml

# 4. Install dependencies and build the SPA
cd ops-room
npm install

# 5. Bootstrap runtime directories and start Ops Room
npm run bootstrap
npm start
```

`npm install` runs the dashboard production build through the package `prepare` script. `npm run bootstrap` loads the repo-level `.env` and blocks startup when `OPENAB_WEBHOOK_SECRET` is missing. `npm start` loads the same file via Node's `--env-file` support. `OPENAB_WEBHOOK_PORT` defaults to `7381`.

`config/harness/ops-room.example.toml` documents the intended harness configuration shape. The current runtime does not load that TOML file; active server settings come from environment variables.

Node.js 20.19 or newer is required by the Vite build toolchain.

## Dashboard Development

The dashboard is a React + TypeScript + Vite single-page application using Mantine and TanStack Query.

Run the backend and frontend in separate terminals:

```bash
# Terminal 1 — Ops Room APIs on port 7381
npm run dev

# Terminal 2 — Vite SPA with /api proxying
npm run dev:dashboard
```

Useful commands:

```bash
npm run build:dashboard
npm run preview:dashboard
npm test
```

Dashboard source lives in `ops-room/dashboard/`. Production output is generated in `ops-room/dist/dashboard/` and is served by the existing Node.js server with SPA route fallback and immutable caching for hashed assets.

## Read-only Agent Profile APIs

The following endpoints expose validated Git-backed profile policy from the in-memory registry initialized at startup:

- `GET /api/agents/profiles` — list normalized public profiles in agent-ID order.
- `GET /api/agents/profiles/:id` — return one public profile; unknown IDs return `404` with `agent_profile_not_found`, while malformed IDs return `400`.
- `GET /api/skills` — list deduplicated skill keys and the sorted agents that declare them.
- `GET /api/memory-spaces` — list declared memory scope strings with sorted readers and writers.

These APIs are read-only and remain available when the operator mutation API is disabled. Responses expose only profile identity, version, mission, personality, runtime backend reference, skills, declared memory scopes, allowed repositories, and enabled status. They do not expose container or service bindings, images, data directories, source JSON paths, environment variables, credentials, process details, or mutable desired state.

Skill and memory-space catalogs are derived only from validated in-memory profiles. The server does not inspect, enumerate, verify, read, or write the Obsidian vault when serving these endpoints.

## Ops Room Dashboard

Ops Room includes a read-only operational dashboard for the OpenAB fleet.

- Local URL: `http://127.0.0.1:7381/` when the host systemd service is running.
- Public URL: `https://ops-room.lihsheng.space/` after Cloudflare Access and the tunnel public hostname are configured.
- SPA routes: `/`, `/agents`, `/tasks`, `/workflows`, `/activity`, and `/settings`.
- APIs: the current dashboard reads `/api/health`, `/api/openab/instances`, `/api/tasks`, and `/api/logs`.
- UI: system capacity, active work, operator intervention, agent fleet, task filters, agent details, and log tails.
- Safety: the dashboard remains read-only. It does not expose restart, reload, config-edit, secret, or shell-execution controls.
- Network boundary: host deployment binds `127.0.0.1` by default. Public traffic must pass through the configured Cloudflare Tunnel and Access policy.
- Operator APIs: mutations are disabled unless `OPS_ROOM_OPERATOR_API_ENABLED=true` and a separate `OPS_ROOM_OPERATOR_TOKEN` is configured.
- Knowledge: agents receive only the curated `OPENAB_AGENT_KNOWLEDGE_DIR` mount, read-only. Never point it at the whole Obsidian vault.

On the VPS, prefer running Ops Room directly on the host through systemd instead of running this service inside Docker:

```bash
sudo systemctl status openab-ops-room.service --no-pager
sudo systemctl restart openab-ops-room.service
sudo journalctl -u openab-ops-room.service -f
```

Production releases should not pull or rebuild a mutable checkout. Build a commit-addressed artifact:

```bash
cd ops-room
npm ci --ignore-scripts
npm run build:dashboard
npm run release:build -- "$(git rev-parse HEAD)" /tmp/ops-room-releases
```

Install root-owned copies of `scripts/deploy/activate-release.sh`, `rollback-release.sh`, and the systemd template under `ops-room/deploy/`. Bind a Node.js 20+ executable at `/opt/ops-room/bin/node`, then activate manually only after persistent paths in `/etc/openab/ops-room.env` are verified. For the one-time mutable-checkout cutover, verify no legacy work is active and set `OPS_ROOM_ALLOW_LEGACY_MIGRATION=true`; later activations do not use this flag. Automatic deployment remains deferred.

Cloudflare note: the existing `hermes-dashboard` tunnel can serve both `hermes.lihsheng.space` and `ops-room.lihsheng.space`, but `ops-room.lihsheng.space` must be added as a **Tunnel Public Hostname** that points to `http://localhost:7381`. Creating only a Cloudflare Access application is not enough; after login it will still return the tunnel fallback `404` if the public hostname route is missing.

## What's Committed vs Local

| Committed to Git | Kept Local |
|---|---|
| `*.example.toml` config templates | `*.toml` real configs (with secrets/paths) |
| `ops-room/src/` and `ops-room/dashboard/` source | `.env` with real secrets |
| `docker-compose.yml` | `secrets/*.pem` private keys |
| `scripts/` entrypoints | `data/agents/` runtime homes |
| Docs and `.gitignore` | `data/workspaces/` generated projects |
| `.env.example` (no secrets) | `data/ops-room/logs/`, `state/`, `tasks/` |

## License

MIT
