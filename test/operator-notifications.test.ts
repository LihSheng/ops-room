import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildOperatorNotificationInbox,
  classifyActivityNotification,
  handleAcknowledgeNotification,
  handleMarkNotificationRead,
  projectActivityNotification,
} from '../src/services/operator-notifications.js';

const actor = {
  actor_type: 'human',
  actor_id: 'operator-alpha',
  actor_display_name: 'Operator Alpha',
  auth_method: 'operator_session',
  session_id: 'session-alpha',
};

function activity(overrides: Record<string, unknown> = {}) {
  return {
    activity_id: 'mission-a:activity:event-a',
    event_id: 'activity:event-a',
    event_type: 'stage.needs_human',
    category: 'intervention',
    severity: 'attention',
    source: 'workflow_child',
    source_id: 'child-a',
    title: 'Stage needs human intervention',
    detail: 'Provider timed out',
    reason_code: 'provider_timeout',
    at: '2026-07-23T23:40:00.000Z',
    mission: { mission_id: 'mission-a', title: 'Mission A', state: 'needs_human' },
    workflow_id: 'workflow-a',
    child_id: 'child-a',
    stage_key: '1:implementation',
    owner_agent: 'professor',
    state: 'needs_human',
    input_sha: 'a'.repeat(40),
    output_sha: null,
    links: {
      mission: '/missions/mission-a',
      stage: '/missions/mission-a#stage-1-implementation',
      agent: '/agents/professor',
      workflow: '/missions/mission-a#workflow-summary',
    },
    ...overrides,
  };
}

function deps(root: string) {
  return {
    notificationStateDir: join(root, 'notification-state'),
    idempotencyDir: join(root, 'idempotency'),
    auditDir: join(root, 'audit'),
    missionsDir: join(root, 'missions'),
    workflowRunsDir: join(root, 'workflows'),
    workflowEffectsDir: join(root, 'effects'),
    workspaceRecordsDir: join(root, 'workspaces'),
  };
}

test('notification classification covers required actionable event families', () => {
  assert.equal(classifyActivityNotification(activity({ event_type: 'mission.completed', category: 'mission', severity: 'success', state: 'completed' })), 'mission_completed');
  assert.equal(classifyActivityNotification(activity({ event_type: 'review.approved', category: 'review', severity: 'success' })), 'review_approved');
  assert.equal(classifyActivityNotification(activity({ event_type: 'review.changes.requested', title: 'Berlin requested changes' })), 'review_changes_requested');
  assert.equal(classifyActivityNotification(activity({ reason_code: 'maximum_iteration_reached' })), 'retry_budget_exhausted');
  assert.equal(classifyActivityNotification(activity({ source: 'provider_effect', event_type: 'effect.failed', severity: 'error', detail: 'Provider failed', reason_code: 'provider_failed' })), 'provider_failure');
  assert.equal(classifyActivityNotification(activity({ source: 'provider_effect', event_type: 'effect.needs.human', detail: 'Provider timed out' })), 'provider_timeout');
  assert.equal(classifyActivityNotification(activity({ reason_code: 'agent_unavailable' })), 'agent_unavailable');
  assert.equal(classifyActivityNotification(activity({ event_type: 'workspace.failed', reason_code: 'workspace_cleanup_failed' })), 'workspace_cleanup_failure');
  assert.equal(classifyActivityNotification(activity({ reason_code: 'approval_required' })), 'approval_required');
});

test('notification projection is stable, bounded, and transcript free', () => {
  const first = projectActivityNotification(activity());
  const second = projectActivityNotification(activity());
  const unsafe = projectActivityNotification(activity({ links: { mission: 'https://evil.example', stage: '//evil.example' } }));
  assert.ok(first);
  assert.equal(first?.notification_id, second?.notification_id);
  assert.match(first!.notification_id, /^notification:[a-f0-9]{40}$/);
  assert.equal(first?.activity_id, 'mission-a:activity:event-a');
  assert.equal(first?.links.stage, '/missions/mission-a#stage-1-implementation');
  assert.equal(unsafe?.links.mission, null);
  assert.equal(unsafe?.links.stage, null);
  assert.equal('provider_output' in first!, false);
  assert.equal('transcript' in first!, false);
  assert.equal('environment' in first!, false);
});

test('inbox derives notifications from durable activity and isolates operator state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ops-room-notification-inbox-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const activityBuilder = async () => ({
    events: [
      activity(),
      activity({ activity_id: 'mission-a:activity:info', event_id: 'activity:info', event_type: 'stage.activated', severity: 'info', category: 'stage', state: 'active' }),
    ],
    sources: { missions: 'available', mission_rooms: 'available' },
  });
  const alpha = await buildOperatorNotificationInbox({ actor, ...deps(root), activityBuilder });
  const beta = await buildOperatorNotificationInbox({ actor: { ...actor, actor_id: 'operator-beta' }, ...deps(root), activityBuilder });
  assert.equal(alpha.notifications.length, 1);
  assert.equal(alpha.notifications[0].operator_state.state, 'unread');
  assert.equal(beta.notifications[0].operator_state.state, 'unread');
  assert.equal(alpha.summary.unread, 1);
});

test('mark-read is idempotent across repeated delivery and creates one accepted audit event', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ops-room-notification-action-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let lookups = 0;
  const notification = {
    ...projectActivityNotification(activity()),
    operator_state: { state: 'unread', read_at: null, acknowledged_at: null, acknowledgement_reason: null },
  };
  const input = {
    notificationId: notification.notification_id,
    body: { idempotency_key: 'notification-read-0001' },
    actor,
    ...deps(root),
    findNotification: async () => {
      lookups += 1;
      return notification;
    },
    now: () => '2026-07-23T23:50:00.000Z',
  };
  const first = await handleMarkNotificationRead(input);
  const replay = await handleMarkNotificationRead(input);
  assert.equal(first.status, 200);
  assert.equal(first.body.notification.operator_state.state, 'read');
  assert.equal(first.body.idempotent_replay, false);
  assert.equal(replay.body.idempotent_replay, true);
  assert.equal(replay.body.audit_event_id, first.body.audit_event_id);
  assert.equal(lookups, 1);
  const auditFiles = (await readdir(join(root, 'audit'))).filter((name) => name.endsWith('.json'));
  assert.equal(auditFiles.length, 1);
});

test('acknowledgement requires a reason and changed payload under one key fails closed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ops-room-notification-ack-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const notification = {
    ...projectActivityNotification(activity()),
    operator_state: { state: 'unread', read_at: null, acknowledged_at: null, acknowledgement_reason: null },
  };
  const common = {
    notificationId: notification.notification_id,
    actor,
    ...deps(root),
    findNotification: async () => notification,
    now: () => '2026-07-23T23:51:00.000Z',
  };
  const missingReason = await handleAcknowledgeNotification({
    ...common,
    body: { idempotency_key: 'notification-ack-0001', reason: '' },
  });
  assert.equal(missingReason.status, 400);
  assert.equal(missingReason.body.error_code, 'notification_acknowledgement_reason_required');

  const accepted = await handleAcknowledgeNotification({
    ...common,
    body: { idempotency_key: 'notification-ack-0002', reason: 'Investigating now' },
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.notification.operator_state.state, 'acknowledged');

  const conflict = await handleAcknowledgeNotification({
    ...common,
    body: { idempotency_key: 'notification-ack-0002', reason: 'Different reason' },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error_code, 'notification_idempotency_conflict');
});
