# Ops Room

Control surface for OpenAB agents: webhook receiver, task poller, claim CLI, and GitHub automation.

## Source Layout

```
ops-room/
├── src/
│   ├── server/       → webhook.mjs, poller.mjs, claim.mjs, github-app-token.mjs
│   ├── app/          → dashboard UI (index.html, app.js, styles.css)
│   └── lib/          → shared helpers
├── scripts/          → maintenance/debug scripts
└── package.json
```

Runtime data is stored outside the source tree at `../data/ops-room/`:

```
data/ops-room/
├── logs/     → server.log, poller.log
├── state/    → processed-tasks.json
└── tasks/    → task JSON files
```

## OpenAB Instances Dashboard

A read-only dashboard at `/` that shows all configured OpenAB instances as operator-friendly status cards.

- **Endpoint**: `GET /api/openab/instances`
- **Dashboard**: `GET /` (serves static HTML/CSS/JS from `src/app/`)
- **UI model**: one card per agent with status, health, container, backend, service mode, GitHub polling state, restart count, config path, and data directory.
- **Quick actions**: card buttons link to the logs and tasks views. They are navigation helpers only, not mutating controls.
- **Docker status**: best-effort via host Docker CLI (`docker inspect`). Falls back to `unknown` if unavailable.
- **Cache**: 5-second in-memory cache for Docker inspect results.
- **Security**: read-only; no restart, reload, or config-edit controls.

On the VPS, the dashboard is intended to run directly on the host:

```bash
sudo systemctl status openab-ops-room.service --no-pager
sudo systemctl restart openab-ops-room.service
sudo journalctl -u openab-ops-room.service -f
```

The host service listens on `OPENAB_WEBHOOK_PORT=7381`, so local access is:

```bash
curl http://127.0.0.1:7381/
curl http://127.0.0.1:7381/api/openab/instances
```

For public access, route Cloudflare Zero Trust to the same host service:

- Tunnel: `hermes-dashboard`
- Public hostname: `ops-room.lihsheng.space`
- Service target: `http://localhost:7381`

If Cloudflare Access login works but the page shows `404` or `not found`, the Access app exists but the tunnel public hostname route is likely missing or still points at the fallback route.

Run the smoke check:
```bash
npm run smoke:instances
```

## Scripts

| Command | Description |
|---|---|
| `npm run bootstrap` | Create required runtime directories |
| `npm start` | Start webhook server (with built-in poller) |
| `nohup npm start >> ../data/ops-room/logs/server.log 2>&1 &` | Start webhook server detached without a shell wrapper |
| `npm run poll` | Run standalone poller |
| `npm run claim` | Claim tasks via CLI |
| `npm run smoke:instances` | Smoke test the OpenAB instances endpoint |

`npm start` requires `OPENAB_WEBHOOK_SECRET` to be set. The server now refuses to start with a default dev secret.

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
