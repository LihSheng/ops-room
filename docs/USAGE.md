# Ops Room Usage Guide

This guide contains the detailed setup, development, API, security, and deployment information intentionally kept out of the main README.

For the canonical product and runtime decisions, see [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

## Repository Layout

```text
openab-multi-agent/
├── config/           Safe config templates, agent profiles, and skill manifests
├── data/             Runtime data, workspaces, logs, tasks, and mutable state
├── ops-room/         Node.js control plane and React dashboard
├── secrets/          Local credentials and private keys; never committed
├── docker-compose.yml
└── scripts/          Container and deployment entrypoints
```

Important paths:

- `config/agent-profiles/` — versioned agent mission, policy, skill, memory, and repository assignments.
- `config/skills/` — immutable versioned skill metadata and declared requirements.
- `config/agents/` — local per-agent OpenAB runtime configuration.
- `data/agents/` — generated agent home directories.
- `data/workspaces/` — agent-generated project workspaces.
- `data/ops-room/` — harness logs, task files, audit state, and processed state.

## Prerequisites

- Node.js 20.19 or newer
- npm
- Git
- GitHub CLI (`gh`)
- Docker and configured OpenAB services when runtime inspection is required
- A GitHub App when GitHub task routing is enabled

## Installation

Clone the repository into the directory name used by the example paths:

```bash
git clone https://github.com/LihSheng/ops-room.git openab-multi-agent
cd openab-multi-agent
```

Create the local environment file:

```bash
cp .env.example .env
```

Create local agent configuration files:

```bash
cp config/agents/gemini.example.toml config/agents/gemini.toml
cp config/agents/opencode-1.example.toml config/agents/opencode-1.toml
cp config/agents/opencode-2.example.toml config/agents/opencode-2.toml
cp config/agents/opencode-professor.example.toml config/agents/opencode-professor.toml
```

These generated `.toml` files are local runtime configuration and must not contain values intended for Git.

## Environment Configuration

The active server settings come from the repository-level `.env` file. `config/harness/ops-room.example.toml` documents the intended configuration shape but is not currently loaded by the runtime.

All paths in `.env` must be explicit absolute paths because Node's `--env-file` loader does not expand shell variables.

Important values include:

- `OPENAB_ROOT` — repository root.
- `OPS_ROOM_ROOT` — the nested `ops-room/` application directory.
- `OPS_ROOM_DATA_DIR` — persistent Ops Room runtime state.
- `OPENAB_CONFIG_DIR` — Git-backed configuration root.
- `OPENAB_SECRETS_DIR` — protected local secret directory.
- `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, and `GITHUB_APP_KEY_PATH` — GitHub App identity.
- `OPENAB_WEBHOOK_SECRET` — required webhook ingress secret.
- `OPS_ROOM_DASHBOARD_TOKEN` — separate bearer token for read-only operational APIs.
- `OPS_ROOM_OPERATOR_API_ENABLED` — keep `false` unless audited mutations are intentionally enabled.
- `OPS_ROOM_OPERATOR_TOKEN` — separate operator credential when mutation APIs are enabled.
- `OPENAB_AGENT_KNOWLEDGE_DIR` — curated, read-only agent knowledge publication directory. Never use the whole Obsidian vault.

Generate strong random secrets, for example:

```bash
openssl rand -hex 32
```

Never commit `.env`, private keys, tokens, credentials, or generated runtime data.

## Starting Ops Room

Install dependencies and build the dashboard:

```bash
cd ops-room
npm install
```

`npm install` runs the production build through the package `prepare` script.

Bootstrap required runtime directories:

```bash
npm run bootstrap
```

Bootstrap loads the repository-level `.env` and blocks startup when required values such as `OPENAB_WEBHOOK_SECRET` are missing.

Start the server:

```bash
npm start
```

By default, Ops Room listens on:

```text
http://127.0.0.1:7381/
```

The loopback binding is intentional. Public access should pass through an authenticated boundary such as Cloudflare Tunnel and Cloudflare Access.

## Using the Dashboard

The current dashboard is an operational read-only interface.

### Overview

Use the overview page to confirm fleet health, release identity, lifecycle state, and major operational warnings.

### Agents

The agent list and detail pages join two kinds of information:

- Git-backed profile policy such as mission, constraints, exact skill versions, memory scopes, and allowed repositories.
- Observed runtime state such as agent availability, runtime backend, command presence, and compatibility results.

Profile information remains useful even when runtime inspection is temporarily unavailable.

### Tasks, Workflows, and Activity

Use these pages to inspect work routed through Ops Room, workflow progress, recent operational events, and failure context. They do not expose unrestricted execution controls.

### Skills

The skills catalog shows immutable skill versions, descriptions, declaring agents, supported runtimes, requirement counts, permissions, and compatibility summaries.

Compatibility means that declared requirements appear satisfied. It does not prove that a skill has been installed, activated, materialized, or executed.

### Memory

Memory spaces display declared read/write scopes from validated profiles. Ops Room does not browse the Obsidian vault, inspect arbitrary notes, or grant whole-vault access.

### Settings

Settings exposes safe runtime and deployment information only. Secrets, raw environment values, private paths, and mutation controls remain hidden.

## Dashboard Routes

- `/` — overview
- `/agents` — agent list
- `/agents/:id` — agent detail
- `/tasks` — task state
- `/workflows` — workflow state
- `/activity` — operational activity
- `/skills` — versioned skill catalog
- `/memory` — declared memory scopes
- `/settings` — safe runtime information

## Read-only APIs

Common endpoints include:

- `GET /api/health`
- `GET /api/openab/instances`
- `GET /api/tasks`
- `GET /api/logs`
- `GET /api/agents/profiles`
- `GET /api/agents/profiles/:id`
- `GET /api/skills`
- `GET /api/skills/:key/:version`
- `GET /api/memory-spaces`

Public API responses intentionally exclude container bindings, images, source file paths, data directories, environment values, credential values, process details, mutable desired state, and complete skill instructions.

Malformed or traversal-like profile and skill identifiers return validation errors without arbitrary filesystem access.

## Agent Profiles

Profiles use schema version 2 and assign exact immutable skill versions:

```json
{
  "skills": [
    { "key": "pull-request-review", "version": "1.0.0" }
  ]
}
```

Profiles are loaded and validated before the HTTP server starts. Missing, malformed, duplicate, unsupported, or runtime-inconsistent profiles block startup rather than exposing misleading state.

## Skill Registry

Only manifests matching this structure are discovered:

```text
config/skills/<lowercase-key>/<semantic-version>/manifest.json
```

A manifest declares metadata and requirements, not executable commands:

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

Validation rejects unsupported schemas, invalid keys or semantic versions, empty required fields, unknown runtimes or permissions, duplicates, wildcards, command arguments, absolute paths, path traversal, symlinks, secret-looking fields, unexpected files, and directory/manifest mismatches.

Compatibility statuses are:

- `compatible` — declared requirements are known and present.
- `incompatible` — a runtime, command, or credential-reference requirement is not satisfied.
- `unknown` — a manifest is unresolved or inspection data is unavailable.

Credential requirements use logical references only. Configure safe presence checks with:

```text
OPS_ROOM_CREDENTIAL_REFERENCE_MAP={"github":"GITHUB_APP_KEY_PATH"}
```

The resolver reports only `present`, `missing`, or `unknown`. It never returns secret values, hashes, lengths, or prefixes.

## Local Development

Run the APIs and dashboard separately:

```bash
# Terminal 1 — API on port 7381
cd ops-room
npm run dev
```

```bash
# Terminal 2 — Vite dashboard with API proxying
cd ops-room
npm run dev:dashboard
```

Production dashboard output is generated under `ops-room/dist/dashboard/`.

## Verification

Run the standard checks before opening or merging a pull request:

```bash
cd ops-room
npm run typecheck
npm test
npm run build
npm run smoke:instances
```

## Immutable Host Deployment

Production releases should use commit-addressed immutable artifacts instead of pulling and rebuilding a mutable checkout in place.

```bash
cd ops-room
npm ci --ignore-scripts
npm run build
npm run release:build -- "$(git rev-parse HEAD)" /tmp/ops-room-releases
npm run release:verify -- /tmp/ops-room-releases/ops-room-<sha>.tar.gz <sha>
```

Install root-owned copies of the deployment scripts and systemd unit templates from `ops-room/deploy/` and `ops-room/scripts/deploy/`. Bind Node.js 20.19 or newer at the deployment-controlled path.

Activation and rollback must remain explicit operator actions unless a separately reviewed automatic deployment design is introduced.

## Security Boundary

- Host deployment binds to `127.0.0.1` by default.
- Public traffic must pass through an authenticated ingress boundary.
- Operator mutation APIs are disabled by default.
- Dashboard and operator credentials must be separate from webhook ingress credentials.
- Agent profiles and skill manifests contain policy metadata only.
- Agent knowledge mounts must use curated, read-only publications.
- No secrets or runtime data belong in release artifacts.

## Committed vs Local Data

| Committed to Git | Kept local |
|---|---|
| Safe examples, agent profiles, and skill manifests | Real agent configurations and protected environment values |
| Control-plane and dashboard source | `.env` with real secrets |
| Docker, release, and deployment scripts | Private keys under `secrets/` |
| Documentation | Agent homes, workspaces, logs, tasks, and mutable state under `data/` |
