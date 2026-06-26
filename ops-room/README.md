# Ops Room

Control surface for OpenAB agents: webhook receiver, task poller, claim CLI, and GitHub automation.

## Source Layout

```
ops-room/
├── src/
│   ├── server/       → webhook.mjs, poller.mjs, claim.mjs, github-app-token.mjs
│   ├── app/          → future UI/settings pages
│   └── lib/          → shared helpers
├── scripts/          → maintenance/debug scripts
├── package.json
└── start.sh
```

Runtime data is stored outside the source tree at `../data/ops-room/`:

```
data/ops-room/
├── logs/     → server.log, poller.log
├── state/    → processed-tasks.json
└── tasks/    → task JSON files
```

## Scripts

| Command | Description |
|---|---|
| `npm run bootstrap` | Create required runtime directories |
| `npm start` | Start webhook server (with built-in poller) |
| `npm run poll` | Run standalone poller |
| `npm run claim` | Claim tasks via CLI |

## Environment Variables

Ops Room reads runtime paths from environment variables:

- `OPENAB_ROOT` — absolute path to the repo root
- `OPENAB_AGENTS_CONFIG_DIR` — path to `config/agents/`
- `OPENAB_DATA_DIR` — path to `data/`
- `OPENAB_AGENTS_DIR` — path to `data/agents/`
- `OPENAB_WORKSPACES_DIR` — path to `data/workspaces/`
- `OPENAB_SHARED_DIR` — path to `data/shared/`
- `OPENAB_SECRETS_DIR` — path to `secrets/`
- `OPS_ROOM_STATE_DIR` — path to `data/ops-room/state/`
- `OPS_ROOM_TASKS_DIR` — path to `data/ops-room/tasks/`
- `OPS_ROOM_LOGS_DIR` — path to `data/ops-room/logs/`

## Responsibilities

- Receive GitHub webhooks
- Poll GitHub issues and PRs for `openab/<agent>` labels
- Claim and dispatch OpenAB tasks
- Track processed task state
- Store harness logs and task files

Does **not** store agent workspaces, private keys, or agent home directories.
