# Ops Room Control Plane Implementation Plan

> **Status: superseded.** Historical extraction plan. Current authority: [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

## Goal

Move `ops-room` toward the product direction described in the Obsidian note:

```text
OpenAB = Agent Runtime Engine
Ops Room = Agent Controller / Admin Console / Workflow Manager
```

The goal is not to replace OpenAB. OpenAB should continue to own chat/runtime behavior such as Discord, Slack, ACP, thread/session handling, streaming replies, and agent backend process communication.

Ops Room should become the management surface around OpenAB-backed agents:

- Agent registry and status
- Agent config visibility and validation
- Skill/instruction visibility
- Runtime health, logs, and task history
- GitHub workflow automation
- Controlled manual and scheduled task entry points

## Current Repo Context

Repository root:

```text
/home/ubuntu/openab-multi-agent
```

Important paths:

```text
ops-room/src/server/webhook.js      Current webhook server, poller startup, chat workflow, coding workflow, PR review workflow
ops-room/src/server/poller.js       Standalone issue poller
ops-room/src/server/claim.js        CLI for claiming queued tasks
ops-room/src/lib/config.js          Agent IDs, aliases, labels, GitHub App env mapping
ops-room/src/lib/task-routing.js    Task metadata parsing and chat/code classification
ops-room/src/lib/github-app.js      GitHub App token helper
ops-room/src/lib/github-ops.js      GitHub label/comment/API helpers
ops-room/src/lib/issue-poller.js    Shared issue polling loop
config/agents/*.toml                Real local agent configs
config/agents/*.example.toml        Safe committed config examples
data/ops-room/tasks                 Runtime task JSON files
data/ops-room/state                 Runtime processed state
data/ops-room/logs                  Runtime logs
data/workspaces                     Coding task workspaces
docker-compose.yml                  OpenAB and ops-room services
```

Current mismatch to fix over time:

- Ops Room currently acts mostly as a GitHub workflow harness.
- Ops Room directly owns a chat-like LLM response path in `runChatWorkflow()`.
- Ops Room does not yet expose a real agent registry, config manager, skill manager, status dashboard, restart/reload control, or task dashboard API.

## Rules For The Implementing Agent

Follow these rules while executing this plan:

- Keep OpenAB as the runtime owner. Do not move Discord, Slack, ACP, sessions, streaming, or normal chat into Ops Room.
- Keep agent behavior config-file based. The files OpenAB loads remain the source of truth.
- Do not expose secrets in API responses, logs, comments, or UI. Redact tokens, keys, private keys, and `.env` values.
- Preserve the existing GitHub automation while refactoring. Existing issue polling, PR creation, and PR review behavior should keep working unless a task explicitly changes it.
- Avoid large rewrites. Split large files gradually and verify behavior after each step.
- Do not add a database in the first milestone. Use existing files under `data/ops-room/`.
- Do not add write/edit config features until read-only config display and validation are working.
- Do not add restart/reload controls until health/status and audit logging exist.
- Prefer small modules with clear names over adding more logic to `webhook.js`.
- Use `rg` for searching and inspect existing code before editing.

## Recommended Milestone Order

Implement these milestones in order. Each milestone should leave the app runnable.

1. Refactor the current server into clearer modules without changing behavior.
2. Add read-only agent registry.
3. Add read-only health, task, and log APIs.
4. Add read-only config and skill discovery APIs.
5. Add a minimal Agent Control Center UI or API-ready backend if UI framework is not yet selected.
6. Refactor GitHub workflow state into a clearer task gateway.
7. Reframe or remove direct chat workflow ownership from Ops Room.
8. Add retry/cancel controls.
9. Add restart/reload controls with audit logging.
10. Add manual and scheduled instruction tunnels.

## Milestone 1: Split The Current Server Without Behavior Changes

### Objective

Reduce `ops-room/src/server/webhook.js` from a large mixed-responsibility file into smaller modules. This prepares the codebase for the control-plane work.

### Do This

Create these files:

```text
ops-room/src/server/http.js
ops-room/src/routes/webhook.js
ops-room/src/routes/tasks.js
ops-room/src/routes/health.js
ops-room/src/workflows/github-code.js
ops-room/src/workflows/pr-review.js
ops-room/src/workflows/chat-response.js
ops-room/src/services/task-store.js
ops-room/src/services/logs.js
ops-room/src/services/runtime-paths.js
```

Move code in small steps:

1. Move path/env constants into `services/runtime-paths.js`.
2. Move task file read/write helpers into `services/task-store.js`.
3. Move task logging helpers into `services/logs.js`.
4. Move PR review functions into `workflows/pr-review.js`.
5. Move coding workflow functions into `workflows/github-code.js`.
6. Move chat workflow functions into `workflows/chat-response.js`.
7. Move `/health` handling into `routes/health.js`.
8. Move `/tasks` handling into `routes/tasks.js`.
9. Move `/webhook` handling into `routes/webhook.js`.
10. Make `webhook.js` or `http.js` only compose services, register routes, start the poller, and listen on the port.

Keep `npm start` working. You may leave `package.json` pointing at `src/server/webhook.js` if that file becomes the small entrypoint.

### Notes

- Do not change endpoint behavior in this milestone.
- Do not change label names in this milestone.
- Do not change task JSON shape in this milestone.
- Keep `OPENAB_WEBHOOK_SECRET` required at startup.
- Keep the built-in poller behavior unless explicitly changed later.

### Verification

Run:

```bash
cd /home/ubuntu/openab-multi-agent/ops-room
npm run bootstrap
node --check src/server/webhook.js
node --check src/server/poller.js
node --check src/server/claim.js
```

If the local `.env` exists and secrets are configured, also run:

```bash
npm start
```

Then check:

```bash
curl -fsS http://localhost:7381/health
curl -fsS http://localhost:7381/tasks
```

## Milestone 2: Add Read-Only Agent Registry

### Objective

Create the first real control-plane capability: list known agents and their basic metadata.

### Do This

Create:

```text
ops-room/src/services/agent-registry.js
ops-room/src/routes/agents.js
```

Add endpoint:

```text
GET /api/agents
```

The response should include one object per known agent:

```json
{
  "agents": [
    {
      "key": "professor",
      "display_name": "Professor",
      "backend": "opencode",
      "config_path": "config/agents/opencode-professor.toml",
      "example_config_path": "config/agents/opencode-professor.example.toml",
      "container_name": "openab-opencode-professor",
      "github_app_bot_user": "lihsheng-professor[bot]",
      "enabled": true
    }
  ]
}
```

Read agent data from existing sources first:

- `ops-room/src/lib/config.js` for agent IDs, names, aliases, bot users
- `docker-compose.yml` for container names and mounted config paths if practical
- `config/agents/*.toml` and `config/agents/*.example.toml` for config existence

If parsing `docker-compose.yml` is too much for the first version, start with a small explicit mapping in `agent-registry.js`. Add a comment explaining that compose parsing can replace it later.

### Agent Keys To Support

Support at least:

```text
professor
berlin
tokyo
gemini
```

Existing mapping:

```text
professor -> config/agents/opencode-professor.toml -> openab-opencode-professor
berlin    -> config/agents/opencode-1.toml         -> openab-opencode-1
tokyo     -> config/agents/opencode-2.toml         -> openab-opencode-2
gemini    -> config/agents/gemini.toml             -> openab-gemini
```

### Notes

- Do not include raw token values.
- Use relative paths in API output unless an absolute path is necessary.
- If a config file is missing, include `enabled: false` and a clear `missing` list.

### Verification

Run:

```bash
node --check src/services/agent-registry.js
node --check src/routes/agents.js
npm start
```

Then:

```bash
curl -fsS http://localhost:7381/api/agents
```

Confirm the JSON includes all expected agents and no secrets.

## Milestone 3: Add Health, Tasks, And Logs APIs

### Objective

Expose the core operator data needed for the first dashboard.

### Do This

Add or extend these endpoints:

```text
GET /api/health
GET /api/tasks
GET /api/tasks/:id
GET /api/logs
GET /api/logs?agent=professor
GET /api/logs?task_id=...
```

Health response should include:

```json
{
  "status": "ok",
  "uptime_seconds": 123,
  "version": "openab-harness-v3-2026-06-26",
  "paths": {
    "tasks_dir": "data/ops-room/tasks",
    "state_dir": "data/ops-room/state",
    "logs_dir": "data/ops-room/logs",
    "workspaces_dir": "data/workspaces"
  },
  "commands": {
    "git": true,
    "gh": true,
    "opencode": true,
    "codex": false,
    "claude": false
  }
}
```

Tasks response should read from:

```text
data/ops-room/tasks/*.json
data/ops-room/state/processed-tasks.json
```

Logs response should read from:

```text
data/ops-room/logs/*.log
```

Keep log responses bounded:

- Default to the last 200 lines.
- Allow `limit`, but cap it at 1000 lines.
- Do not stream logs yet.

### Notes

- Keep the old `/health` and `/tasks` aliases working for compatibility.
- Redact secrets from log output before returning it.
- If log files are missing, return an empty list, not a 500.

### Verification

Run:

```bash
curl -fsS http://localhost:7381/api/health
curl -fsS http://localhost:7381/api/tasks
curl -fsS http://localhost:7381/api/logs
```

Confirm no secrets are visible.

## Milestone 4: Add Read-Only Config And Skill Discovery

### Objective

Let Ops Room inspect agent configs and skills while keeping files as the source of truth.

### Do This

Create:

```text
ops-room/src/services/config-reader.js
ops-room/src/services/secret-redaction.js
ops-room/src/routes/config.js
ops-room/src/routes/skills.js
```

Add endpoints:

```text
GET /api/config/agents
GET /api/config/agents/:agent
POST /api/config/validate
GET /api/skills
```

Config behavior:

- Read `config/agents/*.toml`.
- Parse TOML using a proper parser package if one already exists. If not, add a small dependency such as `smol-toml` or `@iarna/toml`.
- Return parsed config plus redacted raw text if useful.
- Redact keys matching names like `token`, `secret`, `key`, `password`, `credential`, `private`.
- `POST /api/config/validate` should accept TOML text and return validation errors without writing the file.

Skill behavior:

- Discover skills from `config/skills/*.md` if that directory exists.
- Also discover `docs/skills/**/*.md` because this repo currently has `docs/skills/github-operations/SKILL.md`.
- Return path, title, first heading, and short description if available.

### Notes

- This milestone is read-only.
- Do not implement config save/edit yet.
- Do not expose `.env`.
- Do not expose private key file contents.

### Verification

Run:

```bash
curl -fsS http://localhost:7381/api/config/agents
curl -fsS http://localhost:7381/api/config/agents/professor
curl -fsS http://localhost:7381/api/skills
```

Inspect output manually and confirm secrets are redacted.

## Milestone 5: Build The First Agent Control Center UI

### Objective

Add the first usable Ops Room screen around the new APIs.

### Do This

First inspect the package. If there is no frontend framework yet, choose the smallest reasonable path:

- Option A: simple server-rendered HTML from Node
- Option B: static HTML/CSS/JS served by the Node server
- Option C: Vite/React only if the user wants a richer frontend now

For the first version, prefer a simple static UI unless there is already a frontend framework.

Create:

```text
ops-room/src/app/index.html
ops-room/src/app/styles.css
ops-room/src/app/app.js
```

Add route:

```text
GET /
```

The first screen should show:

- Agent list
- Agent status
- Backend type
- Config path
- Container name
- Last task
- Last error
- Last PR
- Health summary
- Links/tabs for tasks, logs, config, and skills

Keep the design operational and dense. This is an admin console, not a landing page.

### Notes

- Do not add decorative marketing sections.
- Do not show raw secrets.
- The UI should still be useful if some APIs return empty lists.
- Make mobile readable, but optimize for desktop operator use.

### Verification

Run:

```bash
npm start
```

Open:

```text
http://localhost:7381/
```

Confirm the UI loads and the browser console has no obvious errors.

## Milestone 6: Refactor GitHub Workflow Into A Task Gateway

### Objective

Make the current GitHub automation a clean module inside Ops Room rather than the entire product.

### Do This

Create or extend:

```text
ops-room/src/services/task-lifecycle.js
ops-room/src/services/github-task-gateway.js
ops-room/src/workflows/github-code.js
ops-room/src/workflows/pr-review.js
```

Introduce explicit task states:

```text
pending
claimed
running
failed
pr_created
done
cancelled
```

For every task, store a task JSON record under:

```text
data/ops-room/tasks/
```

Each task record should include:

```json
{
  "id": "issue-123-professor-...",
  "source": "github_issue",
  "agent": "professor",
  "repository": "LihSheng/LinkUp",
  "issue_number": 123,
  "task": "Implement ...",
  "task_type": "code",
  "status": "running",
  "branch": "agent/professor/issue-123-...",
  "workspace_dir": "data/workspaces/...",
  "pr_url": null,
  "error": null,
  "created_at": "...",
  "updated_at": "..."
}
```

Update status during the workflow:

- `pending` when received
- `claimed` when label is claimed
- `running` when coding/review starts
- `failed` on failure
- `pr_created` after PR creation
- `done` only when the workflow is truly complete
- `cancelled` only from a future cancel endpoint

### Notes

- Keep GitHub labels synchronized with task state.
- Keep `processed-tasks.json` for compatibility until the new lifecycle is stable.
- Do not break existing label-driven polling.

### Verification

Trigger or simulate a task and confirm:

- A task JSON file is created.
- Status changes through the workflow.
- Existing GitHub comments and labels still work.
- `/api/tasks` shows the task.

## Milestone 7: Reframe Direct Chat Workflow

### Objective

Stop treating Ops Room as a normal chat runtime.

### Do This

Current direct chat logic lives in `runChatWorkflow()` and `askAI()`. Decide one of these options:

Option A, recommended short term:

- Rename the module to `workflows/manual-response.js` or `workflows/controlled-instruction.js`.
- Make docs clear that this is only for controlled GitHub/UI tasks, not normal Discord/Slack chat.
- Keep direct LLM response only for GitHub PR review or controlled task responses.

Option B, recommended long term:

- Replace direct LLM API calls with delegation to OpenAB or the selected agent backend.
- Ops Room creates a task and tracks it.
- OpenAB/agent runtime performs the actual conversation/reply.

### Notes

- Do not route normal Discord messages through Ops Room.
- Do not add Slack/Discord session logic to Ops Room.
- If keeping `askAI()`, isolate it as a utility for review/summarization tasks only.

### Verification

Search for direct runtime leakage:

```bash
rg -n "Discord|Slack|ACP|thread|session|streaming|chat workflow|askAI|chat/completions" ops-room/src
```

Confirm any remaining direct chat/LLM usage is intentionally documented as controlled workflow behavior.

## Milestone 8: Add Retry And Cancel Controls

### Objective

Let operators manage failed/running tasks from Ops Room.

### Do This

Add endpoints:

```text
POST /api/tasks/:id/retry
POST /api/tasks/:id/cancel
```

Retry behavior:

- Only allow retry for `failed` or `cancelled` tasks.
- Create a new branch/workspace for coding tasks.
- Preserve the old task record.
- Link the retry task to the original with `retry_of`.

Cancel behavior:

- Only allow cancel for `pending`, `claimed`, or `running` tasks.
- For a running child process, implement cancellation only if the process is tracked safely.
- If process cancellation is not implemented yet, mark as `cancel_requested` and let the workflow stop at the next safe checkpoint.

### Notes

- Add audit log entries for retry and cancel.
- Do not delete workspaces automatically.
- Do not remove GitHub labels blindly; transition them based on the task state.

### Verification

Use a test task JSON and confirm:

```bash
curl -fsS -X POST http://localhost:7381/api/tasks/<id>/retry
curl -fsS -X POST http://localhost:7381/api/tasks/<id>/cancel
```

Confirm task state and audit logs update.

## Milestone 9: Add Runtime Controls With Audit Logging

### Objective

Add guarded restart/reload controls after visibility exists.

### Do This

Create:

```text
ops-room/src/services/audit-log.js
ops-room/src/services/container-runtime.js
ops-room/src/routes/runtime-controls.js
```

Add endpoints:

```text
POST /api/agents/:agent/restart
POST /api/agents/:agent/reload
```

Audit every action to:

```text
data/ops-room/logs/audit.log
```

Audit entry should include:

```json
{
  "timestamp": "...",
  "action": "agent.restart",
  "agent": "professor",
  "requested_by": "local-operator",
  "result": "success"
}
```

Restart behavior:

- Use Docker Compose or Docker only if available and configured.
- Target only the selected agent container.
- Never restart all services from a single-agent endpoint.

Reload behavior:

- If OpenAB has a safe reload mechanism, call it.
- If not, return `501 Not Implemented` with a clear message.

### Notes

- Do not implement restart/reload before audit logging.
- Require authentication if this server is exposed beyond localhost.
- This repo currently uses bearer auth for `/webhook`; consider extending auth to write/control APIs before exposing them.

### Verification

Run against a non-critical local agent first:

```bash
curl -fsS -X POST http://localhost:7381/api/agents/professor/restart
tail -n 20 data/ops-room/logs/audit.log
```

Confirm only the intended container is affected.

## Milestone 10: Add Manual And Scheduled Instruction Tunnels

### Objective

Allow controlled non-GitHub task entry points without making Ops Room a chat runtime.

### Do This

Add manual task endpoint:

```text
POST /api/tasks
```

Request:

```json
{
  "source": "manual_ui",
  "agent": "professor",
  "task_type": "code",
  "repository": "LihSheng/LinkUp",
  "task": "Inspect the repo and propose a small fix..."
}
```

Add schedule config later:

```text
config/harness/schedules.toml
```

Example:

```toml
[[schedule]]
name = "weekly-review-summary"
agent = "professor"
cron = "0 9 * * 1"
task_type = "review"
repository = "LihSheng/LinkUp"
task = "Summarize open PRs and blockers."
enabled = false
```

### Notes

- Manual and scheduled tasks should enter the same task lifecycle as GitHub tasks.
- Do not add a scheduler until manual tasks work.
- Start with disabled schedules and read-only display if unsure.

### Verification

Create a manual task:

```bash
curl -fsS -X POST http://localhost:7381/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"source":"manual_ui","agent":"professor","task_type":"review","repository":"LihSheng/LinkUp","task":"Summarize current open issues."}'
```

Confirm:

- Task JSON is created.
- `/api/tasks` shows it.
- The task lifecycle handles it consistently.

## Documentation Updates

Update docs as implementation progresses:

```text
README.md
docs/ops-room.md
ops-room/README.md
```

Use this wording consistently:

```text
Ops Room is the OpenAB agent control plane. It manages agent configuration visibility, status, task routing, logs, and GitHub workflow automation. OpenAB remains the runtime engine for chat connections, ACP, sessions, streaming replies, and backend agent communication.
```

Avoid wording that says Ops Room owns normal chat/runtime behavior.

## Suggested First Pull Request Scope

The first PR should be small and low risk:

- Add this plan file.
- Refactor `webhook.js` into modules without behavior changes.
- Add `GET /api/agents`.
- Add `GET /api/health` while keeping old `/health`.
- Add `GET /api/tasks` while keeping old `/tasks`.

Do not include UI, config editing, restart controls, or scheduler in the first PR.

## Done Criteria For The First Release

The first useful release of the control plane is done when:

- `npm start` still starts Ops Room.
- Existing GitHub issue polling still works.
- Existing PR creation workflow still works.
- Existing PR review workflow still works.
- `GET /api/agents` lists all known agents without secrets.
- `GET /api/health` reports runtime paths and command availability.
- `GET /api/tasks` returns current task records.
- Docs clearly describe Ops Room as a control plane and OpenAB as the runtime.

## Common Mistakes To Avoid

- Do not build a second OpenAB inside Ops Room.
- Do not put more logic into `webhook.js`.
- Do not expose `.env`, token values, or private keys.
- Do not make a database the source of truth for agent behavior.
- Do not add config write features before validation and redaction are solid.
- Do not add restart controls without audit logs.
- Do not silently change GitHub label behavior.
- Do not delete workspaces as part of retry/cancel.

