import { appendAuditEvent } from '../services/audit-log.js';
import {
  executeIdempotent,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  validateIdempotencyKey,
} from '../services/idempotency-store.js';
import {
  buildMissionId,
  createMission,
  normalizeMissionInput,
  serializeMission,
} from '../services/mission-store.js';

function reasonFrom(body: any) {
  const reason = String(body?.reason || '').trim();
  if (!reason || reason.length > 500) {
    throw new Error('reason is required and must not exceed 500 characters');
  }
  return reason;
}

async function rejected({
  auditDir,
  actor,
  missionId,
  reason,
  idempotencyKey,
  errorCode,
  status,
  message,
}: {
  auditDir: string;
  actor: Record<string, any>;
  missionId: string;
  reason: string;
  idempotencyKey: string | null;
  errorCode: string;
  status: number;
  message: string;
}) {
  const event = await appendAuditEvent({
    dir: auditDir,
    operation: 'mission.create',
    actor,
    target: { type: 'mission', id: missionId.slice(0, 300) || 'mission-request' },
    reason,
    idempotencyKey,
    previousState: null,
    resultingState: null,
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

export async function handleCreateMission({
  body,
  actor,
  missionsDir,
  auditDir,
  idempotencyDir,
}: {
  body: any;
  actor: Record<string, any>;
  missionsDir: string;
  auditDir: string;
  idempotencyDir: string;
}) {
  let reason = String(body?.reason || '').trim().slice(0, 500);
  let idempotencyKey = body?.idempotency_key ? String(body.idempotency_key).trim() : null;
  let normalized: ReturnType<typeof normalizeMissionInput>;
  let missionId = 'mission-request';

  try {
    reason = reasonFrom(body);
    idempotencyKey = validateIdempotencyKey(body?.idempotency_key);
    normalized = normalizeMissionInput(body);
    missionId = buildMissionId({
      repository: normalized.repository_id,
      title: normalized.title,
      requestKey: idempotencyKey,
    });
  } catch (error: any) {
    return rejected({
      auditDir,
      actor,
      missionId,
      reason,
      idempotencyKey,
      errorCode: 'invalid_request',
      status: 400,
      message: error?.message || 'Invalid mission creation request',
    });
  }

  try {
    const result = await executeIdempotent({
      dir: idempotencyDir,
      actorId: actor.actor_id,
      operation: 'mission.create',
      targetId: missionId,
      key: idempotencyKey,
      payload: { mission: normalized, reason },
      execute: async () => {
        try {
          const created = await createMission({
            dir: missionsDir,
            input: normalized,
            actor,
            requestKey: idempotencyKey as string,
          });
          const event = await appendAuditEvent({
            dir: auditDir,
            operation: 'mission.create',
            actor,
            target: { type: 'mission', id: created.mission.mission_id },
            reason,
            idempotencyKey,
            previousState: null,
            resultingState: created.mission.state,
            outcome: 'accepted',
            metadata: {
              repository_id: created.mission.repository_id,
              workflow_type: created.mission.workflow_type,
              max_iterations: created.mission.policy.max_iterations,
              approval_policy: created.mission.policy.approval_policy,
              record_created: created.created,
              workflow_started: false,
            },
          });
          return {
            status: 201,
            body: {
              operation: 'mission.create',
              mission: serializeMission(created.mission),
              audit_event_id: event.event_id,
            },
          };
        } catch (error: any) {
          if (error?.message === 'mission_record_conflict') {
            return rejected({
              auditDir,
              actor,
              missionId,
              reason,
              idempotencyKey,
              errorCode: 'mission_record_conflict',
              status: 409,
              message: 'Mission request conflicts with an existing durable record',
            });
          }
          throw error;
        }
      },
    });

    return {
      status: result.response.status,
      body: {
        ...result.response.body,
        idempotent_replay: result.replayed,
      },
    };
  } catch (error: any) {
    if (error instanceof IdempotencyConflictError || error instanceof IdempotencyInProgressError) {
      return rejected({
        auditDir,
        actor,
        missionId,
        reason,
        idempotencyKey,
        errorCode: error.code,
        status: 409,
        message: error.message,
      });
    }
    throw error;
  }
}
