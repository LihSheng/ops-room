import { createHash } from 'node:crypto';
import { join } from 'node:path';

import {
  advanceWorkflowRun,
  persistReviewDecision,
} from './workflow-advancement.js';
import { executeWorkflowChild } from './workflow-child-execution.js';
import { listWorkflowEffects } from './workflow-effect-store.js';
import { createProfileWorkflowProviderAdapters } from './workflow-provider-adapters.js';
import {
  createReviewAwareWorkflowStageRunner,
  decodeReviewEffectResultCode,
} from './workflow-review-stage-runner.js';
import { readWorkflowRun } from './workflow-run-store.js';
import { withWorkspaceLock } from './workspace-locks.js';

const SAFE_SHA = /^[0-9a-f]{40}$/i;
const DEFAULT_REVIEW_RECONCILIATION_LOCK_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

function workflowDigest(value: string, length = 32) {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function latestUnresolvedCompletedReview(run: any) {
  return [...run.children]
    .filter((child) => child.stage === 'review' && child.state === 'completed' && !child.review_decision)
    .sort((left, right) => Number(right.iteration) - Number(left.iteration))[0] || null;
}

export async function resolveReviewDecisionFromEffects({ effectsDir, workflowId, child }: any) {
  if (!effectsDir || !workflowId || !child?.child_id) return null;
  const effects = await listWorkflowEffects({
    dir: effectsDir,
    workflowId,
    childId: child.child_id,
    limit: 20,
  });
  const expectedAttempt = `attempt:${Math.max(0, Number(child.attempt) || 0)}`;
  const matches = effects.filter((effect: any) => (
    effect.effect_type === 'provider.berlin.review'
    && effect.idempotency_key === expectedAttempt
  ));
  if (matches.length !== 1) return null;
  const effect = matches[0];
  if (
    effect.state !== 'completed'
    || !SAFE_SHA.test(String(effect.output_sha || ''))
    || String(effect.output_sha).toLowerCase() !== String(child.output_sha || '').toLowerCase()
  ) {
    return null;
  }
  return decodeReviewEffectResultCode(effect.result_code);
}

export async function reconcileReviewDecisionFromEffects({
  workflowRunsDir,
  workflowId,
  effectsDir,
  readRun = readWorkflowRun,
  persistDecision = persistReviewDecision,
  lockDir = join(workflowRunsDir, '.review-decision-locks'),
  lockTimeoutMs = 10_000,
  lockStaleAfterMs = DEFAULT_REVIEW_RECONCILIATION_LOCK_STALE_AFTER_MS,
  now = () => new Date().toISOString(),
}: any) {
  return withWorkspaceLock({
    dir: lockDir,
    name: `workflow-review-decision-${workflowDigest(workflowId)}`,
    timeoutMs: lockTimeoutMs,
    staleAfterMs: lockStaleAfterMs,
    execute: async () => {
      const run = await readRun({ dir: workflowRunsDir, workflowId });
      const child = latestUnresolvedCompletedReview(run);
      if (!child) return { reconciled: false, reason: 'workflow_review_decision_not_pending' };
      const evidence = await resolveReviewDecisionFromEffects({ effectsDir, workflowId, child });
      if (!evidence) return { reconciled: false, reason: 'workflow_review_decision_evidence_unavailable', child };
      const persisted = await persistDecision({
        workflowRunsDir,
        workflowId,
        childId: child.child_id,
        evidence,
        now,
      });
      return { reconciled: true, child: persisted.child, idempotent: persisted.idempotent };
    },
  });
}

export async function advanceWorkflowRunWithProviders({
  workflowRunsDir,
  workflowId,
  effectsDir,
  resolveStageInstruction,
  providerAdapters = createProfileWorkflowProviderAdapters(),
  providerTimeoutMs,
  providerTerminationGraceMs,
  signal,
  childExecutionOptions = {},
  advancementOptions = {},
  executeWorkflowChildFn = executeWorkflowChild,
  advanceWorkflowRunFn = advanceWorkflowRun,
}: any) {
  if (!workflowRunsDir || !workflowId || !effectsDir) throw new Error('workflow_provider_advancement_input_invalid');
  if (typeof resolveStageInstruction !== 'function') {
    throw new Error('workflow_stage_instruction_resolver_required');
  }

  await reconcileReviewDecisionFromEffects({
    workflowRunsDir,
    workflowId,
    effectsDir,
  });

  const runStage = createReviewAwareWorkflowStageRunner({
    effectsDir,
    providerAdapters,
    resolveStageInstruction,
    providerTimeoutMs,
    providerTerminationGraceMs,
    signal,
  });

  return advanceWorkflowRunFn({
    ...advancementOptions,
    workflowRunsDir,
    workflowId,
    executeChild: ({ childId }: any) => executeWorkflowChildFn({
      ...childExecutionOptions,
      workflowRunsDir,
      workflowId,
      childId,
      runStage,
    }),
    resolveReviewDecision: ({ child }: any) => resolveReviewDecisionFromEffects({
      effectsDir,
      workflowId,
      child,
    }),
  });
}
