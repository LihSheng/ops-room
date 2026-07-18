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
- Agent-profile, skill, and memory-space API routes

The public `/health` endpoint returns only basic service status and uptime.

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

## Credential handling

Ops Room applies centralized redaction before writing task logs and before publishing GitHub issue comments. The redactor covers common GitHub, AI-provider, cloud, bearer-header, secret-assignment, and private-key formats.

Redaction is defence in depth, not a credential-storage mechanism:

- Never commit `.env`, private keys, agent data, workspaces, task payloads, or logs.
- Never intentionally print environment variables or request headers.
- Do not commit CI diagnostic output back into a branch.
- Use short-retention GitHub Actions artifacts for diagnostics.
- Rotate a credential immediately if it appears in a public issue, PR, workflow log, artifact, or Git history.

## Repository controls

Enable these GitHub repository protections where available:

- Secret scanning
- Push protection
- Dependabot alerts and security updates
- Branch protection requiring the `Required checks` CI job
- Approval before workflows from first-time external contributors run

GitHub Actions workflows should retain read-only repository permissions unless a narrowly scoped write operation is essential.
