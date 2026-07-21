import { createHash } from 'node:crypto';

import {
  claimWorkflowEffect,
  completeWorkflowEffect,
} from './workflow-effect-store.js';

const SAFE_SHA = /^[0-9a-f]{40}$/i;
const SAFE_REASON = /^[a-z0-9][a-z0-9._:-]{0,119}$/;
const MAX_STAGE_INSTRUCTION_LENGTH = 12_000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 30 * 60 * 1000;

const STAGE_AUTHORITY = Object.freeze({
  implementation: Object.freeze({ owner_agent: 'professor', workspace_mode: 'branch' }),
  test: Object.freeze({ owner_agent: 'tokyo', workspace_mode: 'branch' }),
  integration: Object.freeze({ owner_agent: 'professor', workspace_mode: 'branch' }),
  review: Object.freeze({ owner_agent: 'berlin', workspace_mode: 'detached' }),
});

function boundedText(value: unknown, max: number) {
  return String(value ?? '').trim().slice(0, max);
}

function boundedReason(value: unknown, fallback = 'workflow_provider_failed') {
  const normalized = boundedText(value, 120).toLowerCase();
  return SAFE_REASON.test(normalized) ? normalized : fallback;
}

function stageAuthority(child: any) {
  const authority = STAGE_AUTHORITY[child?.stage as keyof typeof STAGE_AUTHORITY];
  if (!authority) throw new Error('workflow_provider_stage_invalid');
  if (child.owner_agent !== authority.owner_agent) {
    throw new Error('workflow_provider_stage_owner_mismatch');
  }
  if (child?.workspace?.mode && child.workspace.mode !== authority.workspace_mode) {
    throw new Error('workflow_provider_stage_workspace_mode_mismatch');
  }
  return authority;
}

function promptDigest(prompt: string) {
  return createHash('sha256').update(prompt).digest('hex');
}

function renderStagePrompt({ run, child, instruction }: any) {
  const stageRules = child.stage === 'review'
    ? [
        'Review the exact immutable input SHA in the prepared detached workspace.',
        'Do not modify files, create commits, change branches, push, merge, or post to GitHub.',
        'Return the same input SHA when the review execution itself completed.',
      ]
    : [
        'Work only inside the prepared workspace and existing branch.',
        'Do not create, switch, delete, push, merge, or rebase branches.',
        'Do not post comments, statuses, reviews, or pull requests to GitHub.',
        'Run relevant checks and leave the workspace HEAD at the completed output commit.',
      ];

  return [
    '# Ops Room Workflow Stage',
    '',
    `Workflow: ${run.workflow_id}`,
    `Repository: ${run.repository_id}`,
    `Child: ${child.child_id}`,
    `Stage: ${child.stage}`,
    `Owner: ${child.owner_agent}`,
    `Iteration: ${child.iteration}`,
    `Attempt: ${child.attempt}`,
    `Input SHA: ${child.input_sha}`,
    '',
    '## Stage instruction',
    instruction,
    '',
    '## Safety rules',
    ...stageRules.map((rule) => `- ${rule}`),
    '- Never print or persist credentials, tokens, environment values, authenticated remotes, or host paths.',
    '- The Ops Room harness owns all external Git and GitHub effects.',
    '',
    '## Required result',
    'Return exactly one JSON object and no surrounding prose:',
    '{"outcome":"completed","output_sha":"<40-character commit SHA>"}',
    'or',
    '{"outcome":"needs_human","reason":"<bounded_reason_code>"}',
  ].join('\n');
}

function parseProviderResult(value: any) {
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
  if (parsed.outcome === 'needs_human') {
    return {
      outcome: 'needs_human' as const,
      reason: boundedReason(parsed.reason, 'workflow_provider_needs_human'),
    };
  }
  if (parsed.outcome !== 'completed') throw new Error('workflow_provider_output_invalid');
  const outputSha = boundedText(parsed.output_sha, 40).toLowerCase();
  if (!SAFE_SHA.test(outputSha)) throw new Error('workflow_provider_output_invalid');
  return { outcome: 'completed' as const, output_sha: outputSha };
}

function replayEffect(effect: any) {
  if (effect.state === 'completed' && SAFE_SHA.test(String(effect.output_sha || ''))) {
    return { outcome: 'completed' as const, output_sha: String(effect.output_sha).toLowerCase() };
  }
  if (effect.state === 'claimed') {
    return { outcome: 'needs_human' as const, reason: 'workflow_effect_interrupted' };
  }
  return {
    outcome: 'needs_human' as const,
    reason: boundedReason(effect.result_code, 'workflow_provider_failed'),
  };
}

async function invokeWithDeadline({ invoke, timeoutMs, signal }: any) {
  if (signal?.aborted) throw new Error('workflow_provider_cancelled');

  const controller = new AbortController();
  let timeout: NodeJS.Timeout | null = null;
  let onAbort: (() => void) | null = null;

  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort('timeout');
      reject(new Error('workflow_provider_timeout'));
    }, timeoutMs);

    if (signal) {
      onAbort = () => {
        controller.abort('cancelled');
        reject(new Error('workflow_provider_cancelled'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => invoke(controller.signal)),
      deadline,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

export function createWorkflowStageRunner({
  effectsDir,
  providerAdapters,
  resolveStageInstruction,
  providerTimeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS,
  signal = null,
  claimEffect = claimWorkflowEffect,
  completeEffect = completeWorkflowEffect,
}: any) {
  if (!effectsDir) throw new Error('workflow_effects_dir_required');
  if (!providerAdapters || typeof providerAdapters !== 'object') {
    throw new Error('workflow_provider_adapters_required');
  }
  if (typeof resolveStageInstruction !== 'function') {
    throw new Error('workflow_stage_instruction_resolver_required');
  }
  const boundedTimeoutMs = Math.max(1_000, Math.min(Number(providerTimeoutMs) || DEFAULT_PROVIDER_TIMEOUT_MS, 60 * 60 * 1000));

  return async function runWorkflowStage({ run, child, workspace_path, workspace }: any) {
    const authority = stageAuthority({ ...child, workspace });
    const adapter = providerAdapters[authority.owner_agent];
    if (typeof adapter !== 'function') {
      return { outcome: 'needs_human', reason: 'workflow_provider_adapter_missing' };
    }

    const instruction = boundedText(
      await resolveStageInstruction({ run, child }),
      MAX_STAGE_INSTRUCTION_LENGTH,
    );
    if (!instruction) {
      return { outcome: 'needs_human', reason: 'workflow_stage_instruction_missing' };
    }
    const prompt = renderStagePrompt({ run, child, instruction });
    const effectType = `provider.${authority.owner_agent}.${child.stage}`;
    const idempotencyKey = `attempt:${Math.max(0, Number(child.attempt) || 0)}`;
    const claim = await claimEffect({
      dir: effectsDir,
      workflowId: run.workflow_id,
      childId: child.child_id,
      effectType,
      idempotencyKey,
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

    if (!claim.execute) return replayEffect(claim.effect);

    try {
      const providerResult = await invokeWithDeadline({
        timeoutMs: boundedTimeoutMs,
        signal,
        invoke: (providerSignal: AbortSignal) => adapter({
          prompt,
          cwd: workspace_path,
          signal: providerSignal,
          run,
          child,
        }),
      });
      const outcome = parseProviderResult(providerResult);

      if (outcome.outcome === 'completed') {
        await completeEffect({
          dir: effectsDir,
          effectId: claim.effect.effect_id,
          state: 'completed',
          resultCode: 'ok',
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

export { STAGE_AUTHORITY, parseProviderResult, renderStagePrompt };
