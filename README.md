# OpenAB Multi-Agent System

Ops Room is the control surface for configuring, launching, and monitoring OpenAB-backed agents. It stores safe config templates in Git, keeps runtime data under `data/`, and keeps private credentials under `secrets/`.

Canonical product and runtime decisions: [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Architecture

```text
openab-multi-agent/
├── config/           → Safe config templates, profiles, and skill manifests
├── data/             → Runtime data (agents, workspaces, shared memory, ops-room state)
├── ops-room/         → Harness/control surface and React dashboard
├── secrets/          → Private keys (ignored by Git)
├── docker-compose.yml
└── scripts/          → Container entrypoints
```

- **ops-room** — the control plane: receives GitHub webhooks, polls for tasks, routes to agents, and serves the dashboard
- **OpenAB** — the runtime backbone: runs agent containers (gemini, opencode-1, opencode-2, opencode-professor)
- **config/agent-profiles/** — versioned policy profiles with exact skill assignments
- **config/skills/** — validated immutable skill metadata and declared requirements
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

The dashboard source lives in `ops-room/dashboard/`. Production output is generated in `ops-room/dist/dashboard/`.

```bash
# Terminal 1 — Ops Room APIs on port 7381
npm run dev

# Terminal 2 — Vite SPA with /api proxying
npm run dev:dashboard

# Verification
npm run typecheck
npm test
npm run build
npm run smoke:instances
```

## Read-only Agent Profile APIs

The following endpoints expose validated Git-backed profile policy from the in-memory registry initialized at startup:

- `GET /api/agents/profiles` — list normalized public profiles in agent-ID order.
- `GET /api/agents/profiles/:id` — return one public profile; unknown IDs return `404`, while malformed IDs return `400`.
- `GET /api/skills` — list validated skill versions while retaining the legacy `key` and `agents` fields.
- `GET /api/skills/:key/:version` — return one immutable public manifest and per-agent compatibility results.
- `GET /api/memory-spaces` — list declared memory scope strings with sorted readers and writers.

Profiles use schema version 2. Assignments are exact and immutable:

```json
{
  "skills": [
    { "key": "pull-request-review", "version": "1.0.0" }
  ]
}
```

Public profile responses intentionally preserve the existing key-only list and add explicit versioned results:

```json
{
  "skills": ["pull-request-review"],
  "skill_assignments": [
    {
      "key": "pull-request-review",
      "version": "1.0.0",
      "resolution_status": "resolved",
      "compatibility": { "status": "compatible", "reasons": [] }
    }
  ]
}
```

The APIs do not expose container bindings, images, data directories, source JSON paths, environment values, credential values, process details, mutable desired state, or complete skill instructions.

## Read-only Skill Registry

### Manifest root and schema

Only files at this shape are discovered:

```text
config/skills/<lowercase-key>/<semantic-version>/manifest.json
```

A manifest contains immutable metadata and requirements:

```json
{
  "schemaVersion": 1,
  "key": "pull-request-review",
  "version": "1.0.0",
  "description": "Review pull requests for correctness, security, and maintainability risks.",
  "supportedRuntimes": ["opencode"],
  "requiredCommands": ["git", "gh"],
  "requiredCredentials": ["github"],
  "permissions": [
    "repository.read",
    "pull-request.read",
    "pull-request.comment"
  ]
}
```

Validation rejects unsupported schemas, invalid keys or semantic versions, empty descriptions/runtime lists, unknown runtimes or permissions, duplicate values, wildcards, command arguments, absolute paths, traversal, symlinks, secret-looking fields, unexpected files, and key/version directory mismatches. Structural failures prevent the HTTP server from starting with a misleading registry.

### Compatibility semantics

Compatibility statuses are:

- `compatible` — all declared requirements are known and present.
- `incompatible` — a declared runtime, command, or credential-reference requirement is not satisfied.
- `unknown` — a manifest is unresolved or required inspection data is unavailable.

Stable reason codes include `unsupported_runtime`, `missing_command`, `missing_credential_reference`, `runtime_data_unavailable`, `credential_state_unknown`, and `manifest_unresolved`.

Compatibility indicates declared requirements only. It does not prove that a skill is installed, materialized, activated, or executable. Manifests never supply command arguments and Ops Room never executes commands from them.

### Credential-reference safety

`requiredCredentials` contains logical names only. Configure safe presence checks with a JSON object that maps a logical name to an existing protected environment-variable name:

```text
OPS_ROOM_CREDENTIAL_REFERENCE_MAP={"github":"GITHUB_APP_KEY_PATH"}
```

The resolver reports only `present`, `missing`, or `unknown`. It never returns the target value, hash, length, prefix, or environment content. A missing or malformed mapping produces `unknown`; it does not expose configuration details or create credentials.

### API contracts

`GET /api/skills` retains `key` and `agents` and adds version, description, supported runtimes, declared requirements, permissions, and compatibility counts.

`GET /api/skills/:key/:version` returns the public manifest plus deterministic assignment results. Unknown valid identifiers return `404`; malformed or traversal-like identifiers return `400` without filesystem access.

The registry loads once during startup. Requests use only the in-memory registry and never read manifests from disk.

### Immutable release behavior

Release artifacts include the exact approved set of `config/skills/<key>/<version>/manifest.json` files. The builder validates the source tree before copying. Non-manifest files, extra manifests, traversal, symlinks, `.env`, secrets, runtime data, tests, provider homes, and dependencies are rejected or excluded.

## Ops Room Dashboard

Ops Room includes a read-only operational dashboard for the OpenAB fleet.

- Local URL: `http://127.0.0.1:7381/` when the host systemd service is running.
- Public URL: `https://ops-room.lihsheng.space/` after Cloudflare Access and the tunnel public hostname are configured.
- SPA routes: `/`, `/agents`, `/agents/:id`, `/tasks`, `/workflows`, `/activity`, `/skills`, `/memory`, and `/settings`.
- APIs: `/api/health`, `/api/openab/instances`, `/api/tasks`, `/api/logs`, `/api/agents/profiles`, `/api/skills`, and `/api/memory-spaces`.
- Safety: the dashboard remains read-only. It does not expose restart, reload, config-edit, secret, install, execute, activate, or materialize controls.
- Network boundary: host deployment binds `127.0.0.1` by default. Public traffic must pass through the configured Cloudflare Tunnel and Access policy.
- Operator APIs: mutations are disabled unless `OPS_ROOM_OPERATOR_API_ENABLED=true` and a separate `OPS_ROOM_OPERATOR_TOKEN` is configured.
- Knowledge: agents receive only the curated `OPENAB_AGENT_KNOWLEDGE_DIR` mount, read-only. Never point it at the whole Obsidian vault.

### Agent Detail Page (`/agents/:id`)

The read-only view joins profile policy with runtime state by stable agent ID. It shows exact skill versions, resolution, compatibility, safe reason codes, command presence, and credential-reference presence. Profile data remains visible when runtime inspection fails; runtime data remains visible when profile loading fails.

### Skills Catalog (`/skills`)

The catalog shows each immutable version, description, declaring agents, supported runtimes, requirement counts, and compatibility summary. Its read-only detail modal shows public permissions and per-agent assignment results without source paths, secret values, or complete skill content.

### Memory Spaces (`/memory`)

Memory scopes remain declarations from validated profiles. Ops Room does not inspect the Obsidian vault, browse notes, verify paths, perform memory search, or add write controls through this page.

## Immutable Host Deployment

Production releases should not pull or rebuild a mutable checkout:

```bash
cd ops-room
npm ci --ignore-scripts
npm run build
npm run release:build -- "$(git rev-parse HEAD)" /tmp/ops-room-releases
npm run release:verify -- /tmp/ops-room-releases/ops-room-<sha>.tar.gz <sha>
```

Install root-owned copies of `scripts/deploy/activate-release.sh`, `rollback-release.sh`, and the systemd template under `ops-room/deploy/`. Bind Node.js 20.19+ at `/opt/ops-room/bin/node`. Automatic deployment remains deferred.

## What's Committed vs Local

| Committed to Git | Kept Local |
|---|---|
| Safe examples, agent profiles, and skill manifests | Real agent configs and protected environment values |
| `ops-room/src/` and `ops-room/dashboard/` source | `.env` with real secrets |
| `docker-compose.yml` and scripts | `secrets/*.pem` private keys |
| Documentation | `data/agents/`, workspaces, logs, tasks, and mutable state |

## License

MIT
