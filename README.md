# OpenAB Multi-Agent System

Ops Room is the control surface for configuring, launching, and monitoring OpenAB-backed agents. It stores safe config templates in Git, keeps runtime data under `data/`, and keeps private credentials under `secrets/`.

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
cp config/harness/ops-room.example.toml config/harness/ops-room.local.toml

# 4. Install dependencies and build the SPA
cd ops-room
npm install

# 5. Bootstrap runtime directories and start Ops Room
npm run bootstrap
npm start
```

`npm install` runs the dashboard production build through the package `prepare` script. `npm start` loads `../.env` via Node's `--env-file` support and requires `OPENAB_WEBHOOK_SECRET` to be set explicitly.

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

## Ops Room Dashboard

Ops Room includes a read-only operational dashboard for the OpenAB fleet.

- Local URL: `http://127.0.0.1:7381/` when the host systemd service is running.
- Public URL: `https://ops-room.lihsheng.space/` after Cloudflare Access and the tunnel public hostname are configured.
- SPA routes: `/`, `/agents`, `/tasks`, `/workflows`, `/activity`, and `/settings`.
- APIs: the current dashboard reads `/api/health`, `/api/openab/instances`, `/api/tasks`, and `/api/logs`.
- UI: system capacity, active work, operator intervention, agent fleet, task filters, agent details, and log tails.
- Safety: the dashboard remains read-only. It does not expose restart, reload, config-edit, secret, or shell-execution controls.

On the VPS, prefer running Ops Room directly on the host through systemd instead of running this service inside Docker:

```bash
sudo systemctl status openab-ops-room.service --no-pager
sudo systemctl restart openab-ops-room.service
sudo journalctl -u openab-ops-room.service -f
```

After pulling dashboard source changes on a host deployment, run:

```bash
cd /home/ubuntu/openab-multi-agent/ops-room
npm install
sudo systemctl restart openab-ops-room.service
```

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
