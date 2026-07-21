import { createHash } from 'node:crypto';

import {
  claimWorkflowEffect,
  completeWorkflowEffect,
} from './workflow-effect-store.js';
import { createWorkflowStageRunner } from './workflow-stage-runner.js';

const SAFE_SHA = /^[0-9a-f]{40}$/i;
const SAFE_REASON = /^[a-z0-9][a-z0-9._:-]{0,119}$/;
const REVIEW_DECISIONS = new Set(['approved', 'changes_requested']);
const MAX_STAGE_INSTRUCTION_LENGTH = 12_000;
const MAX_REVIEW_REASON_LENGTH = 80;
const DEFAULT_PROVIDER_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_PROVIDER_TERMINATION_GRACE_MS = 10_000;

function boundedText(value: unknown, max: number) {
  return String(value ?? '').trim().slice(0, max);
}

function boundedReason(value: unknown, fallback = 'workflow_provider_failed', max = 120) {
  const normalized = boundedText(value, max).toLowerCase();
  return SAFE_REASON.test(normalized) ? normalized : fallback;
}

function promptDigest(prompt: string) {
  return createHash('sha256').update(prompt).digest('hex');
}

function normalizeReviewDecision(value: unknown) {
  const normalized = boundedText(value, 40).toLowerCase();
  if (!REVIEW_DECISIONS.has(normalized)) throw new Error('workflow_review_decision_invalid');
  return normalized as 'approved' | 'changes_requested';
}

function normalizeReviewReason(value: unknown, decision: string) {
  if (decision === 'approved') return null;
  if (value == null || String(value).trim() === '') return 'workflow_review_changes_requested';
  return boundedReason(value, 'workflow_review_changes_requested', MAX_REVIEW_REASON_LENGTH);
}

function parseProviderObject(value: any) {
  let parsed = value;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text || text.length > 8_000) throw new Error('workflow_provider_output_invalid');
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('workflow_provider_output_invalid');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('workflow_provider_output_invalid');
  }
  return parsed;
}

export function parseReviewProviderResult(value: any) {
  const parsed = parseProviderObject(value);
  if (parsed.outcome === 'needs_human') {
    return {
      outcome: 'needs_human' as const,
      reason: boundedReason(parsed.reason, 'workflow_provider_needs_human'),
    };
  }
  if (parsed.outcome !== 'completed') throw new Error('workflow_provider_output_invalid');
  const outputSha = String(parsed.output_sha ?? '').trim().toLowerCase();
  if (!SAFE_SHA.test(outputSha)) throw new Error('workflow_provider_output_invalid');
  const decision = normalizeReviewDecision(parsed.review_decision ?? parsed.decision);
  const reason = normalizeReviewReason(parsed.review_reason ?? parsed.reason, decision);
  return {
    outcome: 'completed' as const,
    output_sha: outputSha,
    review_evidence: { decision, reason },
  };
}

export function encodeReviewEffectResultCode(evidence: any) {
  const decision = normalizeReviewDecision(evidence?.decision ?? evidence?.review_decision);
  const reason = normalizeReviewReason(evidence?.reason ?? evidence?.review_reason, decision);
  return decision === 'approved'
    ? 'review.approved'
    : `review.changes_requested:${reason}`;
}

export function decodeReviewEffectResultCode(value: unknown) {
  const normalized = boundedText(value, 120).toLowerCase();
  if (normalized === 'review.approved') {
    return { decision: 'approved' as const, reason: null };
  }
  const prefix = 'review.changes_requested:';
  if (!normalized.startsWith(prefix)) return null;
  const reason = normalized.slice(prefix.length);
  if (!reason || !SAFE_REASON.test(reason)) return null;
  return { decision: 'changes_requested' as const, reason };
}

export function renderReviewStagePrompt({ run, child, instruction }: any) {
  return [
    '# Ops Room Workflow Review Stage',
    '',
    `Workflow: ${run.workflow_id}`,
    `Repository: ${run.repository_id}`,
    `Child: ${child.child_id}`,
    'Stage: review',
    `Owner: ${child.owner_agent}`,
    `Iteration: ${child.iteration}`,
    `Attempt: ${child.attempt}`,
    `Input SHA: ${child.input_sha}`,
    '',
    '## Review instruction',
    instruction,
    '',
    '## Safety rules',
    '- Review only the exact immutable input SHA in the prepared detached workspace.',
    '- Do not modify files, create commits, change branches, push, merge, or post to GitHub.',
    '- Return the same input SHA when the review execution itself completed.',
    '- Never print or persist credentials, tokens, environment values, authenticated remotes, or host paths.',
    '- The Ops Room harness owns all external Git and GitHub effects.',
    '',
    '## Required result',
    'Return exactly one JSON object and no surrounding prose:',
    '{"outcome":"completed","output_sha":"<40-character input SHA>","review_decision":"approved"}',
    'or',
    '{"outcome":"completed","output_sha":"<40-character input SHA>","review_decision":"changes_requested","review_reason":"<bounded_reason_code>"}',
    'or',
    '{"outcome":"needs_human","reason":"<bounded_reason_code>"}',
  ].join('\n');
}

async function invokeWithDeadline({ invoke, timeoutMs, terminationGraceMs, signal }: any) {
  if (signal?.aborted) throw new Error('workflow_provider_cancelled');

  const controller = new AbortController();
  let timeout: NodeJS.Timeout | null = null;
  let terminationTimer: NodeJS.Timeout | null = null;
  let onAbort: (() => void) | null = null;

  const provider = Promise.resolve()
    .then(() => invoke(controller.signal))
    .then(
      (value) => ({ source: 'provider' as const, status: 'resolved' as const, value }),
      (error) => ({ source: 'provider' as const, status: 'rejected' as const, error }),
    );

  const interruption = new Promise<{ source: 'interruption'; reason: string }>((resolve) => {
    timeout = setTimeout(() => resolve({ source: 'interruption', reason: 'workflow_provider_timeout' }), timeoutMs);
    if (signal) {
      onAbort = () => resolve({ source: 'interruption', reason: 'workflow_provider_cancelled' });
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
  });

  const cleanup = () => {
    if (timeout) clearTimeout(timeout);
    if (terminationTimer) clearTimeout(terminationTimer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  };

  try {
    const first = await Promise.race([provider, interruption]);
    if (first.source === 'provider') {
      if (first.status === 'rejected') throw first.error;
      return first.value;
    }

    controller.abort(first.reason);
    const stopped = await Promise.race([
      provider,
      new Promise<{ source: 'termination_grace' }>((resolve) => {
        terminationTimer = setTimeout(() => resolve({ source: 'termination_grace' }), terminationGraceMs);
      }),
    ]);
    if (stopped.source === 'termination_grace') throw new Error('workflow_provider_termination_failed');
    throw new Error(first.reason);
  } finally {
    cleanup();
  }
}

function replayReviewEffect(effect: any) {
  if (effect.state === 'completed' && SAFE_SHA.test(String(effect.output_sha || ''))) {
    const reviewEvidence = decodeReviewEffectResultCode(effect.result_code);
    if (!reviewEvidence) {
      return { outcome: 'needs_human' as const, reason: 'workflow_review_effect_evidence_invalid' };
    }
    return {
      outcome: 'completed' as const,
      output_sha: String(effect.output_sha).toLowerCase(),
      review_evidence: reviewEvidence,
    };
  }
  if (effect.state === 'claimed') {
    return { outcome: 'needs_human' as const, reason: 'workflow_effect_interrupted' };
  }
  return {
    outcome: 'needs_human' as const,
    reason: boundedReason(effect.result_code, 'workflow_provider_failed'),
  };
}

export function createReviewAwareWorkflowStageRunner({
  effectsDir,
  providerAdapters,
  resolveStageInstruction,
  providerTimeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS,
  providerTerminationGraceMs = DEFAULT_PROVIDER_TERMINATION_GRACE_MS,
  signal = null,
  claimEffect = claimWorkflowEffect,
  completeEffect = completeWorkflowEffect,
}: any) {
  const baseRunner = createWorkflowStageRunner({
    effectsDir,
    providerAdapters,
    resolveStageInstruction,
    providerTimeoutMs,
    providerTerminationGraceMs,
    signal,
    claimEffect,
    completeEffect,
  });
  const boundedTimeoutMs = Math.max(1_000, Math.min(Number(providerTimeoutMs) || DEFAULT_PROVIDER_TIMEOUT_MS, 60 * 60 * 1000));
  const boundedTerminationGraceMs = Math.max(
    100,
    Math.min(Number(providerTerminationGraceMs) || DEFAULT_PROVIDER_TERMINATION_GRACE_MS, 60_000),
  );

  return async function runWorkflowStage(input: any) {
    const { run, child, workspace_path, workspace } = input;
    if (child?.stage !== 'review') return baseRunner(input);
    if (!effectsDir) throw new Error('workflow_effects_dir_required');
    if (!providerAdapters || typeof providerAdapters !== 'object') throw new Error('workflow_provider_adapters_required');
    if (typeof resolveStageInstruction !== 'function') throw new Error('workflow_stage_instruction_resolver_required');
    if (child.owner_agent !== 'berlin') throw new Error('workflow_provider_stage_owner_mismatch');
    if (workspace?.mode && workspace.mode !== 'detached') {
      throw new Error('workflow_provider_stage_workspace_mode_mismatch');
    }

    const adapter = providerAdapters.berlin;
    if (typeof adapter !== 'function') {
      return { outcome: 'needs_human', reason: 'workflow_provider_adapter_missing' };
    }
    const instruction = boundedText(
      await resolveStageInstruction({ run, child }),
      MAX_STAGE_INSTRUCTION_LENGTH,
    );
    if (!instruction) return { outcome: 'needs_human', reason: 'workflow_stage_instruction_missing' };

    const prompt = renderReviewStagePrompt({ run, child, instruction });
    const claim = await claimEffect({
      dir: effectsDir,
      workflowId: run.workflow_id,
      childId: child.child_id,
      effectType: 'provider.berlin.review',
      idempotencyKey: `attempt:${Math.max(0, Number(child.attempt) || 0)}`,
      payload: {
        repository_id: run.repository_id,
        child_id: child.child_id,
        stage: child.stage,
        owner_agent: child.owner_agent,
        iteration: child.iteration,
        attempt: child.attempt,
        input_sha: child.input_sha,
        workspace_id: workspace?.workspace_id || null,
        prompt_hash: promptDigest(prompt),
      },
    });
    if (!claim.execute) return replayReviewEffect(claim.effect);

    try {
      const providerResult = await invokeWithDeadline({
        timeoutMs: boundedTimeoutMs,
        terminationGraceMs: boundedTerminationGraceMs,
        signal,
        invoke: (providerSignal: AbortSignal) => adapter({
          prompt,
          cwd: workspace_path,
          signal: providerSignal,
          run,
          child,
        }),
      });
      const outcome = parseReviewProviderResult(providerResult);
      if (outcome.outcome === 'completed') {
        await completeEffect({
          dir: effectsDir,
          effectId: claim.effect.effect_id,
          state: 'completed',
          resultCode: encodeReviewEffectResultCode(outcome.review_evidence),
          outputSha: outcome.output_sha,
        });
        return outcome;
      }

      await completeEffect({
        dir: effectsDir,
        effectId: claim.effect.effect_id,
        state: 'needs_human',
        resultCode: outcome.reason,
      });
      return outcome;
    } catch (error: any) {
      const reason = boundedReason(error?.message, 'workflow_provider_failed');
      await completeEffect({
        dir: effectsDir,
        effectId: claim.effect.effect_id,
        state: 'needs_human',
        resultCode: reason,
      });
      return { outcome: 'needs_human', reason };
    }
  };
}
