import { appendAuditEvent } from '../services/audit-log.js';
import {
  executeIdempotent,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  validateIdempotencyKey,
} from '../services/idempotency-store.js';
import { readTask, requestCancellation } from '../services/review-task-store.js';

const SAFE_TASK_ID = /^[A-Za-z0-9._:-]+$/;
const OPERATION = 'task.cancel';

function reasonFrom(body) {
  const reason = String(body?.reason || '').trim();
  if (!reason || reason.length > 500) throw new Error('reason is required and must not exceed 500 characters');
  return reason;
}

async function rejected({ auditDir, actor, taskId, reason, idempotencyKey, errorCode, status, message, previousState = null }) {
  const event = await appendAuditEvent({
    dir: auditDir,
    operation: OPERATION,
    actor,
    target: { type: 'review_task', id: String(taskId || '').slice(0, 300) },
    reason,
    idempotencyKey,
    previousState,
    resultingState: previousState,
    outcome: 'rejected',
    errorCode,
  });
  return {
    status,
    body: {
      error: message,
      error_code: errorCode,
      audit_event_id: event.event_id,
    },
  };
}

export async function handleOperatorTaskCancellation({
  taskId,
  body,
  actor,
  reviewTasksDir,
  auditDir,
  idempotencyDir,
}) {
  const rawTaskId = String(taskId || '');
  let reason = String(body?.reason || '').trim().slice(0, 500);
  let idempotencyKey = body?.idempotency_key ? String(body.idempotency_key).trim() : null;

  if (!SAFE_TASK_ID.test(rawTaskId)) {
    return rejected({
      auditDir, actor, taskId: rawTaskId, reason, idempotencyKey,
      errorCode: 'invalid_task_id', status: 400, message: 'Invalid task ID',
    });
  }

  try {
    reason = reasonFrom(body);
    idempotencyKey = validateIdempotencyKey(body?.idempotency_key);
  } catch (error) {
    return rejected({
      auditDir, actor, taskId: rawTaskId, reason, idempotencyKey,
      errorCode: 'invalid_request', status: 400, message: error.message,
    });
  }

  try {
    const result = await executeIdempotent({
      dir: idempotencyDir,
      actorId: actor.actor_id,
      operation: OPERATION,
      targetId: rawTaskId,
      key: idempotencyKey,
      payload: { reason },
      execute: async () => {
        const current = await readTask({ dir: reviewTasksDir, id: rawTaskId });
        if (!current) {
          return rejected({
            auditDir, actor, taskId: rawTaskId, reason, idempotencyKey,
            errorCode: 'task_not_found', status: 404, message: 'Review task not found',
          });
        }

        try {
          const task = await requestCancellation({
            dir: reviewTasksDir,
            id: rawTaskId,
            actor: actor.actor_id,
            reason,
          });
          const event = await appendAuditEvent({
            dir: auditDir,
            operation: OPERATION,
            actor,
            target: { type: 'review_task', id: rawTaskId },
            reason,
            idempotencyKey,
            previousState: current.state,
            resultingState: task.state,
            outcome: 'accepted',
          });
          return {
            status: 202,
            body: {
              operation: OPERATION,
              task: { id: task.id, state: task.state },
              audit_event_id: event.event_id,
            },
          };
        } catch (error) {
          return rejected({
            auditDir, actor, taskId: rawTaskId, reason, idempotencyKey,
            errorCode: 'invalid_transition', status: 409,
            message: error?.message || 'Cancellation cannot be requested from the current state',
            previousState: current.state,
          });
        }
      },
    });

    return {
      status: result.response.status,
      body: { ...result.response.body, idempotent_replay: result.replayed },
    };
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      return { status: 409, body: { error: error.message, error_code: error.code } };
    }
    if (error instanceof IdempotencyInProgressError) {
      return { status: 409, body: { error: error.message, error_code: error.code } };
    }
    throw error;
  }
}
