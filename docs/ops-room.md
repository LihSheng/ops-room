# Ops Room

Ops Room is the OpenAB control surface for GitHub-driven work. It owns the webhook server, issue poller, task routing, GitHub App auth, and coding-task PR workflow.

## Current Startup

Run from the package directory:

```bash
cd ops-room
npm run bootstrap
npm start
```

Detached start without a wrapper script:

```bash
nohup npm start >> ../data/ops-room/logs/server.log 2>&1 &
```

`npm start` uses Node `--env-file=../.env`, so the repo-level `.env` is loaded directly by Node. `OPENAB_WEBHOOK_SECRET` is required; the server refuses to start if it is missing.

## Source Layout

```text
ops-room/
├── src/
│   ├── lib/
│   │   ├── config.mjs
│   │   ├── github-app.mjs
│   │   ├── github-ops.mjs
│   │   ├── issue-poller.mjs
│   │   └── task-routing.mjs
│   └── server/
│       ├── webhook.mjs
│       ├── poller.mjs
│       ├── claim.mjs
│       └── github-app-token.mjs
├── scripts/
├── package.json
└── README.md
```

## Responsibilities

- `src/server/webhook.mjs`
  Runs the HTTP server, starts the in-process poll loop, receives `/webhook` payloads, and owns the coding/chat task workflows.
- `src/server/poller.mjs`
  Standalone poller entrypoint that reuses the same shared poll loop for label-based issue claiming.
- `src/server/claim.mjs`
  CLI for listing or claiming queued tasks manually.
- `src/lib/config.mjs`
  Shared agent IDs, aliases, label colors, and GitHub App env key mapping.
- `src/lib/task-routing.mjs`
  Shared metadata-comment parsing and chat/code task classification.
- `src/lib/github-app.mjs`
  Shared GitHub App token loading helper.
- `src/lib/github-ops.mjs`
  Shared GitHub comment, label, and `gh api` helpers.
- `src/lib/issue-poller.mjs`
  Shared poll loop used by both `webhook.mjs` and `poller.mjs`.

## Runtime Data

Runtime state is stored outside the source tree:

```text
data/ops-room/
├── logs/
├── state/
└── tasks/
```

Coding task workspaces are created under `data/workspaces/`.

## Recent Cleanup

- Removed shell launchers from `ops-room`; startup is now handled directly by `npm start`.
- Moved duplicated config, task parsing, GitHub App auth, label ops, and poll-loop logic into `src/lib/`.
- Made `OPENAB_WEBHOOK_SECRET` mandatory at startup.
- Switched coding-task Git author configuration from global Git config to per-workspace repo config.
