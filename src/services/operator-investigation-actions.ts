import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { appendAuditEvent } from './audit-log.js';
import {
  executeIdempotent,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  validateIdempotencyKey,
} from './idempotency-store.js';
import { writeAtomic } from './review-task-store.js';
import { inspectGitWorkspaceHead } from './workflow-provider-recovery.js';
import { readWorkflowEffect, validateWorkflowEffect, listWorkflowEffects } from './workflow-effect-store.js';
import { readWorkflowRun } from './workflow-run-store.js';
import { readWorkspaceRecord, updateWorkspaceRecord } from './workspace-store.js';
import { withWorkspaceLock } from './workspace-locks.js';

const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const SAFE_SHA = /^[0-9a-f]{40}$/i;
const SAFE_RESULT_CODE = /^[a-z0-9][a-z0-9._:-]{0,119}$/;
const EFFECT_RESOLUTIONS = new Set(['safe_to_retry', 'completed']);
const WORKSPACE_ACTIONS = new Set(['hold', 'release', 'cleanup']);
const INSPECTABLE_WORKSPACE_STATES = new Set(['active', 'held_for_investigation']);
const CLEANUP_REQUEST_STATES = new Set(['active', 'failed', 'held_for_investigation']);
const TERMINAL_CHILD_STATES = new Set(['completed', 'cancelled']);
const TERMINAL_WORKFLOW_STATES = new Set(['completed', 'cancelled']);
const DEFAULT_LOCK_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export type OperatorInvestigationAction = 'effect.resolve' | 'workspace.hold' | 'workspace.release' | 'workspace.cleanup';

function bounded(value: unknown, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function validateId(value: unknown, field: string) {
  const normalized = bounded(value, 200);
  if (!SAFE_ID.test(normalized)) throw new Error(`invalid_${field}`);
  return normalized;
}

function reasonFrom(body: any) {
  const reason = bounded(body?.reason, 500);
  if (!reason) throw new Error('reason_required');
  return reason;
}

function expectedAttemptFrom(body: any) {
  const attempt = Number(body?.expected_attempt);
  if (!Number.isInteger(attempt) || attempt < 0 || attempt > 100) {
    throw new Error('expected_attempt_invalid');
  }
  return attempt;
}

function expectedStateFrom(body: any) {
  const state = bounded(body?.expected_state, 80).toLowerCase();
  if (!state) throw new Error('expected_workspace_state_required');
  return state;
}

function workflowDigest(value: string, length = 32) {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function effectPath(dir: string, effectId: string) {
  return join(dir, `effect-${createHash('sha256').update(effectId).digest('hex')}.json`);
}

function safeWorkspacePath(workspaceRoot: string, relativePath: unknown) {
  const root = resolve(workspaceRoot);
  const target = resolve(root, String(relativePath || ''));
  const fromRoot = relative(root, target);
  if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new Error('investigation_workspace_path_invalid');
  }
  return target;
}

function attemptKey(attempt: number) {
  return `attempt:${attempt}`;
}

function childEffectType(child: any) {
  return `provider.${child.owner_agent}.${child.stage}`;
}

function actorId(actor: any) {
  return validateId(actor?.actor_id || actor?.id || 'operator', 'actor_id');
}

function operationFor(action: OperatorInvestigationAction) {
  if (action === 'effect.resolve') return 'workflow.effect.resolve';
  if (action === 'workspace.hold') return 'workflow.workspace.hold';
  if (action === 'workspace.release') return 'workflow.workspace.release';
  return 'workflow.workspace.cleanup_request';
}

async function readExactContext({
  workflowRunsDir,
  workflowId,
  childId,
  expectedAttempt,
  readRun = readWorkflowRun,
}: any) {
  const run = await readRun({ dir: workflowRunsDir, workflowId });
  const child = run.children.find((candidate: any) => candidate.child_id === childId);
  if (!child) throw new Error('workflow_child_not_found');
  if (child.attempt !== expectedAttempt) throw new Error('workflow_investigation_attempt_conflict');
  return { run, child };
}

function validateEffectBinding({ effect, workflowId, child }: any) {
  if (!effect) throw new Error('workflow_effect_not_found');
  if (effect.workflow_id !== workflowId) throw new Error('workflow_effect_workflow_mismatch');
  if (effect.child_id !== child.child_id) throw new Error('workflow_effect_child_mismatch');
  if (effect.effect_type !== childEffectType(child)) throw new Error('workflow_effect_type_mismatch');
  if (effect.idempotency_key !== attemptKey(child.attempt)) throw new Error('workflow_effect_attempt_mismatch');
  return effect;
}

function validateWorkspaceBinding({ record, run, child, workspaceId }: any) {
  if (!child.workspace?.workspace_id) throw new Error('workflow_child_workspace_binding_missing');
  if (!record) throw new Error('workspace_not_found');
  if (record.workspace_id !== workspaceId || record.workspace_id !== child.workspace.workspace_id) {
    throw new Error('workflow_workspace_id_mismatch');
  }
  if (record.task_id !== child.child_id) throw new Error('workflow_workspace_task_mismatch');
  if (record.owner_agent !== child.owner_agent) throw new Error('workflow_workspace_owner_mismatch');
  if (record.repository_id !== run.repository_id) throw new Error('workflow_workspace_repository_mismatch');
  if (record.mode !== child.workspace.mode) throw new Error('workflow_workspace_mode_mismatch');
  if ((record.branch || null) !== (child.workspace.branch || null)) throw new Error('workflow_workspace_branch_mismatch');
  return record;
}

async function inspectWorkspace({
  run,
  child,
  workspaceId,
  workspaceRoot,
  recordRoot,
  readRecord = readWorkspaceRecord,
  inspectHead = inspectGitWorkspaceHead,
}: any) {
  const record = validateWorkspaceBinding({
    record: await readRecord({ dir: recordRoot, workspaceId }),
    run,
    child,
    workspaceId,
  });
  if (!INSPECTABLE_WORKSPACE_STATES.has(record.state)) {
    throw new Error('workflow_workspace_not_inspectable');
  }
  const cwd = safeWorkspacePath(workspaceRoot, record.relative_path);
  const head = String(await inspectHead({ cwd, run, child, workspace: record }) || '').trim().toLowerCase();
  if (!SAFE_SHA.test(head)) throw new Error('workflow_workspace_head_invalid');
  return { record, head };
}

function completedResultCode({ child, body }: any) {
  const resultCode = bounded(body?.result_code, 120).toLowerCase();
  if (!SAFE_RESULT_CODE.test(resultCode)) throw new Error('workflow_effect_result_code_invalid');
  if (child.stage === 'review') {
    if (resultCode !== 'review.approved' && !resultCode.startsWith('review.changes_requested:')) {
      throw new Error('workflow_review_effect_result_invalid');
    }
  } else if (resultCode !== 'ok') {
    throw new Error('workflow_effect_completed_result_invalid');
  }
  return resultCode;
}

async function resolveEffect({
  workflowRunsDir,
  effectsDir,
  workspaceRoot,
  recordRoot,
  workflowId,
  childId,
  effectId,
  expectedAttempt,
  body,
  now,
}: any) {
  const resolution = bounded(body?.resolution, 80).toLowerCase();
  if (!EFFECT_RESOLUTIONS.has(resolution)) throw new Error('workflow_effect_resolution_invalid');
  const { run, child } = await readExactContext({ workflowRunsDir, workflowId, childId, expectedAttempt });
  const effect = validateEffectBinding({
    effect: await readWorkflowEffect({ dir: effectsDir, effectId }),
    workflowId,
    child,
  });
  if (effect.state !== 'needs_human') {
    throw new Error(effect.state === 'claimed'
      ? 'workflow_effect_still_claimed'
      : 'workflow_effect_resolution_not_required');
  }
  const workspaceId = validateId(child.workspace?.workspace_id, 'workspace_id');
  const workspace = await inspectWorkspace({
    run,
    child,
    workspaceId,
    workspaceRoot,
    recordRoot,
  });
  const at = now();
  let next;
  if (resolution === 'safe_to_retry') {
    if (workspace.head !== child.input_sha) throw new Error('workflow_effect_retry_workspace_not_restored');
    next = validateWorkflowEffect({
      ...effect,
      state: 'failed',
      result_code: 'operator.safe_to_retry',
      output_sha: null,
      updated_at: at,
      resolution: {
        decision: 'safe_to_retry',
        previous_result_code: effect.result_code,
        workspace_head: workspace.head,
        resolved_at: at,
      },
    });
  } else {
    const outputSha = bounded(body?.output_sha, 40).toLowerCase();
    if (!SAFE_SHA.test(outputSha)) throw new Error('workflow_effect_output_sha_invalid');
    if (workspace.head !== outputSha) throw new Error('workflow_effect_completed_workspace_head_mismatch');
    const resultCode = completedResultCode({ child, body });
    next = validateWorkflowEffect({
      ...effect,
      state: 'completed',
      result_code: resultCode,
      output_sha: outputSha,
      updated_at: at,
      resolution: {
        decision: 'completed',
        previous_result_code: effect.result_code,
        workspace_head: workspace.head,
        resolved_at: at,
      },
    });
  }
  await writeAtomic(effectPath(effectsDir, effect.effect_id), next);
  return {
    effect: next,
    workspace: workspace.record,
    resolution,
    provider_invoked: false,
    uncertain_effect_replayed: false,
  };
}

async function mutateWorkspace({
  action,
  workflowRunsDir,
  effectsDir,
  workspaceRoot,
  recordRoot,
  workflowId,
  childId,
  workspaceId,
  expectedAttempt,
  body,
  now,
}: any) {
  const expectedState = expectedStateFrom(body);
  const { run, child } = await readExactContext({ workflowRunsDir, workflowId, childId, expectedAttempt });
  let record = validateWorkspaceBinding({
    record: await readWorkspaceRecord({ dir: recordRoot, workspaceId }),
    run,
    child,
    workspaceId,
  });
  if (record.state !== expectedState) throw new Error('workflow_workspace_state_conflict');

  if (action === 'workspace.hold') {
    if (record.state === 'held_for_investigation') {
      return { workspace: record, domain_idempotent: true, provider_invoked: false };
    }
    if (!['active', 'failed', 'cleanup_requested'].includes(record.state)) {
      throw new Error('workflow_workspace_hold_not_allowed');
    }
    record = await updateWorkspaceRecord({
      dir: recordRoot,
      workspaceId,
      patch: {
        state: 'held_for_investigation',
        hold_reason: bounded(body.reason, 300),
        hold_previous_state: record.state,
      },
      now,
    });
    return { workspace: record, domain_idempotent: false, provider_invoked: false };
  }

  if (action === 'workspace.release') {
    if (record.state !== 'held_for_investigation') throw new Error('workflow_workspace_not_held');
    const expectedHead = bounded(body?.expected_head_sha, 40).toLowerCase();
    if (!SAFE_SHA.test(expectedHead)) throw new Error('expected_head_sha_invalid');
    const expectedChildHead = child.state === 'completed' && child.output_sha ? child.output_sha : child.input_sha;
    if (expectedHead !== expectedChildHead) throw new Error('workflow_workspace_release_sha_not_authoritative');
    const inspected = await inspectWorkspace({
      run,
      child,
      workspaceId,
      workspaceRoot,
      recordRoot,
    });
    if (inspected.head !== expectedHead) throw new Error('workflow_workspace_release_head_mismatch');
    record = await updateWorkspaceRecord({
      dir: recordRoot,
      workspaceId,
      patch: {
        state: 'active',
        hold_reason: null,
        hold_previous_state: null,
        last_error: null,
      },
      now,
    });
    return { workspace: record, domain_idempotent: false, provider_invoked: false };
  }

  if (!CLEANUP_REQUEST_STATES.has(record.state)) throw new Error('workflow_workspace_cleanup_not_allowed');
  if (!TERMINAL_CHILD_STATES.has(child.state) && !TERMINAL_WORKFLOW_STATES.has(run.state)) {
    throw new Error('workflow_workspace_cleanup_target_not_terminal');
  }
  const effects = await listWorkflowEffects({
    dir: effectsDir,
    workflowId,
    childId,
    limit: 200,
  });
  const current = effects.find((effect: any) => (
    effect.effect_type === childEffectType(child)
    && effect.idempotency_key === attemptKey(child.attempt)
  ));
  if (current && ['claimed', 'needs_human'].includes(current.state)) {
    throw new Error('workflow_workspace_cleanup_effect_unresolved');
  }
  record = await updateWorkspaceRecord({
    dir: recordRoot,
    workspaceId,
    patch: {
      state: 'cleanup_requested',
      hold_reason: null,
      hold_previous_state: null,
    },
    now,
  });
  return { workspace: record, domain_idempotent: false, provider_invoked: false, cleanup_executed: false };
}

function publicResult(action: OperatorInvestigationAction, result: any) {
  if (action === 'effect.resolve') {
    return {
      operation: operationFor(action),
      resolution: result.resolution,
      effect: {
        effect_id: result.effect.effect_id,
        workflow_id: result.effect.workflow_id,
        child_id: result.effect.child_id,
        state: result.effect.state,
        result_code: result.effect.result_code,
        output_sha: result.effect.output_sha || null,
        updated_at: result.effect.updated_at,
      },
      workspace: {
        workspace_id: result.workspace.workspace_id,
        state: result.workspace.state,
        resolved_sha: result.workspace.resolved_sha || null,
      },
      provider_invoked: false,
      uncertain_effect_replayed: false,
    };
  }
  return {
    operation: operationFor(action),
    workspace: {
      workspace_id: result.workspace.workspace_id,
      state: result.workspace.state,
      hold_reason: result.workspace.hold_reason || null,
      resolved_sha: result.workspace.resolved_sha || null,
    },
    domain_idempotent: result.domain_idempotent === true,
    provider_invoked: false,
    cleanup_executed: result.cleanup_executed === true,
  };
}

function boundedFailure(error: any) {
  const code = bounded(error?.message || 'operator_investigation_failed', 120).toLowerCase();
  if (['workflow_child_not_found', 'workflow_effect_not_found', 'workspace_not_found'].includes(code)) {
    return { status: 404, code, message: code.replaceAll('_', ' ') };
  }
  if (code.startsWith('invalid_') || code.endsWith('_invalid') || code.endsWith('_required')) {
    return { status: 400, code, message: code.replaceAll('_', ' ') };
  }
  return { status: 409, code: SAFE_RESULT_CODE.test(code) ? code : 'operator_investigation_failed', message: code.replaceAll('_', ' ') };
}

async function appendRejected({
  auditDir,
  actor,
  operation,
  targetId,
  reason,
  idempotencyKey,
  failure,
  metadata,
}: any) {
  try {
    return await appendAuditEvent({
      dir: auditDir,
      operation,
      actor,
      target: { type: 'workflow_investigation', id: targetId.slice(0, 300) },
      reason,
      idempotencyKey,
      previousState: null,
      resultingState: null,
      outcome: 'rejected',
      errorCode: failure.code,
      metadata,
    });
  } catch {
    return null;
  }
}

export async function guardOperatorWorkflowRetryResolution({
  workflowRunsDir,
  effectsDir,
  workflowId,
  childId,
  expectedAttempt,
  actor,
  reason,
  idempotencyKey,
  auditDir,
}: any) {
  try {
    const { child } = await readExactContext({ workflowRunsDir, workflowId, childId, expectedAttempt });
    const effects = await listWorkflowEffects({ dir: effectsDir, workflowId, childId, limit: 200 });
    const matches = effects.filter((effect: any) => (
      effect.effect_type === childEffectType(child)
      && effect.idempotency_key === attemptKey(child.attempt)
    ));
    if (matches.length > 1) throw new Error('workflow_recovery_effect_ambiguous');
    const effect = matches[0] || null;
    if (effect?.state !== 'needs_human' && effect?.state !== 'claimed') return null;
    const failure = {
      status: 409,
      code: effect.state === 'claimed' ? 'workflow_retry_effect_not_terminal' : 'workflow_retry_effect_resolution_required',
      message: effect.state === 'claimed'
        ? 'workflow retry effect not terminal'
        : 'workflow retry effect resolution required',
    };
    const event = await appendRejected({
      auditDir,
      actor,
      operation: 'workflow.child.retry',
      targetId: `${workflowId}:${childId}`,
      reason,
      idempotencyKey,
      failure,
      metadata: { workflow_id: workflowId, child_id: childId, effect_id: effect.effect_id, effect_state: effect.state },
    });
    return {
      status: failure.status,
      body: {
        error: failure.message,
        error_code: failure.code,
        audit_event_id: event?.event_id || null,
      },
    };
  } catch (error: any) {
    const failure = boundedFailure(error);
    return { status: failure.status, body: { error: failure.message, error_code: failure.code } };
  }
}

export async function handleOperatorInvestigationAction({
  action,
  workflowId,
  childId,
  effectId = null,
  workspaceId = null,
  body,
  actor,
  workflowRunsDir,
  effectsDir,
  workspaceRoot,
  recordRoot,
  auditDir,
  idempotencyDir,
  now = () => new Date().toISOString(),
}: any) {
  const normalizedAction = String(action || '') as OperatorInvestigationAction;
  const normalizedWorkflowId = validateId(workflowId, 'workflow_id');
  const normalizedChildId = validateId(childId, 'workflow_child_id');
  const normalizedEffectId = effectId == null ? null : validateId(effectId, 'effect_id');
  const normalizedWorkspaceId = workspaceId == null ? null : validateId(workspaceId, 'workspace_id');
  const reason = reasonFrom(body);
  const expectedAttempt = expectedAttemptFrom(body);
  const idempotencyKey = validateIdempotencyKey(body?.idempotency_key);
  if (normalizedAction !== 'effect.resolve' && !WORKSPACE_ACTIONS.has(normalizedAction.replace('workspace.', ''))) {
    throw new Error('operator_investigation_action_invalid');
  }
  const operation = operationFor(normalizedAction);
  const targetId = normalizedEffectId || normalizedWorkspaceId || `${normalizedWorkflowId}:${normalizedChildId}`;
  const payload = {
    workflow_id: normalizedWorkflowId,
    child_id: normalizedChildId,
    effect_id: normalizedEffectId,
    workspace_id: normalizedWorkspaceId,
    expected_attempt: expectedAttempt,
    expected_state: body?.expected_state || null,
    expected_head_sha: body?.expected_head_sha || null,
    resolution: body?.resolution || null,
    output_sha: body?.output_sha || null,
    result_code: body?.result_code || null,
    reason,
  };

  try {
    const result = await executeIdempotent({
      dir: idempotencyDir,
      actorId: actorId(actor),
      operation,
      targetId,
      key: idempotencyKey,
      payload,
      execute: async () => withWorkspaceLock({
        dir: join(workflowRunsDir, '.advancement-locks'),
        name: `workflow-advance-${workflowDigest(normalizedWorkflowId)}`,
        staleAfterMs: DEFAULT_LOCK_STALE_AFTER_MS,
        execute: async () => {
          const domain = normalizedAction === 'effect.resolve'
            ? await resolveEffect({
                workflowRunsDir,
                effectsDir,
                workspaceRoot,
                recordRoot,
                workflowId: normalizedWorkflowId,
                childId: normalizedChildId,
                effectId: normalizedEffectId,
                expectedAttempt,
                body,
                now,
              })
            : await mutateWorkspace({
                action: normalizedAction,
                workflowRunsDir,
                effectsDir,
                workspaceRoot,
                recordRoot,
                workflowId: normalizedWorkflowId,
                childId: normalizedChildId,
                workspaceId: normalizedWorkspaceId,
                expectedAttempt,
                body,
                now,
              });
          const publicDomain = publicResult(normalizedAction, domain);
          const event = await appendAuditEvent({
            dir: auditDir,
            operation,
            actor,
            target: { type: normalizedAction === 'effect.resolve' ? 'workflow_effect' : 'workflow_workspace', id: targetId },
            reason,
            idempotencyKey,
            previousState: normalizedAction === 'effect.resolve' ? 'needs_human' : body?.expected_state || null,
            resultingState: normalizedAction === 'effect.resolve' ? domain.effect.state : domain.workspace.state,
            outcome: 'accepted',
            metadata: {
              workflow_id: normalizedWorkflowId,
              child_id: normalizedChildId,
              expected_attempt: expectedAttempt,
              effect_id: normalizedEffectId,
              workspace_id: normalizedWorkspaceId,
              provider_invoked: false,
              uncertain_effect_replayed: false,
              cleanup_executed: domain.cleanup_executed === true,
            },
          });
          return { ...publicDomain, audit_event_id: event.event_id };
        },
      }),
    });
    return { status: 200, body: { ...result.response, idempotent_replay: result.replayed } };
  } catch (error: any) {
    if (error instanceof IdempotencyConflictError) {
      return { status: 409, body: { error: error.message, error_code: 'idempotency_conflict' } };
    }
    if (error instanceof IdempotencyInProgressError) {
      return { status: 409, body: { error: error.message, error_code: 'idempotency_in_progress' } };
    }
    const failure = boundedFailure(error);
    const event = await appendRejected({
      auditDir,
      actor,
      operation,
      targetId,
      reason,
      idempotencyKey,
      failure,
      metadata: {
        workflow_id: normalizedWorkflowId,
        child_id: normalizedChildId,
        expected_attempt: expectedAttempt,
        effect_id: normalizedEffectId,
        workspace_id: normalizedWorkspaceId,
      },
    });
    return {
      status: failure.status,
      body: {
        error: failure.message,
        error_code: failure.code,
        audit_event_id: event?.event_id || null,
      },
    };
  }
}
