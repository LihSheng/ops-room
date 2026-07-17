# Ops Room — Setup Guide

> Architecture authority: [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md). This guide covers setup mechanics; immutable production releases must follow that contract.

Complete guide to deploying the Ops Room from scratch: configuring GitHub, setting up the
service, and connecting the OpenAB agent containers.

> **Repository**: [github.com/LihSheng/ops-room](https://github.com/LihSheng/ops-room)
> **Target repo**: The repository the Ops Room manages (e.g., `LihSheng/LinkUp`)

---

## Architecture

```
GitHub                                Your Server
┌────────────────┐                     ┌────────────────────────────────┐
│ GitHub App     │◄──webhooks─────────│  Ops Room (systemd service)    │
│ (org/openab)   │                     │  src/server/webhook.mjs       │
│                │───poll issues──────▶│  port 7381                    │
│                │                     │                                │
│                │                     │  ┌─ Pollers ────────────────┐  │
│                │                     │  │ Issue poller (30s)       │  │
│                │                     │  │ PR review poller (60s)   │  │
│                │                     │  └──────────────────────────┘  │
│                │                     │                                │
│                │                     │  ┌─ Docker Containers ──────┐  │
│                │                     │  │ opencode-professor       │  │
│                │                     │  │ opencode-1 (Berlin)      │  │
│                │                     │  │ opencode-2 (Tokyo)       │  │
│                │                     │  └──────────────────────────┘  │
└────────────────┘                     └────────────────────────────────┘
```

The Ops Room is the **control surface**. It:

- Polls GitHub issues for `/openab` labeled tasks and routes them to agents
- Detects PRs created by coding agents and auto-reviews them via AI
- Runs the auto-fix loop: review → fix → re-review → approve/escalate
- Serves a read-only dashboard on port 7381

Agent containers (Docker) provide the **execution environment** — they run OpenAB agents
(Discord bots) that respond to `/openab` commands and execute coding tasks.

---

## Prerequisites

| Requirement | Minimum | Notes |
|-------------|---------|-------|
| **Server** | Linux (Ubuntu 22.04+) | Tested on 22.04 and 24.04 |
| **Node.js** | v20+ | Uses the `--env-file` flag (introduced in Node 20) |
| **npm** | v10+ | Comes with Node.js |
| **Docker** | v24+ | Required for OpenAB agent containers |
| **GitHub Account** | Any | Owner of the target repository |
| **Domain / Public IP** | Optional | Needed only for real-time webhooks; poller mode works without it |

---

## 1. GitHub App Setup

The Ops Room authenticates with GitHub as a **GitHub App**. This gives it fine-grained
permissions without using a personal access token.

### Create the App

1. Go to **Settings → Developer settings → GitHub Apps → New GitHub App**
2. Fill in:

| Field | Value |
|-------|-------|
| **GitHub App name** | `your-org-openab` (unique name) |
| **Homepage URL** | `https://github.com/your-org/your-repo` |
| **Webhook URL** | `https://your-server:7381/webhook` or leave blank for poller-only |
| **Webhook secret** | Generate with `openssl rand -hex 32` |
| **Permissions** | See table below |

### Required Permissions

| Permission | Access | Purpose |
|------------|--------|---------|
| Issues | **Read & Write** | Read `/openab` commands, add labels/comments |
| Pull requests | **Read & Write** | Review PRs, create PRs, manage labels |
| Contents | **Read & Write** | Push fix commits to PR branches |
| Metadata | **Read** | Required by GitHub for all Apps |
| Checks | **Read** | Check CI status on PRs |
| Commit statuses | **Read** | Check build status |

### Subscribe to Events

- ✅ Issues
- ✅ Issue comment
- ✅ Pull request
- ✅ Pull request review
- ✅ Push

### Finalize

1. **Generate a private key** → download the `.pem` file
2. Note the **App ID** (e.g., `4131786`)
3. **Install the app** on your target repository
4. Note the **Installation ID** — found in the browser URL when viewing the installed app

---

## 2. Server Setup

### Clone and Install

```bash
git clone https://github.com/LihSheng/ops-room.git openab-multi-agent
cd openab-multi-agent/ops-room
npm install
```

### Directory Structure

```
openab-multi-agent/
├── ops-room/                          # Main Node.js service
│   ├── src/
│   │   ├── server/
│   │   │   ├── webhook.mjs            # Entry point (imports http.mjs)
│   │   │   ├── http.mjs               # HTTP server + all pollers
│   │   │   ├── pr-review-payload.mjs  # OpenAB command parsing, prompt building
│   │   │   └── routes/
│   │   │       └── webhook-routes.mjs # Incoming webhook handler
│   │   ├── workflows/
│   │   │   ├── github-code.mjs        # Coding workflow (clone, run agent, create PR)
│   │   │   ├── pr-review.mjs          # PR review + auto-fix loop wiring
│   │   │   ├── chat-response.mjs      # Issue chat (Q&A) workflow
│   │   │   └── auto-fix.mjs           # Auto-fix on existing PR branch
│   │   ├── services/
│   │   │   ├── github.mjs             # GitHub API helpers (ghApi, addComment, labels)
│   │   │   ├── runtime-paths.mjs      # Paths, API endpoint configs
│   │   │   ├── logs.mjs               # Task log persistence
│   │   │   └── review-loop-store.mjs  # Review loop iteration tracking
│   │   └── lib/
│   │       ├── config.mjs             # Labels, agent names, bot users
│   │       ├── github-ops.mjs         # Lower-level GitHub operations
│   │       └── task-routing.mjs       # Issue routing logic
│   ├── docs/                          # Documentation
│   │   └── SETUP.md                   # This file
│   └── package.json
├── config/
│   └── agents/
│       ├── opencode-1.toml            # Berlin agent config
│       ├── opencode-2.toml            # Tokyo agent config
│       └── opencode-professor.toml    # Professor agent config
├── data/
│   ├── agents/                        # Docker volume mounts
│   │   ├── opencode-1/
│   │   ├── opencode-2/
│   │   └── opencode-professor/
│   ├── workspaces/                    # Temp task workspaces (auto-cleaned)
│   ├── shared/                        # Shared data between containers
│   └── ops-room/
│       ├── tasks/                     # Task queue
│       └── review-loop/               # Loop iteration state
├── scripts/
│   ├── entrypoint.sh                  # Docker container entrypoint
│   └── github-app-token.mjs           # GitHub App token generator
├── secrets/                           # NOT committed — create manually
│   ├── professor-key.pem
│   ├── berlin-key.pem
│   └── tokyo-key.pem
├── docker-compose.yml
└── .env                               # NOT committed — create manually
```

### Environment Variables

Create `openab-multi-agent/.env` (or `~/.env` and symlink it):

```bash
# ── Required ──────────────────────────────────────────────────────────

# GitHub App
GITHUB_APP_ID=4131786
GITHUB_APP_INSTALLATION_ID_PROFESSOR=142289926
GITHUB_APP_INSTALLATION_ID_BERLIN=142289926
GITHUB_APP_INSTALLATION_ID_TOKYO=142289926
GITHUB_APP_KEY_PATH=/path/to/private-key.pem

# Target repository
OPENAB_REPO=YourOrg/YourRepo

# Webhook secret (must match GitHub App config)
OPENAB_WEBHOOK_SECRET=your-openssl-generated-secret

# AI API credentials (for reviews and fix generation)
OPENCODE_API_KEY=sk-...

# ── Optional ──────────────────────────────────────────────────────────

# Discord bot tokens (for OpenAB agent Discord bots)
OPENCODE1_DISCORD_TOKEN=
OPENCODE2_DISCORD_TOKEN=
GEMINI_DISCORD_TOKEN=

# Ops Room
OPENAB_WEBHOOK_PORT=7381
OPENAB_SERVER_VERSION=1.0.0
OPENAB_MAX_REVIEW_ITERATIONS=3

# Agent display names
OPENAB_AGENT_NAMES=professor:Professor,berlin:Berlin,tokyo:Tokyo

# Agents to poll for issues
POLL_AGENTS=professor,berlin,tokyo

# AI model settings
OPENCODE_MODEL=deepseek-v4-flash
OPENCODE_MAX_TOKENS=16384

# Workspace cleanup
OPS_ROOM_KEEP_WORKSPACE=false

# Fallback AI provider
NVIDIA_API_KEY=nvapi-...
```

### Secrets Directory

Create `secrets/` with the GitHub App private key(s):

```bash
mkdir -p ~/openab-multi-agent/secrets
cp /path/to/downloaded/github-app.pem ~/openab-multi-agent/secrets/professor-key.pem
# Optionally use the same key for all agents:
cp ~/openab-multi-agent/secrets/professor-key.pem ~/openab-multi-agent/secrets/berlin-key.pem
cp ~/openab-multi-agent/secrets/professor-key.pem ~/openab-multi-agent/secrets/tokyo-key.pem
chmod 600 ~/openab-multi-agent/secrets/*.pem
```

---

## 3. Docker Agent Containers

The agent containers run [OpenAB](https://github.com/openab/openab) agents with OpenCode
CLI. They listen for `/openab` commands on Discord and execute coding tasks.

### docker-compose.yml

```yaml
version: '3.8'
services:
  opencode-professor:
    image: ghcr.io/openabdev/openab-opencode:latest
    container_name: openab-opencode-professor
    env_file: .env
    volumes:
      - ./config/agents/opencode-professor.toml:/etc/openab/config.toml:ro
      - ./data/agents/opencode-professor:/home/node
      - ./data/shared:/home/node/shared
      - ./secrets/professor-key.pem:/home/node/.ssh/github-app-key.pem:ro
      - ./secrets/berlin-key.pem:/home/node/.ssh/berlin-key.pem:ro
      - ./secrets/tokyo-key.pem:/home/node/.ssh/tokyo-key.pem:ro
    restart: unless-stopped

  opencode-1:   # Berlin
    image: ghcr.io/openabdev/openab-opencode:latest
    container_name: openab-opencode-1
    env_file: .env
    volumes:
      - ./config/agents/opencode-1.toml:/etc/openab/config.toml:ro
      - ./data/agents/opencode-1:/home/node
      - ./data/shared:/home/node/shared
      - ./secrets/berlin-key.pem:/home/node/.ssh/berlin-key.pem:ro
    restart: unless-stopped

  opencode-2:   # Tokyo
    image: ghcr.io/openabdev/openab-opencode:latest
    container_name: openab-opencode-2
    env_file: .env
    volumes:
      - ./config/agents/opencode-2.toml:/etc/openab/config.toml:ro
      - ./data/agents/opencode-2:/home/node
      - ./data/shared:/home/node/shared
      - ./secrets/tokyo-key.pem:/home/node/.ssh/tokyo-key.pem:ro
    restart: unless-stopped
```

Start them:

```bash
cd ~/openab-multi-agent
docker compose up -d
```

### Agent-Specific Configuration

**Berlin** — `config/agents/opencode-1.toml`:

```toml
[discord]
bot_token = "${OPENCODE1_DISCORD_TOKEN}"
allowed_channels = ["${DISCORD_CHANNEL_ID}"]
allow_bot_messages = "mentions"
allow_user_messages = "multibot-mentions"

[agent]
command = "opencode"
args = ["acp"]
working_dir = "/home/node"
```

**Tokyo** — `config/agents/opencode-2.toml`:

```toml
[discord]
bot_token = "${OPENCODE2_DISCORD_TOKEN}"
allowed_channels = ["${DISCORD_CHANNEL_ID}"]
allow_bot_messages = "mentions"

[agent]
command = "opencode"
args = ["acp"]
working_dir = "/home/node"
env = { OPENCODE_API_KEY = "${OPENCODE_API_KEY}" }
```

**Professor** — `config/agents/opencode-professor.toml`:

```toml
[discord]
bot_token = "${GEMINI_DISCORD_TOKEN}"
allowed_channels = ["${DISCORD_CHANNEL_ID}"]
allow_bot_messages = "mentions"

[agent]
command = "opencode"
args = ["acp"]
working_dir = "/home/node"
env = { OPENCODE_API_KEY = "${OPENCODE_API_KEY}" }
```

> The agent identity (Berlin vs Tokyo vs Professor) is determined by which Discord bot
> token and SSH key is mounted — the TOML files are structurally similar but reference
> different env vars.

---

## 4. Systemd Service

Install the tracked template `ops-room/deploy/openab-ops-room.service` as `/etc/systemd/system/openab-ops-room.service`. It runs `/opt/ops-room/current` and reads stable absolute paths from `/etc/openab/ops-room.env`.

```ini
[Unit]
Description=OpenAB Ops Room
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/ops-room/current/ops-room
EnvironmentFile=/etc/openab/ops-room.env
ExecStart=/usr/bin/node src/server/webhook.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=60
KillSignal=SIGTERM
KillMode=control-group
Environment=OPENAB_WEBHOOK_PORT=7381

[Install]
WantedBy=multi-user.target
```

Start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable openab-ops-room.service
sudo systemctl start openab-ops-room.service

# Watch logs:
sudo journalctl -u openab-ops-room -f
```

---

## 5. GitHub Actions

The target repository needs two workflow files to route `/openab` commands.

### `.github/workflows/openab-issue-command.yml`

Handles `/openab <agent> --code "task"` comments on issues:

```yaml
name: OpenAB Issue Command
on:
  issue_comment:
    types: [created]
jobs:
  route:
    if: startsWith(github.event.comment.body, '/openab')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/github-script@v7
        with:
          script: |
            const comment = context.payload.comment;
            const issue = context.payload.issue;
            const body = comment.body;
            const match = body.match(/^\/openab\s+(\S+)\s*(.*)/);
            if (!match) return;
            const agent = match[1];
            const task = match[2];
            await github.rest.issues.addLabels({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: issue.number,
              labels: [`openab/${agent}`],
            });
            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: issue.number,
              body: `## openab-command\nagent=${agent}\ntask=${task}\ncomment_id=${comment.id}\n` +
                    (issue.pull_request ? `pr=true\nrepo=${context.repo.repo}\n` : ''),
            });
```

### `.github/workflows/openab-pr-review.yml`

Handles `/openab professor --review` or `--auto-fix` on PRs:

```yaml
name: OpenAB PR Review
on:
  issue_comment:
    types: [created]
jobs:
  review:
    if: startsWith(github.event.comment.body, '/openab') && github.event.issue.pull_request
    runs-on: ubuntu-latest
    steps:
      - uses: actions/github-script@v7
        with:
          script: |
            const comment = context.payload.comment;
            const body = comment.body;
            const match = body.match(/^\/openab\s+(\S+)\s+(--\S+)?\s*(.*)/);
            if (!match || match[1] !== 'professor') return;
            const mode = match[2] === '--auto-fix' ? 'auto-fix' : 'review';
            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.payload.issue.number,
              body: `## openab-command\nagent=professor\nmode=${mode}\npr=true\ncomment_id=${comment.id}`,
            });
```

---

## 6. How Everything Connects

### Trigger Paths

| Trigger | How | Frequency |
|---------|-----|-----------|
| **Issue command** | User posts `/openab berlin --code "..."` → GitHub Action adds label `openab/berlin` + metadata comment → Issue poller detects it → Coding workflow runs | Every 30s |
| **PR auto-review** | Coding agent creates PR → labels `openab/pr-created` → PR review poller detects it → Professor reviews with `auto-fix` mode | Every 60s |
| **Manual PR review** | User posts `/openab professor --review` on a PR → webhook routes to Professor | Real-time |
| **Auto-fix loop** | Review returns `REQUEST_CHANGES` → AI generates fix → Berlin's container pushes → re-review | Immediate |

### Full Data Flow

```
USER posts on GitHub Issue:
  /openab berlin --code "add input validation"

    → GitHub Action adds label "openab/berlin"
    → GitHub Action posts metadata comment

    → Issue Poller (30s) detects label
    → handleTask() → runCodingWorkflow()
      → Creates workspace
      → Runs coding agent (OpenCode/Codex)
      → Agent commits + pushes
      → gh pr create → labels "openab/pr-created"

    → PR Review Poller (60s) detects PR
    → Adds "openab/review-pending" + "openab/review-loop"
    → Professor reviews via AI API

       ├── APPROVE → labels "openab/review-approved" ✅
       │
       ├── COMMENT → acknowledgment, loop ends
       │
       └── REQUEST_CHANGES
            → Auto-fix workflow:
              1. Clone PR branch in Berlin's container
              2. AI generates fix code (same API as review)
              3. Write files → commit → push as lihsheng-berlin[bot]
              4. Re-review (recursive)
              5. Loop max 3x, then "openab/needs-human"
```

---

## 7. Labels Reference

| Label | Purpose | Created By |
|-------|---------|------------|
| `openab/<agent>` | Route issue to agent | GitHub Action |
| `openab/<agent>/wip` | Work-in-progress lock | Coding workflow |
| `openab/<agent>/failed` | Task failed | Coding workflow |
| `openab/pr-created` | Coding agent created a PR | Coding workflow |
| `openab/review-pending` | PR queued for review | PR review poller |
| `openab/review-loop` | Review in progress (prevents re-trigger) | PR review poller |
| `openab/review-approved` | Review passed | Review workflow |
| `openab/changes-requested` | Review requests changes | Review workflow |
| `openab/needs-human` | Escalated — loop exhausted or error | Auto-fix workflow |
| `openab/auto-fix-failed` | Auto-fix attempt failed | Auto-fix workflow |
| `openab/done` | Task completed | Coding workflow |

## 8. Agent-to-Container Mapping

| Agent | Docker Container | GitHub Bot Identity |
|-------|-----------------|-------------------|
| Professor | `openab-opencode-professor` | `lihsheng-professor[bot]` |
| Berlin | `openab-opencode-1` | `lihsheng-berlin[bot]` |
| Tokyo | `openab-opencode-2` | `lihsheng-tokyo[bot]` |

## 9. API Endpoints

The Ops Room serves on port 7381:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/webhook` | POST | Receive issue commands and metadata |
| `/health` | GET | Basic health check |
| `/api/health` | GET | Detailed health (agent status, uptime) |
| `/api/tasks` | GET | List pending and completed tasks |
| `/api/logs` | GET | Bounded task logs |
| `/api/agents` | GET | List agents with status |
| `/api/openab/instances` | GET | OpenAB instance dashboard |

## 10. Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| **Review is empty** | AI reasoning exhausts token budget | Increase `OPENCODE_MAX_TOKENS` (default 16384). Retry mechanism handles this automatically. |
| **Auto-fix fails: "container not found"** | Docker container stopped | `docker ps` to check. `docker compose up -d opencode-1` |
| **Fix written to wrong file path** | AI prompt lacked diff context | Ensure PR diff is included in fix prompt (auto-fix.mjs does this since c66155b) |
| **Git push fails** | Container `gh` auth expired | `docker exec openab-opencode-1 gh auth status` |
| **Webhook 401** | `OPENAB_WEBHOOK_SECRET` mismatch | Must match between GitHub App and `.env` |
| **Issue not picked up by poller** | Missing label | Issue must have `openab/<agent>` label |
| **`/openab` command ignored** | No GitHub Action workflow | Add `.github/workflows/openab-issue-command.yml` to target repo |
| **Auto-fix not triggered** | Review was `COMMENT`, not `REQUEST_CHANGES` | Only `REQUEST_CHANGES` triggers auto-fix |
| **Container "can't fork"** | Docker PID limit exhausted | `docker container prune` and restart Docker daemon |
| **AI API "Insufficient balance"** | API key out of credits | Top up at https://opencode.ai or use a different key |

## 11. Quick Start Checklist

- [ ] 1. Create GitHub App with required permissions and webhook
- [ ] 2. Install app on target repo, note App ID + Installation ID
- [ ] 3. Clone ops-room repo, `npm install`
- [ ] 4. Create `.env` with all required variables
- [ ] 5. Place GitHub App private key in `secrets/`
- [ ] 6. Create agent config TOML files in `config/agents/`
- [ ] 7. Start agent containers: `docker compose up -d`
- [ ] 8. Set up systemd service: `sudo systemctl start openab-ops-room`
- [ ] 9. Add GitHub Action workflow files to target repo
- [ ] 10. Test: post `/openab berlin --code "hello world"` on a test issue
- [ ] 11. Verify: `sudo journalctl -u openab-ops-room -f`
