# Ops Room Security Guide

Ops Room may be developed in a public repository, but its runtime is an operational control surface and must not be exposed as an unauthenticated public service.

## Required runtime boundary

- Keep `OPENAB_WEBHOOK_HOST=127.0.0.1`.
- Do not expose port `7381` directly through the VPS firewall or cloud security group.
- Publish the service only through a reverse proxy.
- Keep `/health` available for basic load-balancer health checks.
- Require `OPS_ROOM_DASHBOARD_TOKEN` for read-only operational APIs.
- Keep `OPENAB_WEBHOOK_SECRET` separate from the dashboard token.
- Keep the operator mutation API disabled unless it is actively required.
- Cloudflare Tunnel should target Caddy, not Ops Room directly.
- Port `7381` remains bound to `127.0.0.1` in production.

Generate independent secrets:

```bash
openssl rand -hex 32  # OPENAB_WEBHOOK_SECRET
openssl rand -hex 32  # OPS_ROOM_DASHBOARD_TOKEN
openssl rand -hex 32  # OPS_ROOM_OPERATOR_TOKEN, only when enabled
```

The dashboard token falls back to the webhook secret for backward compatibility, but production deployments should always configure a separate value.

## Protected operational endpoints

The following read-only routes require `Authorization: Bearer <OPS_ROOM_DASHBOARD_TOKEN>`:

- `/api/health`
- `/api/tasks` and task detail routes
- `/api/logs`
- `/api/agents`
- `/api/openab/instances`
- `/api/agents/profiles` and detail routes `/api/agents/profiles/:id`
- `/api/skills` and detail routes `/api/skills/:key/:version`
- `/api/memory-spaces`

The public `/health` endpoint returns only basic service status and uptime.
The `/webhook` endpoint uses its own `OPENAB_WEBHOOK_SECRET`, not the dashboard token.

## Reverse proxy example

The proxy should preserve the caller-supplied authorization header for `/webhook`, while injecting the dashboard token only for dashboard and read-only API traffic.

```caddyfile
ops.example.com {
    # Put Cloudflare Access, VPN access, or another user authentication layer
    # in front of the dashboard route.

    handle /webhook {
        reverse_proxy 127.0.0.1:7381
    }

    handle {
        reverse_proxy 127.0.0.1:7381 {
            header_up Authorization "Bearer {$OPS_ROOM_DASHBOARD_TOKEN}"
        }
    }
}
```

The Caddy service must receive `OPS_ROOM_DASHBOARD_TOKEN` through a protected environment file. Do not place the token directly in a tracked Caddyfile.

## Git authentication

Git operations (clone, fetch, push) use ephemeral credential injection:

- Git remote URLs must never contain credentials.
- The remote URL stored in `.git/config` is always the clean `https://github.com/<owner>/<repo>.git` form.
- Authentication is provided through `GIT_ASKPASS` temporary helper scripts.
- The askpass helper reads the installation token from the `GIT_ASKPASS_TOKEN` environment variable.
- The token is never written into the askpass script itself.
- The helper is created outside the repository workspace under a temp directory.
- Restrictive file permissions are set on Unix (mode `500`).
- The helper is deleted in a `finally` block after each operation.
- `GIT_TERMINAL_PROMPT=0` prevents interactive credential prompts.

## Credential handling

Ops Room applies centralized redaction before writing task logs, before publishing GitHub issue comments, before sending external notification payloads, and before writing console output. The redactor covers common GitHub, AI-provider, cloud, bearer-header, secret-assignment, and private-key formats.

Redaction is defence in depth, not a credential-storage mechanism:

- Never commit `.env`, private keys, agent data, workspaces, task payloads, or logs.
- Never intentionally print environment variables or request authorization headers.
- Do not commit CI diagnostic output back into a branch.
- Use short-retention GitHub Actions artifacts for diagnostics.
- Rotate a credential immediately if it appears in a public issue, PR, workflow log, artifact, or Git history.
- Public failure comments intentionally omit local workspace paths (e.g., `/data/workspaces/`).
- Askpass credential helpers are always cleaned up after use.

## Environment isolation

Coding-agent subprocesses receive an explicit environment allowlist:

- Only variables required for OS execution, model/provider selection, and Git operations are passed.
- The allowlist excludes: `OPENAB_WEBHOOK_SECRET`, `OPS_ROOM_DASHBOARD_TOKEN`, `OPS_ROOM_OPERATOR_TOKEN`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_KEY_PATH`, and other unrelated secrets.
- The allowlist is defined in `AGENT_ENV_ALLOWLIST` within the coding workflow.

Deferred hardening: per-provider scoping and per-agent environment profiles.

## Repository controls

Enable these GitHub repository protections where available:

- Secret scanning
- Push protection
- Dependabot alerts and security updates
- Branch protection requiring the `Required checks` CI job
- Approval before workflows from first-time external contributors run

GitHub Actions workflows should retain read-only repository permissions unless a narrowly scoped write operation is essential.
