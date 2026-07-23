import { createHash } from 'node:crypto';

import { appendAuditEvent } from './audit-log.js';
import { buildActivityEventIndex } from './activity-event-index.js';
import {
  executeIdempotent,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  validateIdempotencyKey,
} from './idempotency-store.js';
import {
  acknowledgeOperatorNotification,
  markOperatorNotificationRead,
  notificationStateFor,
  readOperatorNotificationState,
} from './notification-state-store.js';

const SAFE_NOTIFICATION_ID = /^notification:[a-f0-9]{40}$/;
const NOTIFICATION_STATES = new Set(['all', 'unread', 'read', 'acknowledged']);
const NOTIFICATION_TYPES = new Set([
  'mission_completed',
  'review_approved',
  'review_changes_requested',
  'workflow_needs_human',
  'provider_timeout',
  'provider_failure',
  'retry_budget_exhausted',
  'agent_unavailable',
  'workspace_cleanup_failure',
  'approval_required',
  'attention_required',
]);

function digest(value: unknown) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function bounded(value: unknown, maximum: number) {
  return String(value ?? '').trim().slice(0, maximum);
}

function actorIdFrom(actor: any) {
  const actorId = bounded(actor?.actor_id, 100);
  if (!actorId || /[\u0000-\u001f\u007f]/.test(actorId)) throw new Error('notification_actor_id_invalid');
  return actorId;
}

function validateNotificationId(value: unknown) {
  const notificationId = bounded(value, 80);
  if (!SAFE_NOTIFICATION_ID.test(notificationId)) throw new Error('notification_id_invalid');
  return notificationId;
}

function notificationIdFor(activityId: unknown) {
  const activity = bounded(activityId, 420);
  if (!activity) throw new Error('notification_activity_id_invalid');
  return `notification:${digest(`ops-room.notification.v1:${activity}`).slice(0, 40)}`;
}

function lower(value: unknown) {
  return String(value || '').trim().toLowerCase();
}

function includesAny(value: string, candidates: string[]) {
  return candidates.some((candidate) => value.includes(candidate));
}

export function classifyActivityNotification(event: any) {
  const eventType = lower(event?.event_type);
  const state = lower(event?.state);
  const reason = lower(event?.reason_code);
  const title = lower(event?.title);
  const detail = lower(event?.detail);
  const combined = `${eventType} ${state} ${reason} ${title} ${detail}`;

  if (eventType === 'mission.completed' || (event?.category === 'mission' && state === 'completed' && event?.severity === 'success')) {
    return 'mission_completed';
  }
  if (eventType === 'review.approved') return 'review_approved';
  if (eventType === 'review.changes.requested' || includesAny(combined, ['berlin requested changes', 'changes_requested'])) {
    return 'review_changes_requested';
  }
  if (includesAny(combined, ['retry budget exhausted', 'maximum iteration', 'max iteration', 'iteration budget'])) {
    return 'retry_budget_exhausted';
  }
  if (includesAny(combined, ['agent unavailable', 'agent_unavailable', 'runtime unavailable'])) {
    return 'agent_unavailable';
  }
  if (includesAny(combined, ['cleanup failure', 'cleanup_failed', 'workspace cleanup']) && includesAny(combined, ['fail', 'error', 'needs_human'])) {
    return 'workspace_cleanup_failure';
  }
  if (includesAny(combined, ['approval required', 'approval_required', 'awaiting approval'])) {
    return 'approval_required';
  }
  if (event?.source === 'provider_effect' && includesAny(combined, ['timeout', 'timed out'])) {
    return 'provider_timeout';
  }
  if (event?.source === 'provider_effect' && (eventType === 'effect.failed' || event?.severity === 'error')) {
    return 'provider_failure';
  }
  if (eventType.includes('needs.human') || eventType.includes('needs_human') || state === 'needs_human') {
    return 'workflow_needs_human';
  }
  if (['attention', 'error'].includes(String(event?.severity || ''))) return 'attention_required';
  return null;
}

function notificationPriority(severity: unknown) {
  if (severity === 'error') return 'critical';
  if (severity === 'attention') return 'high';
  if (severity === 'warning') return 'normal';
  return 'low';
}

export function projectActivityNotification(event: any) {
  const notificationType = classifyActivityNotification(event);
  if (!notificationType) return null;
  const activityId = bounded(event?.activity_id, 420);
  if (!activityId) throw new Error('notification_activity_id_invalid');
  return {
    notification_id: notificationIdFor(activityId),
    activity_id: activityId,
    notification_type: notificationType,
    priority: notificationPriority(event?.severity),
    title: bounded(event?.title, 220) || 'Ops Room notification',
    detail: bounded(event?.detail, 500) || null,
    severity: bounded(event?.severity, 40) || 'warning',
    category: bounded(event?.category, 80) || 'intervention',
    reason_code: bounded(event?.reason_code, 160) || null,
    at: bounded(event?.at, 64),
    mission: {
      mission_id: bounded(event?.mission?.mission_id, 180),
      title: bounded(event?.mission?.title, 180) || 'Mission',
      state: bounded(event?.mission?.state, 80) || null,
    },
    workflow_id: bounded(event?.workflow_id, 180) || null,
    child_id: bounded(event?.child_id, 220) || null,
    stage_key: bounded(event?.stage_key, 220) || null,
    owner_agent: bounded(event?.owner_agent, 120) || null,
    state: bounded(event?.state, 100) || null,
    input_sha: bounded(event?.input_sha, 64) || null,
    output_sha: bounded(event?.output_sha, 64) || null,
    links: {
      mission: bounded(event?.links?.mission, 500) || null,
      stage: bounded(event?.links?.stage, 500) || null,
      agent: bounded(event?.links?.agent, 500) || null,
      workflow: bounded(event?.links?.workflow, 500) || null,
      activity: '/activity',
    },
  };
}

function boundedLimit(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 100;
  return Math.max(1, Math.min(Math.trunc(parsed), 500));
}

function normalizeFilters(filters: any = {}) {
  const state = lower(filters.state || 'all');
  if (!NOTIFICATION_STATES.has(state)) throw new Error('notification_state_filter_invalid');
  const notificationType = lower(filters.notificationType);
  if (notificationType && !NOTIFICATION_TYPES.has(notificationType)) throw new Error('notification_type_filter_invalid');
  const missionId = bounded(filters.missionId, 180) || null;
  return {
    state,
    notificationType: notificationType || null,
    missionId,
    limit: boundedLimit(filters.limit),
  };
}

export async function buildOperatorNotificationInbox({
  actor,
  notificationStateDir,
  missionsDir,
  workflowRunsDir,
  workflowEffectsDir,
  workspaceRecordsDir,
  filters = {},
  activityBuilder = buildActivityEventIndex,
  stateReader = readOperatorNotificationState,
  now = () => new Date().toISOString(),
}: any) {
  const actorId = actorIdFrom(actor);
  const normalizedFilters = normalizeFilters(filters);
  const [activity, stateRecord] = await Promise.all([
    activityBuilder({
      missionsDir,
      workflowRunsDir,
      workflowEffectsDir,
      workspaceRecordsDir,
      filters: { limit: 500 },
      now,
    }),
    stateReader({ dir: notificationStateDir, actorId, now }),
  ]);

  const notifications = activity.events
    .map(projectActivityNotification)
    .filter(Boolean)
    .map((notification: any) => ({
      ...notification,
      operator_state: notificationStateFor(stateRecord, notification.notification_id),
    }))
    .filter((notification: any) => {
      if (normalizedFilters.state !== 'all' && notification.operator_state.state !== normalizedFilters.state) return false;
      if (normalizedFilters.notificationType && notification.notification_type !== normalizedFilters.notificationType) return false;
      if (normalizedFilters.missionId && notification.mission.mission_id !== normalizedFilters.missionId) return false;
      return true;
    });

  const limited = notifications.slice(0, normalizedFilters.limit);
  return {
    notifications: limited,
    count: limited.length,
    total_matching: notifications.length,
    summary: {
      total: notifications.length,
      unread: notifications.filter((notification: any) => notification.operator_state.state === 'unread').length,
      read: notifications.filter((notification: any) => notification.operator_state.state === 'read').length,
      acknowledged: notifications.filter((notification: any) => notification.operator_state.state === 'acknowledged').length,
      critical: notifications.filter((notification: any) => notification.priority === 'critical').length,
      latest_at: notifications[0]?.at || null,
    },
    sources: {
      activity: activity.sources,
      operator_state: 'available',
    },
    generated_at: now(),
  };
}

export async function findOperatorNotification({ notificationId, ...deps }: any) {
  const normalizedId = validateNotificationId(notificationId);
  const inbox = await buildOperatorNotificationInbox({ ...deps, filters: { limit: 500 } });
  return inbox.notifications.find((notification: any) => notification.notification_id === normalizedId) || null;
}

function actionFailure(error: any) {
  if (error instanceof IdempotencyConflictError) {
    return { status: 409, code: 'notification_idempotency_conflict', message: 'Idempotency key conflicts with a different notification request' };
  }
  if (error instanceof IdempotencyInProgressError) {
    return { status: 409, code: 'notification_request_in_progress', message: 'An identical notification request is still in progress' };
  }
  const raw = lower(error?.message);
  if (raw === 'notification_not_found') return { status: 404, code: raw, message: 'Notification not found' };
  if (raw.includes('required') || raw.includes('invalid') || raw.startsWith('idempotency_key')) {
    return { status: 400, code: raw.startsWith('idempotency_key') ? 'notification_idempotency_key_invalid' : raw, message: raw.replaceAll('_', ' ') };
  }
  if (raw.includes('capacity') || raw.includes('conflict') || raw.includes('lock_timeout')) {
    return { status: 409, code: raw || 'notification_state_conflict', message: 'Notification state could not be updated safely' };
  }
  return { status: 503, code: 'notification_state_unavailable', message: 'Notification state is unavailable' };
}

async function rejectedAction({ auditDir, actor, operation, notificationId, reason, key, error }: any) {
  const failure = actionFailure(error);
  try {
    const audit = await appendAuditEvent({
      dir: auditDir,
      operation,
      actor,
      target: { type: 'operator_notification', id: bounded(notificationId, 80) },
      reason: reason || failure.code,
      idempotencyKey: key || null,
      previousState: null,
      resultingState: null,
      outcome: 'rejected',
      errorCode: failure.code,
      metadata: { notification_id: bounded(notificationId, 80) || null },
    });
    return {
      status: failure.status,
      body: { error: failure.message, error_code: failure.code, audit_event_id: audit.event_id },
    };
  } catch {
    return {
      status: 503,
      body: { error: 'Notification audit is unavailable', error_code: 'notification_audit_unavailable' },
    };
  }
}

async function performNotificationAction({
  action,
  notificationId,
  body,
  actor,
  notificationStateDir,
  idempotencyDir,
  auditDir,
  now = () => new Date().toISOString(),
  findNotification = findOperatorNotification,
  ...activityDeps
}: any) {
  const operation = action === 'acknowledge' ? 'notification.acknowledge' : 'notification.read';
  let key = '';
  let reason = action === 'acknowledge' ? bounded(body?.reason, 500) : 'notification_mark_read';
  try {
    const normalizedId = validateNotificationId(notificationId);
    if (action === 'acknowledge' && !reason) throw new Error('notification_acknowledgement_reason_required');
    key = validateIdempotencyKey(body?.idempotency_key);
    const actorId = actorIdFrom(actor);
    const idempotent = await executeIdempotent({
      dir: idempotencyDir,
      actorId,
      operation,
      targetId: normalizedId,
      key,
      payload: action === 'acknowledge' ? { reason } : {},
      execute: async () => {
        const notification = await findNotification({
          notificationId: normalizedId,
          actor,
          notificationStateDir,
          ...activityDeps,
          now,
        });
        if (!notification) throw new Error('notification_not_found');
        const previousState = notification.operator_state.state;
        const result = action === 'acknowledge'
          ? await acknowledgeOperatorNotification({
              dir: notificationStateDir,
              actorId,
              notificationId: normalizedId,
              activityId: notification.activity_id,
              reason,
              now,
            })
          : await markOperatorNotificationRead({
              dir: notificationStateDir,
              actorId,
              notificationId: normalizedId,
              activityId: notification.activity_id,
              now,
            });
        const operatorState = notificationStateFor(result.record, normalizedId);
        const audit = await appendAuditEvent({
          dir: auditDir,
          operation,
          actor,
          target: { type: 'operator_notification', id: normalizedId },
          reason,
          idempotencyKey: key,
          previousState,
          resultingState: operatorState.state,
          outcome: 'accepted',
          metadata: {
            activity_id: notification.activity_id,
            notification_type: notification.notification_type,
            mission_id: notification.mission.mission_id,
            workflow_id: notification.workflow_id,
            stage_key: notification.stage_key,
            domain_idempotent: result.idempotent,
          },
        });
        return {
          status: 200,
          body: {
            notification: { ...notification, operator_state: operatorState },
            domain_idempotent: result.idempotent,
            audit_event_id: audit.event_id,
          },
        };
      },
    });
    return {
      status: idempotent.response.status,
      body: { ...idempotent.response.body, idempotent_replay: idempotent.replayed },
    };
  } catch (error: any) {
    return rejectedAction({ auditDir, actor, operation, notificationId, reason, key, error });
  }
}

export async function handleMarkNotificationRead(input: any) {
  return performNotificationAction({ ...input, action: 'read' });
}

export async function handleAcknowledgeNotification(input: any) {
  return performNotificationAction({ ...input, action: 'acknowledge' });
}
