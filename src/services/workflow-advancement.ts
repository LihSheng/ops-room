import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { writeAtomic } from './review-task-store.js';
import {
  FEATURE_DEVELOPMENT_STAGES,
  ensureWorkflowChild,
  readWorkflowRun,
  validateWorkflowRun,
} from './workflow-run-store.js';
import { withWorkspaceLock } from './workspace-locks.js';

const SAFE_REASON = /^[a-z0-9][a-z0-9._:-]{0,119}$/;
const SAFE_SHA = /^[0-9a-f]{40}$/i;
const REVIEW_DECISIONS = new Set(['approved', 'changes_requested']);
const TERMINAL_RUN_STATES = new Set(['completed', 'needs_human', 'cancelled']);
const DEFAULT_ADVANCEMENT_LOCK_STALE_AFTER_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_STEPS = 200;

function workflowFilename(workflowId: string) {
  return `workflow-${createHash('sha256').update(workflowId).digest('hex')}.json`;
}

function workflowPath(dir: string, workflowId: string) {
  return join(dir, workflowFilename(workflowId));
}

function workflowDigest(value: string, length = 32) {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function boundedReason(value: unknown, fallback = 'workflow_advancement_failed') {
  const normalized = String(value || '').trim().toLowerCase();
  return SAFE_REASON.test(normalized) ? normalized : fallback;
}

function normalizeReviewDecision(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!REVIEW_DECISIONS.has(normalized)) throw new Error('workflow_review_decision_invalid');
  return normalized as 'approved' | 'changes_requested';
}

function normalizeReviewEvidence(value: any) {
  if (typeof value === 'string') {
    return { decision: normalizeReviewDecision(value), reason: null };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('workflow_review_decision_missing');
  }
  return {
    decision: normalizeReviewDecision(value.decision || value.review_decision),
    reason: value.reason == null ? null : boundedReason(value.reason, 'workflow_review_changes_requested'),
  };
}

function childOrder(child: any) {
  const stageIndex = FEATURE_DEVELOPMENT_STAGES.indexOf(child.stage);
  return (Number(child.iteration) * 10) + Math.max(0, stageIndex);
}

function orderedChildren(run: any) {
  return [...run.children].sort((left, right) => childOrder(left) - childOrder(right));
}

function publicResult(run: any, action: string, steps: number, child: any = null) {
  return {
    action,
    steps,
    run: {
      workflow_id: run.workflow_id,
      state: run.state,
      current_iteration: run.current_iteration,
      last_error: run.last_error || null,
      completed_at: run.completed_at || null,
    },
    child: child
      ? {
          child_id: child.child_id,
          stage: child.stage,
          iteration: child.iteration,
          state: child.state,
          input_sha: child.input_sha,
          output_sha: child.output_sha || null,
          review_decision: child.review_decision || null,
        }
      : null,
  };
}

export function planWorkflowAdvancement(record: any) {
  const run = validateWorkflowRun(record);
  if (TERMINAL_RUN_STATES.has(run.state)) {
    return { action: 'terminal' as const, run };
  }

  const children = orderedChildren(run);
  const blockedChild = children.find((child) => child.state === 'needs_human' || child.state === 'failed');
  if (blockedChild) {
    return {
      action: 'escalate' as const,
      reason: boundedReason(blockedChild.last_error, 'workflow_child_needs_human'),
      child: blockedChild,
    };
  }

  const activeChildren = children.filter((child) => child.state === 'active');
  if (activeChildren.length > 1) {
    return { action: 'escalate' as const, reason: 'workflow_active_children_ambiguous' };
  }
  if (activeChildren.length === 1) {
    return { action: 'wait' as const, reason: 'workflow_child_active', child: activeChildren[0] };
  }

  const pendingChildren = children.filter((child) => child.state === 'pending');
  if (pendingChildren.length > 1) {
    return { action: 'escalate' as const, reason: 'workflow_pending_children_ambiguous' };
  }
  if (pendingChildren.length === 1) {
    return { action: 'execute' as const, child: pendingChildren[0] };
  }

  if (children.length === 0) {
    return {
      action: 'create' as const,
      iteration: 1,
      stage: 'implementation',
      input_sha: run.source_sha,
    };
  }

  const lastChild = children[children.length - 1];
  if (lastChild.state !== 'completed' || !SAFE_SHA.test(String(lastChild.output_sha || ''))) {
    return { action: 'escalate' as const, reason: 'workflow_completed_child_evidence_invalid', child: lastChild };
  }

  const stageIndex = FEATURE_DEVELOPMENT_STAGES.indexOf(lastChild.stage);
  if (stageIndex < 0) {
    return { action: 'escalate' as const, reason: 'workflow_stage_invalid', child: lastChild };
  }

  if (lastChild.stage !== 'review') {
    return {
      action: 'create' as const,
      iteration: lastChild.iteration,
      stage: FEATURE_DEVELOPMENT_STAGES[stageIndex + 1],
      input_sha: lastChild.output_sha,
    };
  }

  let decision;
  try {
    decision = normalizeReviewDecision(lastChild.review_decision);
  } catch {
    return { action: 'escalate' as const, reason: 'workflow_review_decision_missing', child: lastChild };
  }

  if (decision === 'approved') {
    return { action: 'complete' as const, child: lastChild };
  }

  if (lastChild.iteration >= run.policy.max_iterations) {
    return { action: 'escalate' as const, reason: 'workflow_iteration_limit_exceeded', child: lastChild };
  }

  return {
    action: 'create' as const,
    iteration: lastChild.iteration + 1,
    stage: 'implementation',
    input_sha: lastChild.output_sha,
  };
}

async function persistReviewDecision({
  workflowRunsDir,
  workflowId,
  childId,
  evidence,
  now,
}: any) {
  const run = await readWorkflowRun({ dir: workflowRunsDir, workflowId });
  const index = run.children.findIndex((child: any) => child.child_id === childId);
  if (index < 0) throw new Error('workflow_child_not_found');
  const current = run.children[index];
  if (current.stage !== 'review') throw new Error('workflow_review_child_required');
  if (current.state !== 'completed') throw new Error('workflow_review_child_incomplete');

  const normalized = normalizeReviewEvidence(evidence);
  if (current.review_decision) {
    if (
      current.review_decision !== normalized.decision
      || (current.review_reason || null) !== normalized.reason
    ) {
      throw new Error('workflow_review_decision_conflict');
    }
    return { run, child: current, idempotent: true };
  }

  const at = now();
  const child = {
    ...current,
    review_decision: normalized.decision,
    review_reason: normalized.reason,
    updated_at: at,
    history: [
      ...(current.history || []),
      {
        event: 'review_decision_recorded',
        decision: normalized.decision,
        reason: normalized.reason,
        at,
      },
    ],
  };
  const children = [...run.children];
  children[index] = child;
  const updated = validateWorkflowRun({
    ...run,
    updated_at: at,
    children,
    history: [
      ...(run.history || []),
      {
        event: 'workflow_review_decision_recorded',
        child_id: childId,
        decision: normalized.decision,
        reason: normalized.reason,
        at,
      },
    ],
  });
  await writeAtomic(workflowPath(workflowRunsDir, workflowId), updated);
  return { run: updated, child, idempotent: false };
}

async function persistTerminalRun({ workflowRunsDir, workflowId, state, reason, now }: any) {
  const run = await readWorkflowRun({ dir: workflowRunsDir, workflowId });
  const normalizedState = state === 'completed' ? 'completed' : 'needs_human';
  const normalizedReason = normalizedState === 'completed'
    ? null
    : boundedReason(reason, 'workflow_advancement_failed');

  if (run.state === normalizedState) {
    if (normalizedState === 'completed' || run.last_error === normalizedReason) {
      return { run, idempotent: true };
    }
    throw new Error('workflow_terminal_state_conflict');
  }
  if (TERMINAL_RUN_STATES.has(run.state)) throw new Error('workflow_terminal_state_immutable');

  const at = now();
  const updated = validateWorkflowRun({
    ...run,
    state: normalizedState,
    updated_at: at,
    completed_at: normalizedState === 'completed' ? at : null,
    last_error: normalizedReason,
    history: [
      ...(run.history || []),
      normalizedState === 'completed'
        ? { event: 'workflow_completed', at }
        : { event: 'workflow_needs_human', reason: normalizedReason, at },
    ],
  });
  await writeAtomic(workflowPath(workflowRunsDir, workflowId), updated);
  return { run: updated, idempotent: false };
}

export async function advanceWorkflowRun({
  workflowRunsDir,
  workflowId,
  executeChild,
  resolveReviewDecision = null,
  ensureChild = ensureWorkflowChild,
  readRun = readWorkflowRun,
  maxSteps = DEFAULT_MAX_STEPS,
  advancementLockDir = join(workflowRunsDir, '.advancement-locks'),
  advancementLockTimeoutMs = 10_000,
  advancementLockStaleAfterMs = DEFAULT_ADVANCEMENT_LOCK_STALE_AFTER_MS,
  now = () => new Date().toISOString(),
}: any) {
  if (!workflowRunsDir || !workflowId) throw new Error('workflow_advancement_input_invalid');
  if (typeof executeChild !== 'function') throw new Error('workflow_advancement_executor_required');
  const boundedMaxSteps = Math.max(1, Math.min(Number(maxSteps) || DEFAULT_MAX_STEPS, 500));

  return withWorkspaceLock({
    dir: advancementLockDir,
    name: `workflow-advance-${workflowDigest(workflowId)}`,
    timeoutMs: advancementLockTimeoutMs,
    staleAfterMs: advancementLockStaleAfterMs,
    execute: async () => {
      for (let step = 1; step <= boundedMaxSteps; step += 1) {
        const run = await readRun({ dir: workflowRunsDir, workflowId });
        const plan = planWorkflowAdvancement(run);

        if (plan.action === 'terminal') {
          return publicResult(plan.run, 'terminal', step - 1);
        }
        if (plan.action === 'wait') {
          return publicResult(run, 'waiting', step - 1, plan.child);
        }
        if (plan.action === 'escalate') {
          const terminal = await persistTerminalRun({
            workflowRunsDir,
            workflowId,
            state: 'needs_human',
            reason: plan.reason,
            now,
          });
          return publicResult(terminal.run, 'needs_human', step, plan.child || null);
        }
        if (plan.action === 'complete') {
          const terminal = await persistTerminalRun({
            workflowRunsDir,
            workflowId,
            state: 'completed',
            now,
          });
          return publicResult(terminal.run, 'completed', step, plan.child);
        }
        if (plan.action === 'create') {
          await ensureChild({
            dir: workflowRunsDir,
            workflowId,
            iteration: plan.iteration,
            stage: plan.stage,
            inputSha: plan.input_sha,
            now,
          });
          continue;
        }

        let executionResult;
        try {
          executionResult = await executeChild({
            workflowRunsDir,
            workflowId,
            childId: plan.child.child_id,
          });
        } catch (error: any) {
          const terminal = await persistTerminalRun({
            workflowRunsDir,
            workflowId,
            state: 'needs_human',
            reason: boundedReason(error?.message, 'workflow_advancement_execution_failed'),
            now,
          });
          return publicResult(terminal.run, 'needs_human', step, plan.child);
        }

        if (plan.child.stage === 'review') {
          const refreshed = await readRun({ dir: workflowRunsDir, workflowId });
          const reviewChild = refreshed.children.find((child: any) => child.child_id === plan.child.child_id);
          if (reviewChild?.state === 'completed' && !reviewChild.review_decision) {
            let evidence = executionResult?.review_evidence
              || executionResult?.stage_result?.review_evidence
              || executionResult?.review_decision
              || executionResult?.stage_result?.review_decision;
            if (evidence == null && typeof resolveReviewDecision === 'function') {
              evidence = await resolveReviewDecision({
                run: refreshed,
                child: reviewChild,
                execution_result: executionResult,
              });
            }
            if (evidence != null) {
              await persistReviewDecision({
                workflowRunsDir,
                workflowId,
                childId: reviewChild.child_id,
                evidence,
                now,
              });
            }
          }
        }
      }

      const terminal = await persistTerminalRun({
        workflowRunsDir,
        workflowId,
        state: 'needs_human',
        reason: 'workflow_advancement_step_limit',
        now,
      });
      return publicResult(terminal.run, 'needs_human', boundedMaxSteps);
    },
  });
}

export { REVIEW_DECISIONS, normalizeReviewEvidence, persistReviewDecision };
