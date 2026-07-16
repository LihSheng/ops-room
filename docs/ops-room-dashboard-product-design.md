# Ops Room Dashboard Redesign and Product Direction

## Purpose

The dashboard should not become a prettier Docker monitor. It should become the operational home for a multi-agent system.

The redesigned overview answers four questions in the first viewport:

1. Is the agent fleet healthy?
2. What work is currently running?
3. Which tasks need human attention?
4. Is the Ops Room harness and its dependencies healthy?

## Product Positioning Reflected in the UI

Ops Room is the control plane for agents and workflows. GitHub is one integration and task source, not the identity of the product.

The information architecture therefore reserves first-class modules for:

- **Overview** — fleet health, active work, blockers, and infrastructure status.
- **Agents** — agent identity, runtime, model/backend, personality, skills, permissions, workspace, and lifecycle.
- **Workflows** — reusable orchestration such as implement → review → fix → re-review.
- **Tasks** — queued, active, completed, failed, cancelled, and human-intervention states.
- **Activity** — immutable operational and security audit history.
- **Settings** — integrations, policies, credentials references, limits, and environment configuration.

## Design Decisions

### 1. Agent fleet is a structured list, not a card gallery

A list scales better when Ops Room grows from four agents to dozens. It also makes status, current assignment, backend, and actions easier to compare.

### 2. Human attention is separated from general activity

`NEEDS_HUMAN`, `CHANGES_REQUESTED`, `ERROR`, and other blocked states are promoted into a dedicated triage surface. The operator should not need to inspect every agent or log to find blocked work.

### 3. Current work and historical work share one queue

The task surface supports filters for all work, active work, and attention-required work. Later, this should become a dedicated task explorer with search, repository, workflow, agent, status, and time filters.

### 4. The dashboard remains read-only for now

The redesign keeps existing log and task drill-down but does not add restart, stop, configuration editing, or shell execution.

Lifecycle actions should only be introduced after:

- Authentication is enforced.
- RBAC permissions are defined.
- Every mutation has an audit record.
- Confirmation and reason capture are available.
- Agent leases and running-task safety rules are enforced.

### 5. Navigation exposes the future product shape without pretending unfinished features exist

Future modules are visible as planned navigation items. In the demo they show a small informational message instead of navigating to fake screens.

## Recommended Backend/API Evolution

The current dashboard can use:

- `GET /api/health`
- `GET /api/openab/instances`
- `GET /api/tasks`
- `GET /api/logs?agent=<agent>`

The next API layer should normalize the control-plane data model:

```text
GET /api/overview
GET /api/agents
GET /api/agents/:id
GET /api/agents/:id/runs
GET /api/workflows
GET /api/workflows/:id/runs
GET /api/tasks?status=&agent=&workflow=&repository=
GET /api/activity
```

A future `GET /api/overview` response should aggregate counts server-side instead of making the browser infer every metric from raw task files.

## Recommended Delivery Phases

### Phase 1 — Read-only command center

- Ship this overview redesign.
- Normalize task state labels.
- Add pagination or a server-side limit for task history.
- Add a single safe agent-detail endpoint.
- Keep all controls read-only.

### Phase 2 — Agent registry and workflow visibility

- Agent profiles: role, personality, skills, model, repository access, and runtime configuration metadata.
- Workflow definitions and run history.
- Task dependency and parent/child relationships.
- Review-loop visualization.

### Phase 3 — Controlled operations

- Pause/resume agent intake.
- Retry or cancel eligible tasks.
- Start/stop agents only with RBAC, audit logs, confirmations, and lease-aware safeguards.
- Policy controls for auto-fix, retry budgets, and human approval gates.

### Phase 4 — Multi-tenant product control plane

- Organizations, environments, projects, and teams.
- Tenant-scoped agents and integrations.
- Role-based permissions and approval policies.
- Usage, cost, model limits, and operational analytics.

## Demo

`dashboard-demo/index.html` is a standalone mock-data preview. It does not call production APIs and can be reviewed independently from the live Ops Room service.
