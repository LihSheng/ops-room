# Ops Room

Ops Room is a secure control surface for observing and coordinating OpenAB-backed AI agents. It brings agent status, tasks, workflows, skills, governed memory spaces, and operational health into one dashboard while keeping secrets and runtime data outside Git.

> **Current scope:** Ops Room is intentionally read-only by default. It helps operators understand the agent fleet without exposing unsafe restart, execution, secret, configuration, or Obsidian-write controls.

## What It Does

- Shows the current health and runtime state of each agent.
- Displays agent profiles, missions, policies, and exact skill versions.
- Tracks tasks, workflows, activity, and operational logs.
- Reports skill requirements and compatibility without exposing credentials.
- Validates curated memory-space keys, publication boundaries, ownership, and future write-review policy without browsing the Obsidian vault.
- Supports GitHub-driven agent workflows while keeping the runtime provider-independent.

## Built with Codex and GPT-5.6

Ops Room was developed through a human-controlled engineering workflow using **Codex and GPT-5.6**.

- **Codex** helped implement the Node.js control plane, React dashboard, APIs, validation, tests, release tooling, and documentation.
- **GPT-5.6** helped plan architecture, break milestones into deliverables, evaluate trade-offs, diagnose CI and deployment failures, and review security boundaries.
- Every change remained subject to pull-request review, CI, and explicit operator approval before deployment.

Codex and GPT-5.6 assisted the development process; Ops Room itself can support different runtime model providers.

## Quick Start

### Requirements

- Node.js **20.19 or newer**
- npm
- Git and GitHub CLI
- Docker/OpenAB agent services when runtime inspection is required

### 1. Clone the repository

```bash
git clone https://github.com/LihSheng/ops-room.git openab-multi-agent
cd openab-multi-agent
```

### 2. Configure the environment

```bash
cp .env.example .env
```

Edit `.env` and replace the example paths with absolute paths for your checkout. At minimum, configure `OPENAB_WEBHOOK_SECRET` and the required GitHub App values.

Never commit `.env`, private keys, tokens, or runtime data.

### 3. Create local agent configurations

```bash
cp config/agents/gemini.example.toml config/agents/gemini.toml
cp config/agents/opencode-1.example.toml config/agents/opencode-1.toml
cp config/agents/opencode-2.example.toml config/agents/opencode-2.toml
cp config/agents/opencode-professor.example.toml config/agents/opencode-professor.toml
```

Update only the local `.toml` files with your runtime configuration.

### 4. Install and start Ops Room

```bash
cd ops-room
npm install
npm run bootstrap
npm start
```

### 5. Open the dashboard

Visit:

```text
http://127.0.0.1:7381/
```

From the dashboard, use:

- **Overview** for fleet health and operational status.
- **Agents** for runtime state, profiles, exact skills, and resolved memory assignments.
- **Tasks, Workflows, and Activity** for current and historical work.
- **Skills** for immutable skill versions and compatibility results.
- **Memory** for validated spaces, curated relative publication paths, readers, writers, ownership, and review policy.
- **Settings** for safe runtime and deployment information.

## Local Development

Run the API and dashboard separately:

```bash
# Terminal 1
cd ops-room
npm run dev

# Terminal 2
cd ops-room
npm run dev:dashboard
```

Before opening a pull request:

```bash
npm run typecheck
npm test
npm run build
npm run smoke:instances
```

## Documentation

- [Detailed setup and usage guide](docs/USAGE.md)
- [Curated memory governance and publication runbook](docs/MEMORY_GOVERNANCE.md)
- [Canonical architecture and security boundaries](ARCHITECTURE.md)
- [Environment configuration reference](.env.example)
- [Agent profile definitions](config/agent-profiles/)
- [Versioned skill manifests](config/skills/)
- [Versioned memory-space manifests](config/memory-spaces/)
- [Deployment tooling](ops-room/deploy/)

## Repository Safety

Safe templates, source code, profile policy, skill manifests, memory-space manifests, and documentation are committed to Git. Real credentials, private keys, Obsidian note contents, generated agent homes, workspaces, logs, tasks, and mutable runtime state must remain local.

## License

MIT
