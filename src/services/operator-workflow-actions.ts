import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { appendAuditEvent } from './audit-log.js';
import {
  executeIdempotent,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  validateIdempotencyKey,
} from './idempotency-store.js';
import {
  advanceWorkflowRun,
  persistReviewDecision,
  planWorkflowAdvancement,
} from './workflow-advancement.js';
import {
  resumePendingWorkflowAfterInvestigation,
  retryWorkflowChildAfterInvestigation,
} from './workflow-provider-recovery.js';
import {
  ensureWorkflowChild,
  readWorkflowRun,
  validateWorkflowRun,
} from './workflow-run-store.js';
import { writeAtomic } from './review-task-store.js';

const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const SAFE_ERROR_CODE = /^[a-z0-9][a-z0-9._:-]{0,119}$/;
const DECISIONS = new Set(['approved', 'changes_requested']);
const REVIEW_REACTIVATION_REASONS = new Set([
  'workflow_review_decision_missing',
  'workflow_review_decision_evidence_unavailable',
]);

export type OperatorWorkflowAction = 'retry' | 'resume' | 'decision';

function workflowFilename(workflowId: string) {
  return `workflow-${createHash('sha256').update(workflowId).digest('hex')}.json`;
}

function workflowPath(dir: string, workflowId: string) {
  return join(dir, workflowFilename(workflowId));
}

function reasonFrom(body: any) {
  const reason = String(body?.reason || '').trim();
  if (!reason || reason.length > 500) {
    throw new Error('reason is required and must not exceed 500 characters');
  }
  return reason;
}

function expectedAttemptFrom(body: any) {
  const attempt = Number(body?.expected_attempt);
  if (!Number.isInteger(attempt) || attempt < 0 || attempt > 100) {
    throw new Error('expected_attempt must be an integer between 0 and 100');
  }
  return attempt;
}

function decisionFrom(body: any) {
  const decision = String(body?.decision || '').trim().toLowerCase();
  if (!DECISIONS.has(decision)) {
    throw new Error('decision must be approved or changes_requested');
  }
  return decision as 'approved' | 'changes_requested';
}

function operationFor(action: OperatorWorkflowAction) {
  if (action === 'retry') return 'workflow.child.retry';
  if (action === 'resume') return 'workflow.child.resume';
  return 'workflow.approve';
}

function publicWorkflowResult(result: any) {
  const run = result?.run || {};
  const child = result?.child || null;
  const nextChild = result?.next_child || null;
  return {
    workflow: {
      workflow_id: String(run.workflow_id || ''),
      state: String(run.state || 'unknown'),
      current_iteration: Number(run.current_iteration || 0),
      last_error: run.last_error || null,
    },
    child: child
      ? {
          child_id: String(child.child_id || ''),
          stage: String(child.stage || ''),
          owner_agent: String(child.owner_agent || ''),
          iteration: Number(child.iteration || 0),
          attempt: Number(child.attempt || 0),
          state: String(child.state || 'unknown'),
          review_decision: child.review_decision || null,
        }
      : null,
    next_child: nextChild
      ? {
          child_id: String(nextChild.child_id || ''),
          stage: String(nextChild.stage || ''),
          owner_agent: String(nextChild.owner_agent || ''),
          iteration: Number(nextChild.iteration || 0),
          attempt: Number(nextChild.attempt || 0),
          state: String(nextChild.state || 'unknown'),
        }
      : null,
    provider_invoked: false,
    domain_idempotent: result?.idempotent === true,
  };
}

function boundedFailure(error: any) {
  const raw = String(error?.message || 'workflow_action_failed').trim().toLowerCase();
  const code = SAFE_ERROR_CODE.test(raw) ? raw : 'workflow_action_failed';
  if (error?.code === 'ENOENT' || code === 'workflow_run_not_found') {
    return { status: 404, code: 'workflow_not_found', message: 'Workflow not found' };
  }
  if (code === 'workflow_child_not_found') {
    return { status: 404, code, message: 'Workflow child not found' };
  }
  if (code === 'invalid_workflow_id' || code === 'invalid_workflow_child_id') {
    return { status: 400, code, message: 'Invalid Workflow target' };
  }
  return {
    status: 409,
    code,
    message: code.replaceAll('_', ' '),
  };
}

async function rejected({
  auditDir,
  actor,
  operation,
  workflowId,
  childId,
  reason,
  idempotencyKey,
  errorCode,
  status,
  message,
  previousState = null,
  metadata = {},
}: any) {
  const event = await appendAuditEvent({
    dir: auditDir,
    operation,
    actor,
    target: {
      type: 'workflow_child',
      id: `${String(workflowId || '').slice(0, 180)}:${String(childId || '').slice(0, 180)}`,
    },
    reason,
    idempotencyKey,
    previousState,
    resultingState: previousState,
    outcome: 'rejected',
    errorCode,
    metadata: {
      workflow_id: String(workflowId || '').slice(0, 200),
      child_id: String(childId || '').slice(0, 200),
      ...metadata,
    },
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

export async function reactivateWorkflowForReviewDecision({
  workflowRunsDir,
  workflowId,
  childId,
  expectedAttempt,
  readRun = readWorkflowRun,
  now = () => new Date().toISOString(),
}: any) {
  const run = await readRun({ dir: workflowRunsDir, workflowId });
  const child = run.children.find((candidate: any) => candidate.child_id === childId);
  if (!child) throw new Error('workflow_child_not_found');
  if (child.stage !== 'review') throw new Error('workflow_review_child_required');
  if (child.state !== 'completed') throw new Error('workflow_review_child_incomplete');
  if (child.attempt !== expectedAttempt) throw new Error('workflow_review_attempt_conflict');

  if (run.state === 'active') return { run, child, reactivated: false };
  if (
    run.state !== 'needs_human'
    || !REVIEW_REACTIVATION_REASONS.has(String(run.last_error || ''))
  ) {
    throw new Error('workflow_review_reactivation_forbidden');
  }

  const at = now();
  const updated = validateWorkflowRun({
    ...run,
    state: 'active',
    last_error: null,
    completed_at: null,
    updated_at: at,
    history: [
      ...(run.history || []),
      {
        event: 'workflow_review_operator_reactivated',
        child_id: childId,
        attempt: expectedAttempt,
        at,
      },
    ],
  });
  await writeAtomic(workflowPath(workflowRunsDir, workflowId), updated);
  return {
    run: updated,
    child: updated.children.find((candidate: any) => candidate.child_id === childId),
    reactivated: true,
  };
}

export async function applyOperatorReviewDecision({
  workflowRunsDir,
  workflowId,
  childId,
  expectedAttempt,
  decision,
  readRun = readWorkflowRun,
  reactivate = reactivateWorkflowForReviewDecision,
  persistDecision = persistReviewDecision,
  plan = planWorkflowAdvancement,
  ensureChild = ensureWorkflowChild,
  advance = advanceWorkflowRun,
  now = () => new Date().toISOString(),
}: any) {
  let run = await readRun({ dir: workflowRunsDir, workflowId });
  let child = run.children.find((candidate: any) => candidate.child_id === childId);
  if (!child) throw new Error('workflow_child_not_found');
  if (child.stage !== 'review') throw new Error('workflow_review_child_required');
  if (child.state !== 'completed') throw new Error('workflow_review_child_incomplete');
  if (child.attempt !== expectedAttempt) throw new Error('workflow_review_attempt_conflict');

  if (child.review_decision && child.review_decision !== decision) {
    throw new Error('workflow_review_decision_conflict');
  }

  const matchingNextChild = () => run.children.find((candidate: any) => (
    candidate.iteration === child.iteration + 1
    && candidate.stage === 'implementation'
    && candidate.input_sha === child.output_sha
  ));

  if (decision === 'approved' && child.review_decision === 'approved' && run.state === 'completed') {
    return { run, child, next_child: null, idempotent: true, provider_invoked: false };
  }
  if (decision === 'changes_requested' && child.review_decision === decision) {
    const existingNext = matchingNextChild();
    if (existingNext) {
      return { run, child, next_child: existingNext, idempotent: true, provider_invoked: false };
    }
    if (child.iteration >= run.policy.max_iterations && run.last_error === 'workflow_iteration_limit_exceeded') {
      return { run, child, next_child: null, idempotent: true, provider_invoked: false };
    }
  }

  if (run.state !== 'active') {
    const reactivated = await reactivate({
      workflowRunsDir,
      workflowId,
      childId,
      expectedAttempt,
      readRun,
      now,
    });
    run = reactivated.run;
    child = reactivated.child;
  }

  const persisted = await persistDecision({
    workflowRunsDir,
    workflowId,
    childId,
    evidence: {
      decision,
      reason: decision === 'changes_requested' ? 'operator_changes_requested' : null,
    },
    now,
  });
  run = persisted.run;
  child = persisted.child;

  const nextPlan = plan(run);
  if (decision === 'approved') {
    if (nextPlan.action !== 'complete') throw new Error('workflow_review_approval_plan_conflict');
    const advanced = await advance({
      workflowRunsDir,
      workflowId,
      executeChild: async () => {
        throw new Error('workflow_operator_provider_execution_forbidden');
      },
      maxSteps: 2,
      now,
    });
    if (advanced?.run?.state !== 'completed') throw new Error('workflow_review_approval_not_completed');
    const completedRun = await readRun({ dir: workflowRunsDir, workflowId });
    return {
      run: completedRun,
      child: completedRun.children.find((candidate: any) => candidate.child_id === childId),
      next_child: null,
      idempotent: persisted.idempotent === true,
      provider_invoked: false,
    };
  }

  if (child.iteration >= run.policy.max_iterations) {
    if (nextPlan.action !== 'escalate' || nextPlan.reason !== 'workflow_iteration_limit_exceeded') {
      throw new Error('workflow_review_iteration_limit_plan_conflict');
    }
    await advance({
      workflowRunsDir,
      workflowId,
      executeChild: async () => {
        throw new Error('workflow_operator_provider_execution_forbidden');
      },
      maxSteps: 2,
      now,
    });
    const escalatedRun = await readRun({ dir: workflowRunsDir, workflowId });
    return {
      run: escalatedRun,
      child: escalatedRun.children.find((candidate: any) => candidate.child_id === childId),
      next_child: null,
      idempotent: persisted.idempotent === true,
      provider_invoked: false,
    };
  }

  if (
    nextPlan.action !== 'create'
    || nextPlan.iteration !== child.iteration + 1
    || nextPlan.stage !== 'implementation'
    || nextPlan.input_sha !== child.output_sha
  ) {
    throw new Error('workflow_review_next_iteration_plan_conflict');
  }

  const ensured = await ensureChild({
    dir: workflowRunsDir,
    workflowId,
    iteration: nextPlan.iteration,
    stage: nextPlan.stage,
    inputSha: nextPlan.input_sha,
    now,
  });
  return {
    run: ensured.run,
    child: ensured.run.children.find((candidate: any) => candidate.child_id === childId),
    next_child: ensured.child,
    idempotent: persisted.idempotent === true && ensured.created === false,
    provider_invoked: false,
  };
}

export async function handleOperatorWorkflowAction({
  action,
  workflowId,
  childId,
  body,
  actor,
  workflowRunsDir,
  effectsDir,
  workspaceRoot,
  recordRoot,
  auditDir,
  idempotencyDir,
  retryChild = retryWorkflowChildAfterInvestigation,
  resumeChild = resumePendingWorkflowAfterInvestigation,
  applyDecision = applyOperatorReviewDecision,
}: any) {
  const normalizedAction = String(action || '') as OperatorWorkflowAction;
  const normalizedWorkflowId = String(workflowId || '').trim();
  const normalizedChildId = String(childId || '').trim();
  const operation = operationFor(normalizedAction);
  let reason = String(body?.reason || '').trim().slice(0, 500);
  let idempotencyKey = body?.idempotency_key ? String(body.idempotency_key).trim() : null;
  let expectedAttempt = Number(body?.expected_attempt);
  let decision: 'approved' | 'changes_requested' | null = null;

  try {
    if (!['retry', 'resume', 'decision'].includes(normalizedAction)) throw new Error('invalid_workflow_action');
    if (!SAFE_ID.test(normalizedWorkflowId)) throw new Error('invalid_workflow_id');
    if (!SAFE_ID.test(normalizedChildId)) throw new Error('invalid_workflow_child_id');
    reason = reasonFrom(body);
    idempotencyKey = validateIdempotencyKey(body?.idempotency_key);
    expectedAttempt = expectedAttemptFrom(body);
    if (normalizedAction === 'decision') decision = decisionFrom(body);
  } catch (error: any) {
    return rejected({
      auditDir,
      actor,
      operation,
      workflowId: normalizedWorkflowId,
      childId: normalizedChildId,
      reason,
      idempotencyKey,
      errorCode: 'invalid_request',
      status: 400,
      message: error?.message || 'Invalid Workflow action request',
      metadata: { expected_attempt: Number.isFinite(expectedAttempt) ? expectedAttempt : null },
    });
  }

  try {
    const result = await executeIdempotent({
      dir: idempotencyDir,
      actorId: actor.actor_id,
      operation,
      targetId: `${normalizedWorkflowId}:${normalizedChildId}`,
      key: idempotencyKey,
      payload: {
        reason,
        expected_attempt: expectedAttempt,
        decision,
      },
      execute: async () => {
        let current: any = null;
        try {
          const run = await readWorkflowRun({ dir: workflowRunsDir, workflowId: normalizedWorkflowId });
          current = run.children.find((candidate: any) => candidate.child_id === normalizedChildId) || null;
          if (!current) throw new Error('workflow_child_not_found');

          let actionResult: any;
          if (normalizedAction === 'retry') {
            actionResult = await retryChild({
              workflowRunsDir,
              workflowId: normalizedWorkflowId,
              childId: normalizedChildId,
              expectedAttempt,
              effectsDir,
              workspaceRoot,
              recordRoot,
            });
          } else if (normalizedAction === 'resume') {
            actionResult = await resumeChild({
              workflowRunsDir,
              workflowId: normalizedWorkflowId,
              childId: normalizedChildId,
              expectedAttempt,
              effectsDir,
              workspaceRoot,
              recordRoot,
            });
          } else {
            actionResult = await applyDecision({
              workflowRunsDir,
              workflowId: normalizedWorkflowId,
              childId: normalizedChildId,
              expectedAttempt,
              decision,
            });
          }

          const publicResult = publicWorkflowResult(actionResult);
          const event = await appendAuditEvent({
            dir: auditDir,
            operation,
            actor,
            target: {
              type: 'workflow_child',
              id: `${normalizedWorkflowId}:${normalizedChildId}`,
            },
            reason,
            idempotencyKey,
            previousState: current.state,
            resultingState: publicResult.workflow.state,
            outcome: 'accepted',
            metadata: {
              workflow_id: normalizedWorkflowId,
              child_id: normalizedChildId,
              stage: current.stage,
              owner_agent: current.owner_agent,
              expected_attempt: expectedAttempt,
              resulting_attempt: publicResult.child?.attempt ?? expectedAttempt,
              decision,
              next_child_id: publicResult.next_child?.child_id || null,
              provider_invoked: false,
              uncertain_effect_replayed: false,
            },
          });
          return {
            status: 202,
            body: {
              operation,
              ...publicResult,
              audit_event_id: event.event_id,
            },
          };
        } catch (error: any) {
          const failure = boundedFailure(error);
          return rejected({
            auditDir,
            actor,
            operation,
            workflowId: normalizedWorkflowId,
            childId: normalizedChildId,
            reason,
            idempotencyKey,
            errorCode: failure.code,
            status: failure.status,
            message: failure.message,
            previousState: current?.state || null,
            metadata: {
              expected_attempt: expectedAttempt,
              decision,
            },
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
      return rejected({
        auditDir,
        actor,
        operation,
        workflowId: normalizedWorkflowId,
        childId: normalizedChildId,
        reason,
        idempotencyKey,
        errorCode: error.code,
        status: 409,
        message: error.message,
        metadata: {
          expected_attempt: expectedAttempt,
          decision,
        },
      });
    }
    throw error;
  }
}
