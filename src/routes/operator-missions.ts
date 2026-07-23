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
import { startMissionWorkflow } from '../services/mission-workflow-start.js';
import {
  AUDIT_DIR,
  IDEMPOTENCY_DIR,
  MISSIONS_DIR,
  WORKFLOW_RUNS_DIR,
} from '../services/runtime-paths.js';
import { authorizeOperatorRequest } from '../services/operator-request-auth.js';
import { parseBody, sendJSON } from './helpers.js';
import { registerRouteExtension, type RouteEntry } from '../lib/router.js';

const SAFE_MISSION_ID = /^[A-Za-z0-9._:-]{1,180}$/;

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

async function startRejected({
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
    operation: 'mission.start',
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

function deterministicStartFailure(error: any) {
  const message = String(error?.message || 'mission_start_failed');
  if (error?.code === 'ENOENT') {
    return { status: 404, code: 'mission_not_found', message: 'Mission not found' };
  }
  if (message === 'invalid_mission_id') {
    return { status: 400, code: 'invalid_mission_id', message: 'Invalid mission ID' };
  }
  if (message.startsWith('mission_not_startable:')) {
    return { status: 409, code: 'mission_not_startable', message: 'Mission is not in a startable state' };
  }
  const conflictCodes = new Set([
    'mission_workflow_binding_conflict',
    'mission_workflow_state_conflict',
    'mission_active_workflow_binding_missing',
    'mission_bound_workflow_unavailable',
    'mission_workflow_repository_mismatch',
    'mission_workflow_source_sha_mismatch',
    'mission_workflow_type_mismatch',
    'mission_workflow_iteration_policy_mismatch',
    'mission_workflow_concurrency_policy_mismatch',
    'mission_workflow_initial_child_unavailable',
    'mission_workflow_initial_child_stage_mismatch',
    'mission_workflow_initial_child_owner_mismatch',
    'mission_workflow_initial_child_iteration_mismatch',
    'mission_workflow_initial_child_dependency_mismatch',
    'mission_workflow_initial_child_sha_mismatch',
    'mission_workflow_initial_child_not_persisted',
    'mission_workflow_id_mismatch',
    'workflow_run_conflict',
    'workflow_child_conflict',
  ]);
  if (conflictCodes.has(message)) {
    return { status: 409, code: message, message: 'Mission workflow evidence conflicts with the requested start' };
  }
  return null;
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

export async function handleStartMission({
  missionId,
  body,
  actor,
  missionsDir,
  workflowRunsDir,
  auditDir,
  idempotencyDir,
}: {
  missionId: string;
  body: any;
  actor: Record<string, any>;
  missionsDir: string;
  workflowRunsDir: string;
  auditDir: string;
  idempotencyDir: string;
}) {
  let reason = String(body?.reason || '').trim().slice(0, 500);
  let idempotencyKey = body?.idempotency_key ? String(body.idempotency_key).trim() : null;
  const normalizedMissionId = String(missionId || '').trim();

  try {
    if (!SAFE_MISSION_ID.test(normalizedMissionId)) throw new Error('invalid_mission_id');
    reason = reasonFrom(body);
    idempotencyKey = validateIdempotencyKey(body?.idempotency_key);
  } catch (error: any) {
    return startRejected({
      auditDir,
      actor,
      missionId: normalizedMissionId || 'mission-request',
      reason,
      idempotencyKey,
      errorCode: 'invalid_request',
      status: 400,
      message: error?.message || 'Invalid mission start request',
    });
  }

  try {
    const result = await executeIdempotent({
      dir: idempotencyDir,
      actorId: actor.actor_id,
      operation: 'mission.start',
      targetId: normalizedMissionId,
      key: idempotencyKey,
      payload: { reason },
      execute: async () => {
        try {
          const started = await startMissionWorkflow({
            missionsDir,
            workflowRunsDir,
            missionId: normalizedMissionId,
            actor,
          });
          const event = await appendAuditEvent({
            dir: auditDir,
            operation: 'mission.start',
            actor,
            target: { type: 'mission', id: normalizedMissionId },
            reason,
            idempotencyKey,
            previousState: started.started ? 'planned' : 'active',
            resultingState: 'active',
            outcome: 'accepted',
            metadata: {
              workflow_id: started.workflow.workflow_id,
              child_id: started.child.child_id,
              workflow_created: started.workflow_created,
              child_created: started.child_created,
              mission_bound: started.started,
              provider_invoked: false,
            },
          });
          return {
            status: 200,
            body: {
              operation: 'mission.start',
              mission: started.mission,
              workflow: started.workflow,
              initial_child: started.child,
              started: started.started,
              provider_invoked: false,
              audit_event_id: event.event_id,
            },
          };
        } catch (error: any) {
          const failure = deterministicStartFailure(error);
          if (!failure) throw error;
          return startRejected({
            auditDir,
            actor,
            missionId: normalizedMissionId,
            reason,
            idempotencyKey,
            errorCode: failure.code,
            status: failure.status,
            message: failure.message,
          });
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
      return startRejected({
        auditDir,
        actor,
        missionId: normalizedMissionId,
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

const missionStartRoute: RouteEntry = {
  method: 'POST',
  match: (pathname) => {
    const match = pathname.match(/^\/api\/operator\/missions\/([A-Za-z0-9._:-]+)\/start$/);
    return match ? { missionId: match[1] } : null;
  },
  handler: async (req, res, params) => {
    const authorization = await authorizeOperatorRequest({
      req,
      permission: 'mission.start',
    });
    if (!authorization.ok) {
      sendJSON(res, authorization.status, {
        error: authorization.error,
        error_code: authorization.error_code,
      });
      return;
    }

    const body = await parseBody(req);
    const result = await handleStartMission({
      missionId: params.missionId,
      body,
      actor: authorization.actor,
      missionsDir: MISSIONS_DIR,
      workflowRunsDir: WORKFLOW_RUNS_DIR,
      auditDir: AUDIT_DIR,
      idempotencyDir: IDEMPOTENCY_DIR,
    });
    sendJSON(res, result.status, result.body);
  },
};

registerRouteExtension(missionStartRoute);
