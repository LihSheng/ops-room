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
