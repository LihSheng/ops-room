import { appendAuditEvent } from '../services/audit-log.js';
import {
  executeIdempotent,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  validateIdempotencyKey,
} from '../services/idempotency-store.js';
import {
  pauseTask,
  readTask,
  requestCancellation,
  resumeTask,
  retryTask,
} from '../services/review-task-store.js';

const SAFE_TASK_ID = /^[A-Za-z0-9._:-]+$/;
const taskActionLocks = new Map<string, Promise<void>>();

const ACTIONS = {
  cancel: {
    operation: 'task.cancel',
    dispatch: false,
    mutate: ({ reviewTasksDir, taskId, actor, reason }) => requestCancellation({
      dir: reviewTasksDir,
      id: taskId,
      actor: actor.actor_id,
      reason,
    }),
  },
  retry: {
    operation: 'task.retry',
    dispatch: true,
    mutate: ({ reviewTasksDir, taskId, actor, reason }) => retryTask({
      dir: reviewTasksDir,
      id: taskId,
      actor: actor.actor_id,
      reason,
    }),
  },
  pause: {
    operation: 'task.pause',
    dispatch: false,
    mutate: ({ reviewTasksDir, taskId, actor, reason }) => pauseTask({
      dir: reviewTasksDir,
      id: taskId,
      actor: actor.actor_id,
      reason,
    }),
  },
  resume: {
    operation: 'task.resume',
    dispatch: true,
    mutate: ({ reviewTasksDir, taskId, actor, reason }) => resumeTask({
      dir: reviewTasksDir,
      id: taskId,
      actor: actor.actor_id,
      reason,
    }),
  },
} as const;

export type OperatorTaskAction = keyof typeof ACTIONS;

function reasonFrom(body) {
  const reason = String(body?.reason || '').trim();
  if (!reason || reason.length > 500) throw new Error('reason is required and must not exceed 500 characters');
  return reason;
}

async function withTaskActionLock<T>(taskId: string, execute: () => Promise<T>): Promise<T> {
  const previous = taskActionLocks.get(taskId) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => gate);
  taskActionLocks.set(taskId, queued);
  await previous;
  try {
    return await execute();
  } finally {
    release();
    if (taskActionLocks.get(taskId) === queued) taskActionLocks.delete(taskId);
  }
}

function transitionErrorCode(error) {
  const message = String(error?.message || '');
  if (/retry budget exhausted/i.test(message)) return 'retry_budget_exhausted';
  return 'invalid_transition';
}

async function rejected({
  auditDir,
  actor,
  operation,
  taskId,
  reason,
  idempotencyKey,
  errorCode,
  status,
  message,
  previousState = null,
}) {
  const event = await appendAuditEvent({
    dir: auditDir,
    operation,
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
    dispatch: false,
  };
}

export async function handleOperatorTaskAction({
  action,
  taskId,
  body,
  actor,
  reviewTasksDir,
  auditDir,
  idempotencyDir,
}: {
  action: OperatorTaskAction;
  taskId: string;
  body: unknown;
  actor: Record<string, string>;
  reviewTasksDir: string;
  auditDir: string;
  idempotencyDir: string;
}) {
  const definition = ACTIONS[action];
  const rawTaskId = String(taskId || '');
  let reason = String((body as any)?.reason || '').trim().slice(0, 500);
  let idempotencyKey = (body as any)?.idempotency_key ? String((body as any).idempotency_key).trim() : null;

  if (!definition) {
    return rejected({
      auditDir,
      actor,
      operation: 'task.unknown',
      taskId: rawTaskId,
      reason,
      idempotencyKey,
      errorCode: 'invalid_action',
      status: 400,
      message: 'Invalid task action',
    });
  }

  if (!SAFE_TASK_ID.test(rawTaskId)) {
    return rejected({
      auditDir,
      actor,
      operation: definition.operation,
      taskId: rawTaskId,
      reason,
      idempotencyKey,
      errorCode: 'invalid_task_id',
      status: 400,
      message: 'Invalid task ID',
    });
  }

  try {
    reason = reasonFrom(body);
    idempotencyKey = validateIdempotencyKey((body as any)?.idempotency_key);
  } catch (error) {
    return rejected({
      auditDir,
      actor,
      operation: definition.operation,
      taskId: rawTaskId,
      reason,
      idempotencyKey,
      errorCode: 'invalid_request',
      status: 400,
      message: error.message,
    });
  }

  try {
    const result = await executeIdempotent({
      dir: idempotencyDir,
      actorId: actor.actor_id,
      operation: definition.operation,
      targetId: rawTaskId,
      key: idempotencyKey,
      payload: { reason },
      execute: () => withTaskActionLock(rawTaskId, async () => {
        const current = await readTask({ dir: reviewTasksDir, id: rawTaskId });
        if (!current) {
          return rejected({
            auditDir,
            actor,
            operation: definition.operation,
            taskId: rawTaskId,
            reason,
            idempotencyKey,
            errorCode: 'task_not_found',
            status: 404,
            message: 'Review task not found',
          });
        }

        try {
          const task = await definition.mutate({
            reviewTasksDir,
            taskId: rawTaskId,
            actor,
            reason,
          });
          const event = await appendAuditEvent({
            dir: auditDir,
            operation: definition.operation,
            actor,
            target: { type: 'review_task', id: rawTaskId },
            reason,
            idempotencyKey,
            previousState: current.state,
            resultingState: task.state,
            outcome: 'accepted',
            metadata: {
              task_kind: task.kind || 'review',
              attempt: Number(task.attempt || 0),
              dispatch_requested: definition.dispatch,
            },
          });
          return {
            status: 202,
            body: {
              operation: definition.operation,
              task: {
                id: task.id,
                kind: task.kind || 'review',
                state: task.state,
                attempt: Number(task.attempt || 0),
              },
              audit_event_id: event.event_id,
            },
            dispatch: definition.dispatch,
          };
        } catch (error) {
          return rejected({
            auditDir,
            actor,
            operation: definition.operation,
            taskId: rawTaskId,
            reason,
            idempotencyKey,
            errorCode: transitionErrorCode(error),
            status: 409,
            message: error?.message || `${action} cannot be requested from the current state`,
            previousState: current.state,
          });
        }
      }),
    });

    return {
      status: result.response.status,
      body: { ...result.response.body, idempotent_replay: result.replayed },
      dispatch: !result.replayed && result.response.dispatch === true,
    };
  } catch (error) {
    if (error instanceof IdempotencyConflictError || error instanceof IdempotencyInProgressError) {
      const current = await readTask({ dir: reviewTasksDir, id: rawTaskId });
      return rejected({
        auditDir,
        actor,
        operation: definition.operation,
        taskId: rawTaskId,
        reason,
        idempotencyKey,
        errorCode: error.code,
        status: 409,
        message: error.message,
        previousState: current?.state || null,
      });
    }
    throw error;
  }
}

export function handleOperatorTaskCancellation(input) {
  return handleOperatorTaskAction({ ...input, action: 'cancel' });
}

export function handleOperatorTaskRetry(input) {
  return handleOperatorTaskAction({ ...input, action: 'retry' });
}

export function handleOperatorTaskPause(input) {
  return handleOperatorTaskAction({ ...input, action: 'pause' });
}

export function handleOperatorTaskResume(input) {
  return handleOperatorTaskAction({ ...input, action: 'resume' });
}
