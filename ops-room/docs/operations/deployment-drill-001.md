# Deployment Drill 001 — Immutable Activation and Rollback

Status: **Prepared — VPS execution pending**  
Backlog item: `OPS-001`  
Prepared from repository revision: `0e348d4236f815dae23747973938b3153f0e7439`

This document is both the execution runbook and the evidence record for the first real Ops Room immutable-release drill. Do not mark it complete until two releases have been activated on the VPS and a real rollback has restored the first release.

## Safety boundary

- Do not build from the mutable production checkout.
- Do not place `.env`, secrets, runtime data, logs, workspaces, or agent configuration inside `/opt/ops-room/releases`.
- Do not restart while `legacy-issue:*` work is active.
- Use `OPS_ROOM_ALLOW_LEGACY_MIGRATION=true` only for the first cutover from the mutable service.
- Keep `OPS_ROOM_OPERATOR_API_ENABLED=false` during this drill.
- Stop immediately when preflight or SHA-aware readiness fails.

## 1. Drill metadata

| Field | Evidence |
|---|---|
| Operator | Pending |
| Execution date | Pending |
| VPS hostname | Pending |
| VPS operating system | Pending |
| Node version at `/opt/ops-room/bin/node` | Pending |
| First release SHA | Pending |
| Second release SHA | Pending |
| Public authenticated URL | `https://ops-room.lihsheng.space/` |
| Local health URL | `http://127.0.0.1:7381/api/health` |

## 2. CI and branch-protection gate

Before touching the VPS:

- [ ] The pull request and selected release commits pass the aggregated `Required checks` job.
- [ ] `Required checks` is configured as a required check for `main`.
- [ ] A failing required check blocks merge.
- [ ] The selected release SHAs are full 40-character commit IDs.

Evidence:

```text
Branch protection URL or screenshot reference:

First release CI run:

Second release CI run:
```

## 3. Prepare the host contract

Expected layout:

```text
/opt/ops-room/
├── bin/node
├── releases/
├── locks/
├── scripts/
│   ├── activate-release.sh
│   ├── rollback-release.sh
│   └── verify-release.js
├── current -> releases/<sha>
└── previous -> releases/<sha>

/etc/openab/ops-room.env
/etc/systemd/system/openab-ops-room.service
```

Install the stable Node runtime, root-owned deployment scripts, environment file, and systemd unit. The installed scripts must not be writable by the service account.

Run the repository preflight from a clean checkout:

```bash
cd /path/to/clean/ops-room/ops-room
npm ci --ignore-scripts
npm run deployment:preflight
```

For a non-default installation, pass explicit paths:

```bash
sudo env \
  OPS_ROOM_INSTALL_ROOT=/opt/ops-room \
  OPS_ROOM_NODE_BIN=/opt/ops-room/bin/node \
  OPS_ROOM_DEPLOY_SCRIPTS_DIR=/opt/ops-room/scripts \
  OPS_ROOM_ENV_FILE=/etc/openab/ops-room.env \
  OPS_ROOM_SYSTEMD_UNIT=/etc/systemd/system/openab-ops-room.service \
  /opt/ops-room/bin/node scripts/deploy/preflight-host.js
```

Preflight evidence:

```text
Command:

Output summary:

Warnings accepted and rationale:
```

- [ ] Preflight reports zero failures.
- [ ] Node is 20.19.0 or newer.
- [ ] Persistent path values in `/etc/openab/ops-room.env` are absolute.
- [ ] The environment file is not accessible to other users.
- [ ] Release, lock, scripts, and stable Node paths satisfy ownership and write-permission checks.
- [ ] The systemd unit runs `src/server/webhook.js` from `/opt/ops-room/current/ops-room` without `npm install`, `npm start`, or a build command.

## 4. Build and verify release A

Use a clean checkout on a build machine:

```bash
RELEASE_A=<40-character-sha>
OUTPUT_DIR=/tmp/ops-room-releases

git checkout "$RELEASE_A"
cd ops-room
npm ci --ignore-scripts
npm run build
npm run release:build -- "$RELEASE_A" "$OUTPUT_DIR"
npm run release:verify -- \
  "$OUTPUT_DIR/ops-room-$RELEASE_A.tar.gz" \
  "$RELEASE_A" \
  "$OUTPUT_DIR/ops-room-$RELEASE_A.tar.gz.sha256"
```

Record:

```text
Release A SHA:
Archive filename:
Checksum filename:
Checksum verification output:
Artifact allowlist verification output:
Transfer method and destination:
```

- [ ] The archive contains only `RELEASE.json`, `ops-room/package.json`, compiled server files, and built dashboard files.
- [ ] The checksum is stored outside the archive.
- [ ] No secret or runtime path is present in the archive.

## 5. First immutable activation

First confirm that no active legacy issue operation will be interrupted:

```bash
curl -fsS http://127.0.0.1:7381/api/health
```

Inspect `lifecycle.operations`. Do not continue when an entry starts with `legacy-issue:`.

For the one-time mutable-checkout cutover only:

```bash
sudo OPS_ROOM_ALLOW_LEGACY_MIGRATION=true \
  /opt/ops-room/scripts/activate-release.sh \
  /path/to/ops-room-$RELEASE_A.tar.gz \
  /path/to/ops-room-$RELEASE_A.tar.gz.sha256 \
  "$RELEASE_A"
```

Record:

```text
Activation command with secret values omitted:
Activation output:
/opt/ops-room/current target:
systemctl status summary:
```

Verify:

```bash
readlink /opt/ops-room/current
sudo systemctl status openab-ops-room.service --no-pager
curl -fsS http://127.0.0.1:7381/api/health
```

- [ ] `current` points to `releases/$RELEASE_A`.
- [ ] The service is active.
- [ ] `ready` is `true`.
- [ ] `revision` exactly equals release A.
- [ ] Lifecycle state is `running`.
- [ ] Required stores and commands are healthy.
- [ ] The service binds to loopback.
- [ ] The dashboard loads through Cloudflare Access.
- [ ] GitHub polling and review reconciliation remain operational.

Health summary after release A:

```json
{
  "ready": "pending",
  "revision": "pending",
  "lifecycle": "pending",
  "dependencies": "pending"
}
```

## 6. Build and activate release B

Repeat the clean build and verification process for another known-good commit:

```bash
RELEASE_B=<different-40-character-sha>
```

Activate without the migration escape hatch:

```bash
sudo /opt/ops-room/scripts/activate-release.sh \
  /path/to/ops-room-$RELEASE_B.tar.gz \
  /path/to/ops-room-$RELEASE_B.tar.gz.sha256 \
  "$RELEASE_B"
```

- [ ] `current` points to `releases/$RELEASE_B`.
- [ ] `previous` points to `releases/$RELEASE_A`.
- [ ] Health reports `ready: true` and release B.
- [ ] Persistent task, review-task, state, log, and workspace data remain present.

Health summary after release B:

```json
{
  "ready": "pending",
  "revision": "pending",
  "lifecycle": "pending",
  "dependencies": "pending"
}
```

## 7. Real rollback

Execute:

```bash
sudo /opt/ops-room/scripts/rollback-release.sh
```

Verify:

```bash
readlink /opt/ops-room/current
readlink /opt/ops-room/previous
sudo systemctl status openab-ops-room.service --no-pager
curl -fsS http://127.0.0.1:7381/api/health
```

- [ ] `current` points back to `releases/$RELEASE_A`.
- [ ] `previous` points to `releases/$RELEASE_B`.
- [ ] The service is active.
- [ ] Health reports `ready: true` and release A.
- [ ] Persistent runtime data survived both activations and rollback.

Rollback evidence:

```text
Rollback output:
Current target:
Previous target:
Health revision:
Persistent-state verification:
```

## 8. Public boundary verification

- [ ] `ss -lntp` shows Ops Room on `127.0.0.1:7381`, not a public interface.
- [ ] The Cloudflare Tunnel public hostname targets `http://localhost:7381`.
- [ ] Cloudflare Access authentication is required.
- [ ] Direct unauthenticated public access is not available.

Evidence:

```text
Loopback listener:
Tunnel route:
Access verification:
```

## 9. Incidents and follow-up work

| Observation | Impact | Remediation | Follow-up issue |
|---|---|---|---|
| Pending | Pending | Pending | Pending |

## 10. Completion sign-off

OPS-001 is complete only after every statement below is true:

- [ ] Two immutable releases were successfully activated on the real VPS.
- [ ] A real rollback restored release A.
- [ ] SHA-aware health verified the expected revision after every transition.
- [ ] No release was built from the mutable production checkout.
- [ ] Persistent data survived activation and rollback.
- [ ] Active legacy work was not interrupted.
- [ ] The aggregated CI check is required on `main`.
- [ ] This evidence record contains no secrets.
- [ ] Another operator can repeat the drill from this document.

Final result: **Pending**

```text
Operator sign-off:
Reviewed by:
Final reviewed commit SHA:
Date:
```
