# OPS-012H.3 — Final activity and notification dashboard integration

## Purpose

OPS-012H.3 completes the Mission activity and notification epic by connecting the browser to the accepted H.1 and H.2 server contracts.

```text
Durable Mission Room activity
            ↓
GET /api/activity-events
            ↓
Activity workspace

Durable activity + per-operator state
            ↓
/api/operator/notifications
            ↓
Unread badge, inbox, exact drill-in, read and acknowledgement actions
```

The browser is a presentation and operator-action client. It is not a Mission, Workflow, notification-ID, or transition authority.

## Activity workspace

The `/activity` route no longer derives a timeline from the latest task snapshots. It reads the durable global activity index and supports:

- all or attention-only views;
- severity filtering;
- category filtering;
- Mission filtering;
- exact Mission, stage, Agent Detail, and Workflow links;
- exact activity highlighting through `?activity=<activity_id>`;
- independent Mission and Mission Room source-health evidence.

When a source is degraded, healthy events remain visible. The browser does not fabricate placeholders or infer missing transitions.

## Notification workspace

The notification inbox is available at:

```text
/activity?view=notifications
```

Exact drill-in uses:

```text
/activity?view=notifications&notification=<notification_id>
```

The inbox shows only the authenticated operator's state and supports:

- all, unread, read, and acknowledged filters;
- exact durable Mission/activity identity;
- priority, type, reason, and timestamp evidence;
- Mission, stage, Agent Detail, Workflow, Activity, and Needs Human links;
- explicit mark-read;
- explicit acknowledgement with a bounded human reason.

Read and acknowledgement requests use the H.2 CSRF, idempotency, locking, audit, and per-operator isolation boundaries. Acknowledgement implies read and cannot be downgraded.

## Header badge

The dashboard entry point mounts one global unread badge into the existing AppShell header. It:

- reads only the authenticated per-operator notification summary;
- polls at the existing dashboard cadence;
- routes to `/activity?view=notifications`;
- hides when the operator notification endpoint is unavailable, including legacy dashboard-token mode;
- performs no mutation.

## Refresh and restart behavior

The UI keeps exact notification and activity identities in URL query parameters. After refresh:

- the same durable activity can be highlighted;
- the same notification can be loaded from the exact detail route;
- read and acknowledgement state is reloaded from the durable per-operator store;
- no browser cache is treated as authority;
- no duplicate notification event content is created.

Server restart acceptance is inherited from the H.1 durable activity sources and H.2 durable operator-state store. The browser only re-reads those contracts.

## Degradation behavior

Activity-source and operator-state health remain separate. A degraded Mission Room source does not imply that existing operator state is lost. A notification read failure does not trigger any operational action.

## Security and authority review

OPS-012H.3 does not add authority to:

- invoke a provider;
- replay or resolve an uncertain effect;
- mutate a task, Workflow, stage, Mission, workspace, or chat session;
- use Git or GitHub;
- change agent lifecycle;
- release or deploy;
- send email, Slack, Discord, GitHub comments, or mobile push;
- expose raw provider output, credentials, environment values, authenticated remotes, absolute host paths, unrestricted logs, chat transcripts, or private reasoning.

The browser receives bounded public evidence only. Internal links are accepted only when they are same-origin paths.

## Acceptance checklist

- [x] Activity uses `GET /api/activity-events`, not task snapshots.
- [x] Notification UI uses H.2 list, detail, read, and acknowledge routes.
- [x] Human-session gating is visible.
- [x] Header badge reflects server summary unread count.
- [x] Exact drill-in survives refresh through URL identity.
- [x] Degraded source evidence is shown without placeholders.
- [x] Read/acknowledgement remains CSRF-protected, idempotent, audited, and per-operator.
- [x] External delivery and autonomous actions remain deferred.
