# OpenAB Multi-Agent System

Ops Room is the control surface for configuring, launching, and monitoring OpenAB-backed agents. It stores safe config templates in Git, keeps runtime data under `data/`, and keeps private credentials under `secrets/`.

## Architecture

```
openab-multi-agent/
├── config/           → Safe config templates (*.example.toml)
├── data/             → Runtime data (agents, workspaces, shared memory, ops-room state)
├── ops-room/         → Harness/control surface source code
├── secrets/          → Private keys (ignored by Git)
├── docker-compose.yml
└── scripts/          → Container entrypoints
```

- **ops-room** — the control surface: receives GitHub webhooks, polls for tasks, routes to agents
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

# 4. Bootstrap runtime directories
cd ops-room && npm run bootstrap

# 5. Start the ops-room server
npm start
```

`npm start` loads `../.env` via Node's `--env-file` support and requires `OPENAB_WEBHOOK_SECRET` to be set explicitly.

## Ops Room Dashboard

Ops Room includes a read-only web dashboard for checking the OpenAB instances running on the host.

- Local URL: `http://127.0.0.1:7381/` when the host systemd service is running.
- Public URL: `https://ops-room.lihsheng.space/` after Cloudflare Access and the tunnel public hostname are configured.
- API: `GET /api/openab/instances` returns instance metadata plus best-effort Docker runtime status.
- UI: agents are shown as status cards with container health, backend, GitHub polling state, restart count, config path, data directory, and quick buttons for logs/tasks.
- Safety: the dashboard is read-only. It does not expose restart, reload, or config-edit controls.

On the VPS, prefer running Ops Room directly on the host through systemd instead of running this service inside Docker:

```bash
sudo systemctl status openab-ops-room.service --no-pager
sudo systemctl restart openab-ops-room.service
sudo journalctl -u openab-ops-room.service -f
```

Cloudflare note: the existing `hermes-dashboard` tunnel can serve both `hermes.lihsheng.space` and `ops-room.lihsheng.space`, but `ops-room.lihsheng.space` must be added as a **Tunnel Public Hostname** that points to `http://localhost:7381`. Creating only a Cloudflare Access application is not enough; after login it will still return the tunnel fallback `404` if the public hostname route is missing.

## What's Committed vs Local

| Committed to Git | Kept Local |
|---|---|
| `*.example.toml` config templates | `*.toml` real configs (with secrets/paths) |
| `ops-room/src/` source code | `.env` with real secrets |
| `docker-compose.yml` | `secrets/*.pem` private keys |
| `scripts/` entrypoints | `data/agents/` runtime homes |
| Docs and `.gitignore` | `data/workspaces/` generated projects |
| `.env.example` (no secrets) | `data/ops-room/logs/`, `state/`, `tasks/` |

## License

MIT
