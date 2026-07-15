# Ops Room

Control surface for OpenAB agents: webhook receiver, task poller, claim CLI, and
GitHub automation with an automated PR review–repair loop.

---

## Quick Start

```bash
git clone https://github.com/LihSheng/ops-room.git openab-multi-agent
cd openab-multi-agent/ops-room
npm install
cp ../.env.example ./.env   # edit to match your setup
sudo systemctl start openab-ops-room
```

> **Full setup guide**: [`docs/SETUP.md`](docs/SETUP.md) — covers GitHub App creation,
> environment variables, Docker containers, systemd service, and GitHub Actions workflows.

---

## What It Does

1. **Routes `/openab` commands** from GitHub issues to coding agents (Berlin, Tokyo)
2. **Auto-reviews PRs** created by coding agents using AI via the OpenCode API
3. **Auto-fixes issues** found in reviews — generates fix code, pushes to the PR branch
4. **Loops** review → fix → re-review until approval or max iterations
5. **Serves a dashboard** at port 7381 showing agent status and task logs

## Source Layout

```
ops-room/
├── src/
│   ├── server/           → webhook.mjs (entry), http.mjs (server + pollers)
│   ├── workflows/        → github-code.mjs, pr-review.mjs, auto-fix.mjs
│   ├── services/         → github.mjs, runtime-paths.mjs, logs.mjs
│   └── lib/              → config.mjs, task-routing.mjs, github-ops.mjs
├── docs/
│   └── SETUP.md          → Full deployment guide
└── package.json
```

## Architecture

```
Issue → /openab berlin --code "task"
   │
   ▼
Ops Room detects label → runs coding agent → PR created
   │
   ▼
PR Review Poller (60s) → Professor reviews via AI
   │
   ├── APPROVE    → openab/review-approved ✅
   ├── COMMENT    → acknowledgment, loop ends
   └── REQUEST_CHANGES
        → Auto-fix: AI generates fix, Berlin pushes to PR branch
        → Re-review (recursive, max 3 iterations)
        → Exhausted → openab/needs-human ⚠️
```

## API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /webhook` | Receive issue commands + metadata |
| `GET /` | Dashboard UI |
| `GET /health` | Health check |
| `GET /api/health` | Detailed health |
| `GET /api/tasks` | List tasks |
| `GET /api/logs` | Task logs |
| `GET /api/agents` | Agent list |
| `GET /api/openab/instances` | OpenAB instance dashboard |

## Labels

| Label | Meaning |
|-------|---------|
| `openab/<agent>` | Route issue to agent |
| `openab/pr-created` | Agent created a PR |
| `openab/review-loop` | Review in progress |
| `openab/review-approved` | PR passed review |
| `openab/needs-human` | Escalated (loop exhausted) |

Full reference: [`docs/SETUP.md#7-labels-reference`](docs/SETUP.md#7-labels-reference)

## Running

```bash
# Start
sudo systemctl start openab-ops-room

# Logs
sudo journalctl -u openab-ops-room -f

# Health check
curl http://localhost:7381/health

# Dashboard
open http://localhost:7381/
```

## Related

- [`docs/SETUP.md`](docs/SETUP.md) — Deployment guide from scratch
- [github.com/LihSheng/ops-room](https://github.com/LihSheng/ops-room)
